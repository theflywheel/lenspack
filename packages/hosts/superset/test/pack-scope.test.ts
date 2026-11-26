// The pack's own row scope (superset.yaml scope:, one campaign) on every path that asks Superset for a number: the
// chat's tools, explain, saved answers and their suggestion chips, computed charts, board data and filter menus; and a
// dashboard filter on a field the pack leaves out never reaching the answer card, a saved answer's key or telemetry.
// Superset is a recording stand-in client; the model is a mock that calls the tool it is told to.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { memoryStore } from "@lenspack/core";
import { decide, principalOf } from "@lenspack/policy";
import { type Host, type Provider, adminSettings, buildProvider, createApp, registerLlmAdapter } from "@lenspack/serve";

import { type SupersetDataset, packFromDatasets, packScope, supersetConnector } from "../src/index";
import type { SupersetClient } from "../src/client";

const ORDERS: SupersetDataset = {
  id: 11,
  table_name: "orders",
  main_dttm_col: "ordered_at",
  columns: [
    { column_name: "ordered_at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "region", groupby: true, type: "VARCHAR" },
    { column_name: "campaign", groupby: true, type: "VARCHAR" },
    { column_name: "CustomerName", groupby: true, type: "VARCHAR" },
    { column_name: "quantity", groupby: true, type: "BIGINT" },
  ],
  metrics: [{ metric_name: "count", expression: "COUNT(*)" }],
};
// No campaign column: a question about it can't be pinned to one campaign, so it is refused.
const RETURNS: SupersetDataset = { id: 12, table_name: "returns", main_dttm_col: "returned_at", columns: [{ column_name: "returned_at", is_dttm: true, type: "TIMESTAMP" }, { column_name: "region", groupby: true, type: "VARCHAR" }], metrics: [{ metric_name: "count", expression: "COUNT(*)" }] };
const PIN = { dimension: "campaign", op: "eq", value: "spring" } as const;
const PINNED = { col: "campaign", op: "==", val: "spring" };

/** Superset's chart-data API, recording every query object it is sent. */
function recordingClient() {
  const bodies: { datasource: { id: number }; queries: { filters: unknown[]; metrics: unknown[]; columns: unknown[] }[] }[] = [];
  return {
    bodies,
    client: {
      url: "http://superset.invalid",
      async get() {
        throw new Error("not used");
      },
      async post(_path: string, body: never) {
        bodies.push(body);
        const b = body as (typeof bodies)[number];
        return { result: b.queries.map((q) => ({ query: `SELECT … /* ${JSON.stringify(q.filters)} */`, data: (q.columns as unknown[]).length ? [{ region: "North", items_sold: 7, orders_count: 3, __lenspack_n: 3 }] : [{ items_sold: 7, orders_count: 3, __lenspack_n: 3 }] })) };
      },
      async put() {
        throw new Error("not used");
      },
      async delete() {
        throw new Error("not used");
      },
    },
  };
}

type Model = InstanceType<typeof MockLanguageModelV4>;
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = (reason: "stop" | "tool-calls") => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
const streamed = (parts: unknown[]) => ({ stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) as never });
/** A model that runs the query tool with these arguments, then says "done". */
function queryingModel(args: Record<string, unknown>): Model {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async () => (n++ % 2 === 0 ? streamed([{ type: "tool-call", toolCallId: `c${n}`, toolName: "query", input: JSON.stringify(args) }, finish("tool-calls")]) : streamed([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Items sold: 7." }, { type: "text-end", id: "t" }, finish("stop")])),
  });
}
let kinds = 0;
function provider(model: Model): Provider {
  const kind = `scope-mock-${++kinds}`;
  registerLlmAdapter({ kind, defaultBaseUrl: "mock:", build: () => model });
  return { ...buildProvider({ name: "mock", kind, model: "mock-1" }), available: true };
}

describe("the pack's scope on every path", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-pack-scope-"));
  const { pack, packYaml, binding } = packFromDatasets([ORDERS, RETURNS], {
    pack: "shop",
    exclude: { columns: ["CustomerName"] },
    notDimensions: ["quantity"],
    measures: [{ dataset: "orders", name: "items_sold", agg: "sum", column: "quantity" }],
  });
  const ctx = { scope: packScope([PIN], pack).clauses };
  const rec = recordingClient();
  const admin = adminSettings(dir, { cache: { enabled: true, freshMinutes: 0, router: "off" } }, {});
  const model = queryingModel({ query_kind: "breakdown", measure: "items_sold", dimension: "region" });
  const store = memoryStore();
  const host: Host = { name: "shop", pack, packYaml, connector: supersetConnector(rec.client as unknown as SupersetClient, binding), store, ctx, boards: [] };
  let server: Server;
  let base = "";
  const filtersSent = () => rec.bodies.flatMap((b) => b.queries.map((q) => q.filters));
  const since = () => {
    const n = rec.bodies.length;
    return () => rec.bodies.slice(n).flatMap((b) => b.queries.map((q) => q.filters));
  };
  const ask = (text: string, extra: Record<string, unknown> = {}) =>
    fetch(`${base}/shop/b/chat?review=off`, { method: "POST", body: JSON.stringify({ messages: [{ id: `m${Math.random()}`, role: "user", parts: [{ type: "text", text }] }], ...extra }) }).then((r) => r.text());

  beforeAll(async () => {
    await store.create({ id: "b", pack, title: "Shop" });
    server = createServer(createApp([host], { ...admin.app, providers: [provider(model)] }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(() => server.close());

  it("chat tools: the query the model asks for carries the campaign", async () => {
    const after = since();
    const text = await ask("Items by region", { selections: { region: "North", CustomerName: "A. Person" } });
    expect(text).toMatch(/Items sold: 7/);
    expect(after().length).toBeGreaterThan(0);
    for (const f of after()) expect(f).toContainEqual(PINNED);
  });

  it("the model is never told about the excluded column, in its prompt or its tools", () => {
    const sent = JSON.stringify(model.doStreamCalls);
    expect(sent).not.toMatch(/CustomerName|customer_name|A\. Person/);
    expect(sent).toMatch(/items_sold/);
  });

  it("explain: the compiled statement carries the campaign; a dataset without it is refused, not answered for all rows", async () => {
    const q = (o: unknown) => fetch(`${base}/shop/explain?q=${encodeURIComponent(JSON.stringify(o))}`).then((r) => r.json());
    const ok = await q({ kind: "value", measure: "items_sold" });
    expect(ok.ok).toBe(true);
    expect(JSON.parse(ok.native).queries[0].filters).toContainEqual(PINNED);
    expect(await q({ kind: "value", measure: "returns_count" })).toMatchObject({ ok: false, code: "OUT_OF_SCOPE" });
    // The excluded column is not in the pack at all.
    expect(await q({ kind: "breakdown", measure: "items_sold", dimension: "customer_name" })).toMatchObject({ ok: false, code: "UNKNOWN_DIMENSION" });
  });

  it("a dashboard filter can't widen it: a pick of another campaign is added to it, never in place of it", async () => {
    const after = since();
    const config = { ...(await store.get("b"))!.config, widgets: { w: { title: "Items", kind: "kpi", query: { kind: "value", measure: "items_sold" } } as never }, layout: [{ i: "w", x: 0, y: 0, w: 3, h: 3 }], filters: [{ id: "fc", type: "select", label: "Campaign", field: "campaign", applies: ["*"] }] as never };
    const b2 = await store.create({ id: "b2", pack, title: "Two", config });
    const data = await (await fetch(`${base}/shop/${b2.id}/data?f_campaign=autumn`)).json();
    expect(data.w.error).toBeUndefined();
    const sent = after();
    expect(sent.length).toBeGreaterThan(0);
    for (const f of sent) {
      expect(f).toContainEqual(PINNED);
      expect(f).toContainEqual({ col: "campaign", op: "==", val: "autumn" });
    }
  });

  it("filter menus: the values offered are the campaign's", async () => {
    const after = since();
    await fetch(`${base}/shop/b/options?field=region`);
    expect(after().length).toBe(1);
    expect(after()[0]).toContainEqual(PINNED);
  });

  it("computed charts: the base rows a compute step reads carry the campaign", async () => {
    const after = since();
    const b = await store.create({ id: "b3", pack, title: "Computed", config: { ...(await store.get("b"))!.config, widgets: { w: { title: "Share", kind: "chart", chart: "bar", query: { kind: "breakdown", measure: "items_sold", dimension: "region", limit: 10, compute: { steps: [{ op: "ratio", to: "orders_count", percent: true }] } } } as never }, layout: [{ i: "w", x: 0, y: 0, w: 6, h: 4 }] } });
    const data = await (await fetch(`${base}/shop/${b.id}/data`)).json();
    expect(data.w.error, JSON.stringify(data.w)).toBeUndefined();
    expect(after().length).toBeGreaterThan(0);
    for (const f of after()) expect(f).toContainEqual(PINNED);
  });

  it("saved answers: kept under the scope, served again with it, and a filter on an excluded field is not part of the key", async () => {
    const first = await ask("Items sold by region?", { selections: { region: "North", CustomerName: "A. Person" } });
    expect(first).toMatch(/Items sold: 7/);
    // The turn is kept once its reply has gone out.
    await new Promise((r) => setTimeout(r, 300));
    const calls = model.doStreamCalls.length;
    const after = since();
    // Another person's name in the excluded filter: the same question, so the saved answer serves it, its query run again with the scope.
    const again = await ask("Items sold by region?", { selections: { region: "North", CustomerName: "B. Someone" } });
    expect(again, again.slice(-1500)).toMatch(/data-reuse/);
    expect(model.doStreamCalls.length).toBe(calls);
    expect(after().length).toBeGreaterThan(0);
    for (const f of after()) expect(f).toContainEqual(PINNED);
    // Nothing the server keeps on disk (saved answers, telemetry, settings) holds the excluded filter.
    const kept = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile()).map((f) => readFileSync(join(f.parentPath, f.name), "utf8"));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.join("\n")).not.toMatch(/CustomerName|A\. Person|B\. Someone/);
    // A caller without the scope (another deployment's context) is not served it: the scope is part of the key.
    const entries = await admin.reuse.suggestions({ board: "b", pack: "shop", scope: {}, lang: "en" });
    expect(entries).toEqual([]);
  });

  it("suggestion chips: the questions asked under this scope, for callers with it", async () => {
    const r = await (await fetch(`${base}/shop/b/suggestions?lang=en`)).json();
    expect(r.suggestions).toContain("Items sold by region?");
    const d = decide(principalOf({ user: "x" }), pack, { host: ctx });
    expect(d!.ctx.scope).toEqual([PIN]);
  });

  it("the answer card and telemetry never carry the excluded filter; the card says one was not used", async () => {
    const text = await ask("Items by region, fresh", { fresh: true, selections: { region: "North", CustomerName: "A. Person" } });
    const card = text.split("\n").find((l) => l.includes("data-answer-card"));
    expect(card).toBeDefined();
    expect(card).not.toMatch(/CustomerName|A\. Person/);
    expect(card).toMatch(/"unusedSelections":1/);
    await new Promise((r) => setTimeout(r, 200));
    const lines = await admin.telemetryLog.find({ from: new Date(0) });
    const turns = lines.filter((l) => l.type === "turn");
    expect(turns.length).toBeGreaterThan(0);
    expect(JSON.stringify(turns)).not.toMatch(/CustomerName|A\. Person/);
    expect(turns.some((t) => JSON.stringify((t as { selections?: unknown }).selections ?? null).includes("region"))).toBe(true);
  });

  it("every query any path sent carried the campaign", () => {
    expect(filtersSent().every((f) => JSON.stringify(f).includes('"spring"'))).toBe(true);
  });
});
