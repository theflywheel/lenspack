// Text widgets on a Superset dashboard. A board holds no URLs, but Superset draws a markdown block
// with links, so a note Lenspack writes there is made plain: formatting kept, links shown as their
// text, bare addresses and HTML not drawn as links or tags. A block someone wrote in Superset is
// left as they wrote it. Made-up dashboards and a fake Superset.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BoardOp, memoryStore } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import type { SupersetClient } from "../src/client";
import { type SupersetDataset, packFromDatasets } from "../src/index";
import type { Position } from "../src/layout";
import { plainNote } from "../src/note";
import { supersetBoards } from "../src/store";

const J = "⁠";

describe("a note made plain for Superset", () => {
  it("keeps the formatting and shows a link as its text", () => {
    expect(plainNote("A **bold** _note_ with [the guide](https://example.org/guide) and ![a picture](https://example.org/p.png)")).toBe(
      "A **bold** _note_ with the guide and a picture",
    );
    expect(plainNote("- one\n- two\n\n# Heading")).toBe("- one\n- two\n\n# Heading");
  });

  it("escapes what would start a tag or a reference link", () => {
    expect(plainNote('<a href="x">click</a> <b>x</b>')).toBe('\\<a href="x">click\\</a> \\<b>x\\</b>');
    expect(plainNote("[ref][r]\n\n[r]: x")).toBe("\\[ref\\]\\[r\\]\n\n\\[r\\]: x");
    expect(plainNote("already \\[escaped]")).toBe("already \\[escaped\\]");
  });

  it("breaks bare addresses, which Superset would otherwise link, without changing how they read", () => {
    const out = plainNote("See https://example.org/page, www.example.org or write to a@example.org (mailto:b@example.org)");
    expect(out).toBe(`See https${J}://example.org/page, www${J}.example.org or write to a@${J}example.org (mailto:b@${J}example.org)`);
    expect(out.replaceAll(J, "")).toBe("See https://example.org/page, www.example.org or write to a@example.org (mailto:b@example.org)");
  });

  it("leaves code as it is", () => {
    expect(plainNote("Run `curl https://example.org/<x>` first\n```\nhttps://example.org <b>\n```\nthen https://x.example")).toBe(
      `Run \`curl https://example.org/<x>\` first\n\`\`\`\nhttps://example.org <b>\n\`\`\`\nthen https${J}://x.example`,
    );
  });
});

const DATASETS: SupersetDataset[] = [
  { id: 3, table_name: "orders", main_dttm_col: "ordered_at", columns: [{ column_name: "ordered_at", is_dttm: true, type: "DATE" }, { column_name: "country", groupby: true, type: "TEXT" }], metrics: [{ metric_name: "count", expression: "COUNT(*)" }] },
];
const { pack, binding } = packFromDatasets(DATASETS, { pack: "shop", entities: { "3": "order" } });
const catalogue = catalogueFrom(pack);

const THEIRS = "Read [the guide](https://example.org/guide) or <b>ask</b> at help@example.org";
const LONG = `${"x".repeat(2100)} https://example.org`;

function dashboard(): Position {
  return {
    DASHBOARD_VERSION_KEY: "v2",
    ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["GRID_ID"] },
    GRID_ID: { id: "GRID_ID", type: "GRID", children: ["ROW-1"], parents: ["ROOT_ID"] },
    HEADER_ID: { id: "HEADER_ID", type: "HEADER", children: [], meta: { text: "Shop" } },
    "ROW-1": { id: "ROW-1", type: "ROW", children: ["CHART-x101", "MARKDOWN-theirs", "MARKDOWN-long"], parents: ["ROOT_ID", "GRID_ID"], meta: { background: "BACKGROUND_TRANSPARENT" } },
    "CHART-x101": { id: "CHART-x101", type: "CHART", children: [], parents: ["ROOT_ID", "GRID_ID", "ROW-1"], meta: { chartId: 101, width: 4, height: 50, sliceName: "Orders" } },
    "MARKDOWN-theirs": { id: "MARKDOWN-theirs", type: "MARKDOWN", children: [], parents: ["ROOT_ID", "GRID_ID", "ROW-1"], meta: { width: 4, height: 50, code: THEIRS } },
    "MARKDOWN-long": { id: "MARKDOWN-long", type: "MARKDOWN", children: [], parents: ["ROOT_ID", "GRID_ID", "ROW-1"], meta: { width: 4, height: 50, code: LONG } },
  };
}

function fake(position: Position) {
  let dash: any = { id: 7, dashboard_title: "Shop", position_json: JSON.stringify(position), json_metadata: JSON.stringify({}), changed_on: "t0" };
  let changed = 0;
  const charts = [{ id: 101, slice_name: "Orders", form_data: { viz_type: "big_number_total", datasource: "3__table", metric: "count" } }];
  const client = {
    url: "http://superset.test",
    async get(path: string): Promise<any> {
      if (path === "/api/v1/dashboard/7") return { result: dash };
      if (path === "/api/v1/dashboard/7/charts") return { result: charts };
      if (path === "/api/v1/chart/101") return { result: charts[0] };
      throw new Error(`404 GET ${path}`);
    },
    async post(): Promise<any> {
      throw new Error("no chart is made for a note");
    },
    async put(path: string, body: any): Promise<any> {
      if (path === "/api/v1/dashboard/7") dash = { ...dash, ...body, changed_on: `t${++changed}` };
      return {};
    },
    async delete(): Promise<any> {
      return {};
    },
  } as unknown as SupersetClient;
  return { client, pos: (): Position => JSON.parse(dash.position_json) };
}

describe("writing notes to a Superset dashboard", () => {
  it("makes a new note plain and leaves the blocks written in Superset as they were", async () => {
    const f = fake(dashboard());
    const store = supersetBoards({ inner: memoryStore(), client: f.client, pack, binding, dashboards: { b: 7 }, stateFile: join(mkdtempSync(join(tmpdir(), "lp-notes-")), "s.json") });
    await store.seed();
    const add: BoardOp = { op: "add_widget", id: "n1", widget: { kind: "text", title: "Note", body: "**Source:** [the shop report](https://example.org/r), or https://example.org" }, placement: { place: "bottom", width: "half" } } as BoardOp;
    const r = await store.patch({ id: "b", ops: [add], catalogue });
    expect(r.ok).toBe(true);
    const blocks = Object.values(f.pos()).filter((c: any) => c?.type === "MARKDOWN") as any[];
    const code = Object.fromEntries(blocks.map((c) => [c.id, c.meta.code]));
    expect(code["MARKDOWN-theirs"]).toBe(THEIRS);
    expect(code["MARKDOWN-long"]).toBe(LONG);
    const mine = blocks.find((c) => c.id !== "MARKDOWN-theirs" && c.id !== "MARKDOWN-long");
    expect(mine.meta.code).toBe(`**Source:** the shop report, or https${J}://example.org`);
  });
});
