// A chat turn on a board kept in a Superset dashboard: the edits the reviewer checks are held
// back from Superset, so a change found misleading and not fixed never reaches the dashboard, and
// one that was fixed reaches it only in its corrected form.
import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BoardConfig, memoryStore } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/pack";
import { type Host, type Provider, buildProvider, createApp, registerLlmAdapter } from "@lenspack/serve";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SupersetClient } from "../src/client";
import { supersetConnector } from "../src/connector";
import { type SupersetDataset, packFromDatasets } from "../src/index";
import { supersetBoards } from "../src/store";

// A made-up dataset: stock moves between facilities.
const DATASETS: SupersetDataset[] = [
  {
    id: 3,
    table_name: "stock_moves",
    main_dttm_col: "moved_at",
    columns: [
      { column_name: "moved_at", is_dttm: true, type: "DATE" },
      { column_name: "facility_level", groupby: true, type: "TEXT" },
    ],
    metrics: [{ metric_name: "quantity", expression: "SUM(quantity)" }],
  },
];
const { pack, packYaml, binding } = packFromDatasets(DATASETS, { pack: "stock", entities: { "3": "move" } });

/** Just enough of Superset's dashboard and chart API, recording every write. */
function fakeSuperset() {
  const writes: string[] = [];
  let changed = 0;
  let chartId = 100;
  let dash = { id: 7, dashboard_title: "Stock", position_json: null as string | null, json_metadata: null as string | null, changed_on: "t0" };
  const client: SupersetClient = {
    url: "http://superset.test",
    async get(path): Promise<any> {
      if (path === "/api/v1/dashboard/7") return { result: dash };
      if (path === "/api/v1/dashboard/7/charts") return { result: [] };
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path): Promise<any> {
      writes.push(`POST ${path}`);
      return { id: chartId++ };
    },
    async put(path, body): Promise<any> {
      writes.push(`PUT ${path}`);
      if (path === "/api/v1/dashboard/7") dash = { ...dash, ...(body as object), changed_on: `t${++changed}` };
      return {};
    },
    async delete(path): Promise<any> {
      writes.push(`DELETE ${path}`);
      return {};
    },
  };
  return { client, writes };
}

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stream = (parts: unknown[]) => ({
  stream: new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  }),
});
const tool = (toolName: string, input: unknown) => [
  { type: "tool-call", toolCallId: `c${Math.random().toString(36).slice(2)}`, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const say = (text: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];
const kpi = (id: string) => ({ id, kind: "kpi", title: "Stock moved at health facility level", query_kind: "value", measure: "quantity" });
const MATERIAL = { severity: "material", widget: "moved", problem: "moved: no facility level filter, though the title claims one", forUser: "The number was not limited to health facilities." };

/** A model that takes these steps and gives these verdicts; `before[n]` runs just before step n is answered. */
function scripted(steps: unknown[][], verdicts: unknown[], before: Record<number, () => Promise<void>> = {}) {
  let step = 0;
  let review = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      await before[step]?.();
      return stream(steps[step++] ?? say("Done."));
    },
    doGenerate: async () => ({ content: [{ type: "text", text: JSON.stringify(verdicts[review++] ?? { findings: [] }) }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
  });
}

describe("the reviewer on a Superset dashboard", () => {
  const servers: Server[] = [];

  type Boards = ReturnType<typeof supersetBoards>;
  async function turn(name: string, model: MockLanguageModelV4, setup?: (store: Boards, superset: ReturnType<typeof fakeSuperset>) => Promise<void>) {
    const superset = fakeSuperset();
    const store = supersetBoards({ inner: memoryStore(), client: superset.client, pack, binding, dashboards: { "superset-7": 7 }, stateFile: join(mkdtempSync(join(tmpdir(), "lp-gate-")), "boards.json") });
    await store.seed();
    await setup?.(store, superset);
    const host: Host = { name: "stock", pack, packYaml, connector: supersetConnector(superset.client, binding), store, ctx: {}, boards: [] };
    registerLlmAdapter({ kind: `superset-gate-${name}`, defaultBaseUrl: "mock:", build: () => model });
    const providers: Provider[] = [{ ...buildProvider({ name, kind: `superset-gate-${name}`, model: "m" }), available: true }];
    const server = createServer(createApp([host], { providers }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/stock/superset-7/chat?model=${name}`;
    const body = await (await fetch(url, { method: "POST", body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "add stock moved at health facility level" }] }] }) })).text();
    return { writes: superset.writes, board: (await store.get("superset-7"))!, versions: await store.versions("superset-7"), body };
  }

  afterAll(() => {
    for (const s of servers) s.close();
  });

  it("a fix that is still wrong: nothing is written to Superset and the board is as it was", async () => {
    const t = await turn("still-wrong", scripted([tool("add_widget", kpi("moved")), say("Added."), tool("update_widget", { id: "moved", title: "Stock moved" }), say("Fixed."), say("")], [{ findings: [MATERIAL] }, { findings: [MATERIAL] }]));
    expect(t.writes).toEqual([]);
    expect(t.board.version).toBe(1);
    expect(t.board.config.widgets).toEqual({});
    // The closing call said nothing, so the plain line stands in, with the reason in the person's words.
    expect(t.body).toContain("I couldn't make a correct version, so I left the board unchanged. The number was not limited to health facilities.");
    expect(t.body).not.toContain("Fixed.");
  });

  it("a fix that works: Superset gets the corrected chart only, in one save", async () => {
    const t = await turn("fixed", scripted([tool("add_widget", kpi("moved")), say("Added."), tool("remove_widget", { id: "moved" }), tool("add_widget", kpi("moved_hf")), say("Corrected.")], [{ findings: [MATERIAL] }, { findings: [] }]));
    expect(t.writes).toEqual(["POST /api/v1/chart", "PUT /api/v1/dashboard/7"]);
    expect(Object.keys(t.board.config.widgets)).toEqual(["moved_hf"]);
    expect(t.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it("no findings: the turn's edits are written to Superset when it ends, one save per edit", async () => {
    const t = await turn("right", scripted([tool("add_widget", kpi("moved")), tool("update_widget", { id: "moved", title: "Stock moved (facilities)" }), say("Added.")], [{ findings: [] }]));
    expect(t.writes).toEqual(["POST /api/v1/chart", "PUT /api/v1/dashboard/7", "PUT /api/v1/chart/100", "PUT /api/v1/dashboard/7"]);
    expect(t.versions.map((v) => v.version)).toEqual([3, 2, 1]);
  });

  describe("when the dashboard is changed by hand while the turn works", () => {
    const catalogue = catalogueFrom(pack);
    // Before the turn: one chart, "w". During it, a person changes the dashboard.
    const handEdited = async (change: (config: BoardConfig) => BoardConfig) => {
      let boards: Boards | undefined;
      let writesBefore = 0;
      const setup = async (store: Boards, superset: ReturnType<typeof fakeSuperset>) => {
        boards = store;
        const r = await store.patch({ id: "superset-7", catalogue, ops: [{ op: "add_widget", id: "w", widget: { kind: "kpi", title: "Stock moved, all levels", query: { kind: "value", measure: "quantity" } } }] });
        expect(r.ok).toBe(true);
        // What Superset was sent from here on is the hand edit's, then the turn's.
        writesBefore = superset.writes.length;
      };
      const byHand = async () => {
        const board = (await boards!.get("superset-7"))!;
        await boards!.replaceConfig({ id: "superset-7", config: change(board.config), source: "layout", summary: "changed by hand" });
      };
      return { setup, byHand, since: (writes: string[]) => writes.slice(writesBefore) };
    };

    it("a later edit no longer fits: nothing from the turn reaches Superset, and the reply says so", async () => {
      const removeW = (c: BoardConfig): BoardConfig => {
        const { w: _w, ...widgets } = c.widgets;
        return { ...c, widgets, layout: c.layout.filter((l) => l.i !== "w") };
      };
      const h = await handEdited(removeW);
      // Step 1 adds a chart (it would still fit); the hand edit comes before step 2, which changes "w".
      const model = scripted([tool("add_widget", kpi("moved")), tool("update_widget", { id: "w", title: "Stock moved (facilities)" }), say("Done.")], [{ findings: [] }], { 1: h.byHand });
      const t = await turn("hand-conflict", model, h.setup);
      const turnWrites = h.since(t.writes);
      // The hand edit's own writes only: the turn's chart was never created.
      expect(turnWrites.filter((w) => w.startsWith("POST"))).toEqual([]);
      expect(t.board.config.widgets).toEqual({});
      expect(t.versions.map((v) => `${v.version} ${v.summary}`)).toEqual(["3 changed by hand", "2 added w", "1 created"]);
      expect(t.body).toContain('The change could not be saved: the board was changed meanwhile, and \\"changed w\\" no longer fits it (No widget called \\"w\\"). Nothing was saved');
    });

    it("the edits still fit: they are saved on top of the hand edit, in one save", async () => {
      const h = await handEdited((c) => ({ ...c, title: "Stock, edited by hand" }));
      const model = scripted([tool("add_widget", kpi("moved")), tool("update_widget", { id: "moved", title: "Stock moved (facilities)" }), say("Done.")], [{ findings: [] }], { 1: h.byHand });
      const t = await turn("hand-fits", model, h.setup);
      expect(t.board.config.title).toBe("Stock, edited by hand");
      expect(Object.keys(t.board.config.widgets).sort()).toEqual(["moved", "w"]);
      expect(t.versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);
      // After the hand edit's save: one new chart and one dashboard save for the whole turn.
      const afterHand = h.since(t.writes).slice(h.since(t.writes).indexOf("PUT /api/v1/dashboard/7") + 1);
      expect(afterHand).toEqual(["POST /api/v1/chart", "PUT /api/v1/dashboard/7"]);
    });
  });
});
