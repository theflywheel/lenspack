// Dashboards with tabs: read from ROOT_ID down, new charts put where Superset draws them (the tab
// the edit or the viewer names, else the first tab), resized in place, removed one placement at a
// time, moves refused plainly, every layout checked before it is saved, and a restore putting a
// removed chart back where it was. Made-up layouts and a fake Superset.
import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BoardOp, memoryStore, stagedStore } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/pack";
import { type Host, type Provider, buildProvider, createApp, registerLlmAdapter } from "@lenspack/serve";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";

import type { SupersetClient } from "../src/client";
import { supersetConnector } from "../src/connector";
import { MOVE_REFUSAL } from "../src/dashboard";
import { type SupersetDataset, packFromDatasets } from "../src/index";
import { type Position, layoutProblems, placeCharts, reachable } from "../src/layout";
import { supersetBoards } from "../src/store";
import { type TabRecord, supersetTabs } from "../src/tabs";
import { TAB_DEFAULTS } from "@lenspack/policy";
import type { RecordStore } from "@lenspack/core";

const DATASETS: SupersetDataset[] = [
  { id: 3, table_name: "households", main_dttm_col: "registered_at", columns: [{ column_name: "registered_at", is_dttm: true, type: "DATE" }, { column_name: "lga", groupby: true, type: "TEXT" }], metrics: [{ metric_name: "count", expression: "COUNT(*)" }] },
];
const { pack, binding } = packFromDatasets(DATASETS, { pack: "homes", entities: { "3": "household" } });
const catalogue = catalogueFrom(pack);
const packYaml = "pack: homes\n";

const P = (...p: string[]) => p;
const CH = (id: string, chartId: number, parents: string[], width = 6) => ({ id, type: "CHART", children: [], parents, meta: { chartId, width, height: 50, sliceName: `Chart ${chartId}` } });
const ROW = (id: string, kids: string[], parents: string[]) => ({ id, type: "ROW", children: kids, parents, meta: { background: "BACKGROUND_TRANSPARENT" } });
const TAB = (id: string, kids: string[], parents: string[], text: string) => ({ id, type: "TAB", children: kids, parents, meta: { text, defaultText: "Tab title" } });

/**
 * Top-level tabs. Superset moved the grid's content into the first tab, so GRID_ID is empty and off ROOT_ID.
 * "Overview": a row of two KPIs (101, 102), then tabs "By LGA" (103) and "Trend" (104) inside it.
 * "Stock": 105, and 101 again (a chart in two tabs).
 */
function topLevel(): Position {
  return {
    DASHBOARD_VERSION_KEY: "v2",
    ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["TABS-top"] },
    GRID_ID: { id: "GRID_ID", type: "GRID", children: [], parents: ["ROOT_ID"] },
    HEADER_ID: { id: "HEADER_ID", type: "HEADER", children: [], meta: { text: "Tabs" } },
    "TABS-top": { id: "TABS-top", type: "TABS", children: ["TAB-ov", "TAB-stock"], parents: P("ROOT_ID"), meta: {} },
    "TAB-ov": TAB("TAB-ov", ["ROW-k", "TABS-in"], P("ROOT_ID", "TABS-top"), "Overview"),
    "ROW-k": ROW("ROW-k", ["CHART-x101", "CHART-x102"], P("ROOT_ID", "TABS-top", "TAB-ov")),
    "CHART-x101": CH("CHART-x101", 101, P("ROOT_ID", "TABS-top", "TAB-ov", "ROW-k")),
    "CHART-x102": CH("CHART-x102", 102, P("ROOT_ID", "TABS-top", "TAB-ov", "ROW-k")),
    "TABS-in": { id: "TABS-in", type: "TABS", children: ["TAB-lga", "TAB-trend"], parents: P("ROOT_ID", "TABS-top", "TAB-ov"), meta: {} },
    "TAB-lga": TAB("TAB-lga", ["ROW-l"], P("ROOT_ID", "TABS-top", "TAB-ov", "TABS-in"), "By LGA"),
    "ROW-l": ROW("ROW-l", ["CHART-x103"], P("ROOT_ID", "TABS-top", "TAB-ov", "TABS-in", "TAB-lga")),
    "CHART-x103": CH("CHART-x103", 103, P("ROOT_ID", "TABS-top", "TAB-ov", "TABS-in", "TAB-lga", "ROW-l"), 12),
    "TAB-trend": TAB("TAB-trend", ["ROW-t"], P("ROOT_ID", "TABS-top", "TAB-ov", "TABS-in"), "Trend"),
    "ROW-t": ROW("ROW-t", ["CHART-x104"], P("ROOT_ID", "TABS-top", "TAB-ov", "TABS-in", "TAB-trend")),
    "CHART-x104": CH("CHART-x104", 104, P("ROOT_ID", "TABS-top", "TAB-ov", "TABS-in", "TAB-trend", "ROW-t"), 12),
    "TAB-stock": TAB("TAB-stock", ["ROW-s"], P("ROOT_ID", "TABS-top"), "Stock"),
    "ROW-s": ROW("ROW-s", ["CHART-y105", "CHART-y101"], P("ROOT_ID", "TABS-top", "TAB-stock")),
    "CHART-y105": CH("CHART-y105", 105, P("ROOT_ID", "TABS-top", "TAB-stock", "ROW-s")),
    "CHART-y101": CH("CHART-y101", 101, P("ROOT_ID", "TABS-top", "TAB-stock", "ROW-s")),
  };
}

/** Tabs inside the grid: a row of KPIs (101, 102), then tabs "Stock" (103, 104) and "Visits" (105, and 101 again). */
function inGrid(): Position {
  return {
    DASHBOARD_VERSION_KEY: "v2",
    ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["GRID_ID"] },
    GRID_ID: { id: "GRID_ID", type: "GRID", children: ["ROW-1", "TABS-1"], parents: ["ROOT_ID"] },
    HEADER_ID: { id: "HEADER_ID", type: "HEADER", children: [], meta: { text: "Tabs" } },
    "ROW-1": ROW("ROW-1", ["CHART-x101", "CHART-x102"], P("ROOT_ID", "GRID_ID")),
    "CHART-x101": CH("CHART-x101", 101, P("ROOT_ID", "GRID_ID", "ROW-1")),
    "CHART-x102": CH("CHART-x102", 102, P("ROOT_ID", "GRID_ID", "ROW-1")),
    "TABS-1": { id: "TABS-1", type: "TABS", children: ["TAB-a", "TAB-b"], parents: P("ROOT_ID", "GRID_ID") },
    "TAB-a": TAB("TAB-a", ["ROW-2"], P("ROOT_ID", "GRID_ID", "TABS-1"), "Stock"),
    "ROW-2": ROW("ROW-2", ["CHART-x103", "CHART-x104"], P("ROOT_ID", "GRID_ID", "TABS-1", "TAB-a")),
    "CHART-x103": CH("CHART-x103", 103, P("ROOT_ID", "GRID_ID", "TABS-1", "TAB-a", "ROW-2")),
    "CHART-x104": CH("CHART-x104", 104, P("ROOT_ID", "GRID_ID", "TABS-1", "TAB-a", "ROW-2")),
    "TAB-b": TAB("TAB-b", ["ROW-3"], P("ROOT_ID", "GRID_ID", "TABS-1"), "Visits"),
    "ROW-3": ROW("ROW-3", ["CHART-x105", "CHART-z101"], P("ROOT_ID", "GRID_ID", "TABS-1", "TAB-b")),
    "CHART-x105": CH("CHART-x105", 105, P("ROOT_ID", "GRID_ID", "TABS-1", "TAB-b", "ROW-3")),
    "CHART-z101": CH("CHART-z101", 101, P("ROOT_ID", "GRID_ID", "TABS-1", "TAB-b", "ROW-3")),
  };
}

/** A fake Superset: a save with json_metadata.positions relinks the dashboard to exactly the charts in it, as Superset does. */
function fake(position: Position) {
  const puts: { path: string; body: any }[] = [];
  const posts: any[] = [];
  let changed = 0;
  let nextChart = 900;
  let dash: any = { id: 7, dashboard_title: "Tabs", position_json: JSON.stringify(position), json_metadata: JSON.stringify({}), changed_on: "t0" };
  const all = [101, 102, 103, 104, 105].map((id) => ({ id, slice_name: `Chart ${id}`, form_data: { viz_type: "big_number_total", datasource: "3__table", metric: "count" } }));
  const linked = new Set(all.map((c) => c.id));
  const client = {
    url: "http://superset.test",
    async get(path: string): Promise<any> {
      if (path === "/api/v1/dashboard/7") return { result: dash };
      if (path === "/api/v1/dashboard/7/charts") return { result: all.filter((c) => linked.has(c.id)) };
      const m = /^\/api\/v1\/chart\/(\d+)$/.exec(path);
      if (m && all.some((c) => c.id === Number(m[1]))) return { result: all.find((c) => c.id === Number(m[1])) };
      throw new Error(`404 GET ${path}`);
    },
    async post(_path: string, body: any): Promise<any> {
      posts.push(body);
      const id = ++nextChart;
      all.push({ id, slice_name: body.slice_name, form_data: { ...JSON.parse(body.params), datasource: "3__table" } });
      if (body.dashboards?.includes(7)) linked.add(id);
      return { id };
    },
    async put(path: string, body: any): Promise<any> {
      puts.push({ path, body });
      if (path === "/api/v1/dashboard/7") {
        dash = { ...dash, ...body, changed_on: `t${++changed}` };
        const m = JSON.parse(body.json_metadata ?? "{}");
        if (m.positions) {
          linked.clear();
          for (const c of Object.values<any>(m.positions)) if (c?.type === "CHART" && all.some((x) => x.id === c.meta.chartId)) linked.add(c.meta.chartId);
        }
      }
      return {};
    },
    async delete(path: string): Promise<any> {
      const id = Number(path.split("/").pop());
      const k = all.findIndex((c) => c.id === id);
      if (k >= 0) all.splice(k, 1);
      linked.delete(id);
      return {};
    },
  } as unknown as SupersetClient;
  return { client, pos: (): Position => JSON.parse(dash.position_json), puts, posts, linked: () => [...linked].sort() };
}

async function board(shape: Position) {
  const f = fake(shape);
  const store = supersetBoards({ inner: memoryStore(), client: f.client, pack, binding, dashboards: { b: 7 }, stateFile: join(mkdtempSync(join(tmpdir(), "lp-tabs-")), "s.json") });
  await store.seed();
  const config = async () => (await store.get("b"))!.config;
  const patch = (ops: BoardOp[], view?: { tabs: string[] }) => store.patch({ id: "b", ops, catalogue, ...(view ? { view } : {}) });
  return { ...f, store, config, patch };
}

/** Each drawn placement of a chart: the tabs above it ("Overview>Trend" by id), or "grid". */
function where(pos: Position, chartId: number): string[] {
  const drawn = reachable(pos);
  return Object.values(pos)
    .filter((c: any) => c?.type === "CHART" && c.meta.chartId === chartId && drawn.has(c.id))
    .map((c: any) => (c.parents as string[]).filter((p) => p.startsWith("TAB-")).join(">") || "grid");
}
/** The row a component sits in, and the components in that row. */
const rowOf = (pos: Position, id: string) => {
  const row = Object.values(pos).find((c: any) => c?.type === "ROW" && c.children.includes(id)) as any;
  return row ? { id: row.id as string, children: row.children as string[] } : null;
};
const chartComponent = (pos: Position, chartId: number) => Object.values(pos).find((c: any) => c?.type === "CHART" && c.meta.chartId === chartId) as any;
const KPI = { kind: "kpi", title: "New KPI", query: { kind: "value", entity: "household", measure: "household_count" } } as any;
const add = (id: string, place?: string): BoardOp => ({ op: "add_widget", id, widget: { ...KPI, title: `KPI ${id}` }, placement: { place: place ?? "bottom", width: "quarter" } } as BoardOp);

describe("reading a dashboard with tabs", () => {
  it("top-level tabs: every chart, in Superset's order and sizes, and each tab with its widgets", async () => {
    const b = await board(topLevel());
    const c = await b.config();
    expect(c.layout.map((l) => `${l.i}:${l.w}`)).toEqual(["c101:6", "c102:6", "c103:12", "c104:12", "c105:6", "c101-2:6"]);
    expect(await b.store.tabs!("b")).toEqual([
      { id: "TAB-ov", title: "Overview", widgets: ["c101", "c102"] },
      { id: "TAB-lga", title: "Overview › By LGA", widgets: ["c103"] },
      { id: "TAB-trend", title: "Overview › Trend", widgets: ["c104"] },
      { id: "TAB-stock", title: "Stock", widgets: ["c105", "c101-2"] },
    ]);
  });

  it("a chart in two tabs keeps the same two widget ids from one read to the next", async () => {
    const b = await board(topLevel());
    await b.store.pull("b", true);
    await b.store.pull("b", true);
    expect(Object.keys((await b.config()).widgets).sort()).toEqual(["c101", "c101-2", "c102", "c103", "c104", "c105"]);
  });

  it("a dashboard without tabs lists none", async () => {
    const flat: Position = { DASHBOARD_VERSION_KEY: "v2", ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["GRID_ID"] }, GRID_ID: { id: "GRID_ID", type: "GRID", children: ["ROW-1"], parents: ["ROOT_ID"] }, "ROW-1": ROW("ROW-1", ["CHART-x101"], P("ROOT_ID", "GRID_ID")), "CHART-x101": CH("CHART-x101", 101, P("ROOT_ID", "GRID_ID", "ROW-1")) };
    const b = await board(flat);
    expect(await b.store.tabs!("b")).toEqual([]);
  });
});

describe("adding a chart to a dashboard with tabs", () => {
  it("top-level tabs, no tab named: in the first tab, never under the grid the tabs left behind", async () => {
    const b = await board(topLevel());
    expect((await b.patch([add("k1")])).ok).toBe(true);
    const pos = b.pos();
    expect(where(pos, 901)).toEqual(["TAB-ov"]);
    expect((pos.GRID_ID as any).children).toEqual([]);
    expect(layoutProblems(pos)).toEqual([]);
    expect(b.linked()).toContain(901);
    // The next read sees it on that tab.
    await b.store.pull("b", true);
    expect((await b.store.tabs!("b")).find((t) => t.id === "TAB-ov")!.widgets).toContain("k1");
  });

  it("the viewer's open tab: at its bottom, or its top", async () => {
    const b = await board(topLevel());
    await b.patch([add("k1")], { tabs: ["TAB-stock"] });
    await b.patch([add("k2", "top")], { tabs: ["TAB-ov", "TAB-trend"] });
    const pos = b.pos();
    expect(where(pos, 901)).toEqual(["TAB-stock"]);
    expect(where(pos, 902)).toEqual(["TAB-ov>TAB-trend"]);
    expect((pos["TAB-trend"] as any).children[0]).toBe(rowOf(pos, chartComponent(pos, 902).id)!.id);
    expect(layoutProblems(pos)).toEqual([]);
  });

  it("an id the page sent that isn't a tab of this dashboard is ignored", async () => {
    const b = await board(topLevel());
    await b.patch([add("k1")], { tabs: ["TAB-nope"] });
    expect(where(b.pos(), 901)).toEqual(["TAB-ov"]);
  });

  it("after: or below: a widget on a tab puts it on that tab, beside the widget when its row has room", async () => {
    const b = await board(topLevel());
    // ROW-s (Stock) is full: a new row right after it, still on Stock, whatever tab the viewer is on.
    await b.patch([add("k1", "after:c105")], { tabs: ["TAB-ov"] });
    // A nested tab.
    await b.patch([add("k2", "below:c103")]);
    const pos = b.pos();
    expect(where(pos, 901)).toEqual(["TAB-stock"]);
    expect((pos["TAB-stock"] as any).children[1]).toBe(rowOf(pos, chartComponent(pos, 901).id)!.id);
    expect(where(pos, 902)).toEqual(["TAB-ov>TAB-lga"]);
    // Beside: a row with room.
    const g = await board(inGrid());
    await g.patch([{ op: "resize_widget", id: "c104", width: "quarter" }]);
    await g.patch([add("k3", "after:c103")]);
    const gp = g.pos();
    expect(rowOf(gp, chartComponent(gp, 901).id)!.id).toBe("ROW-2");
    expect(layoutProblems(pos)).toEqual([]);
    expect(layoutProblems(gp)).toEqual([]);
  });

  it("tabs inside the grid: with no tab named it goes where Superset puts it (the grid), with one, in that tab", async () => {
    const b = await board(inGrid());
    await b.patch([add("k1")]);
    await b.patch([add("k2")], { tabs: ["TAB-b"] });
    const pos = b.pos();
    expect(where(pos, 901)).toEqual(["grid"]);
    expect(where(pos, 902)).toEqual(["TAB-b"]);
    expect(layoutProblems(pos)).toEqual([]);
  });

  it("through a staged turn (the reviewer on), the placement asked for still holds when the turn is saved as one", async () => {
    const b = await board(topLevel());
    const staged = stagedStore(b.store, "b");
    expect((await staged.patch({ id: "b", ops: [add("k1", "below:c104")], catalogue, view: { tabs: ["TAB-stock"] } })).ok).toBe(true);
    expect(b.puts).toEqual([]);
    await staged.commit({ asOne: true });
    expect(where(b.pos(), 901)).toEqual(["TAB-ov>TAB-trend"]);
  });

  it("a chart an earlier version left under the grid top-level tabs left behind is put where it is seen", async () => {
    const broken = topLevel();
    (broken.GRID_ID as any).children = ["ROW-old"];
    broken["ROW-old"] = ROW("ROW-old", ["CHART-old"], P("ROOT_ID", "GRID_ID"));
    broken["CHART-old"] = CH("CHART-old", 105, P("ROOT_ID", "GRID_ID", "ROW-old"));
    // 105 is only under the old grid here.
    (broken["ROW-s"] as any).children = ["CHART-y101"];
    delete broken["CHART-y105"];
    const b = await board(broken);
    expect(layoutProblems(b.pos())).toContain("CHART-old (chart 105) is not under ROOT_ID, so Superset would not show it");
    await b.patch([{ op: "set_title", title: "Tabs again" }]);
    expect(where(b.pos(), 105)).toEqual(["TAB-ov"]);
    expect(layoutProblems(b.pos())).toEqual([]);
  });
});

describe("resizing and removing on a dashboard with tabs", () => {
  it("a resize changes the chart where it is, in its tab; an overfull row wraps in place", async () => {
    const b = await board(topLevel());
    expect((await b.patch([{ op: "resize_widget", id: "c104", width: "half", height: 10 }])).ok).toBe(true);
    let pos = b.pos();
    expect(chartComponent(pos, 104).meta).toMatchObject({ width: 6, height: 70 });
    expect(where(pos, 104)).toEqual(["TAB-ov>TAB-trend"]);
    expect(await b.store.tabs!("b")).toContainEqual({ id: "TAB-trend", title: "Overview › Trend", widgets: ["c104"] });
    // The board reads back as written: the resize holds.
    await b.store.pull("b", true);
    expect((await b.config()).layout.find((l) => l.i === "c104")!.w).toBe(6);
    // Wider than its row has room for: Superset rows hold 12 columns, so the row splits, on the same tab.
    const g = await board(inGrid());
    await g.patch([{ op: "resize_widget", id: "c103", width: "full" }]);
    pos = g.pos();
    expect(where(pos, 103)).toEqual(["TAB-a"]);
    expect(where(pos, 104)).toEqual(["TAB-a"]);
    expect((pos["TAB-a"] as any).children).toHaveLength(2);
    expect(layoutProblems(pos)).toEqual([]);
  });

  it("removing one placement of a chart in two tabs keeps the other, and the chart", async () => {
    const b = await board(topLevel());
    await b.patch([{ op: "remove_widget", id: "c101-2" }]);
    const pos = b.pos();
    expect(where(pos, 101)).toEqual(["TAB-ov"]);
    expect((pos["ROW-s"] as any).children).toEqual(["CHART-y105"]);
    expect(b.linked()).toContain(101);
  });

  it("removing a chart takes its emptied row with it; the tab stays", async () => {
    const b = await board(topLevel());
    await b.patch([{ op: "remove_widget", id: "c103" }]);
    const pos = b.pos();
    expect(pos["ROW-l"]).toBeUndefined();
    expect((pos["TAB-lga"] as any).children).toEqual([]);
    expect(b.linked()).not.toContain(103);
    expect(layoutProblems(pos)).toEqual([]);
  });
});

describe("moving a chart on a dashboard with tabs", () => {
  it("is refused plainly, before anything is written, held or not", async () => {
    const b = await board(topLevel());
    const r = await b.patch([{ op: "move_widget", id: "c105", placement: { place: "top", width: "half" } }]);
    expect(r).toEqual({ ok: false, error: MOVE_REFUSAL });
    const staged = stagedStore(b.store, "b");
    expect(await staged.patch({ id: "b", ops: [{ op: "move_widget", id: "c105", placement: { place: "top", width: "half" } }], catalogue })).toEqual({ ok: false, error: MOVE_REFUSAL });
    expect(b.puts).toEqual([]);
    expect((await b.store.versions("b")).length).toBe(1);
  });

  it("a layout saved with only places swapped (a drag) is refused too, and the board stays as Superset has it", async () => {
    const b = await board(topLevel());
    const c = await b.config();
    const swapped = { ...c, layout: c.layout.map((l) => (l.i === "c101" ? { ...l, x: 6 } : l.i === "c102" ? { ...l, x: 0 } : l)) };
    await expect(b.store.replaceConfig({ id: "b", config: swapped, source: "layout" })).rejects.toThrow(/can't move charts/);
    expect(b.puts).toEqual([]);
    expect((await b.config()).layout).toEqual(c.layout);
  });

  it("a dashboard without tabs still moves", async () => {
    const flat: Position = { DASHBOARD_VERSION_KEY: "v2", ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["GRID_ID"] }, GRID_ID: { id: "GRID_ID", type: "GRID", children: ["ROW-1", "ROW-2"], parents: ["ROOT_ID"] }, "ROW-1": ROW("ROW-1", ["CHART-x101"], P("ROOT_ID", "GRID_ID")), "CHART-x101": CH("CHART-x101", 101, P("ROOT_ID", "GRID_ID", "ROW-1"), 12), "ROW-2": ROW("ROW-2", ["CHART-x102"], P("ROOT_ID", "GRID_ID")), "CHART-x102": CH("CHART-x102", 102, P("ROOT_ID", "GRID_ID", "ROW-2"), 12) };
    const b = await board(flat);
    const r = await b.patch([{ op: "move_widget", id: "c102", placement: { place: "top", width: "full" } }]);
    expect(r.ok ? "ok" : (r as { error: string }).error).toBe("ok");
    expect((b.pos().GRID_ID as any).children.map((row: string) => (b.pos()[row] as any).children[0]).slice(0, 2)).toEqual(["CHART-x102", "CHART-x101"]);
  });
});

describe("restoring a version on a dashboard with tabs", () => {
  it("puts a removed chart back: the same chart, in its tab, row and place, with nothing rewritten", async () => {
    const b = await board(topLevel());
    await b.patch([{ op: "remove_widget", id: "c102" }]);
    await b.patch([{ op: "remove_widget", id: "c103" }]);
    expect(b.linked()).toEqual([101, 104, 105]);
    const first = (await b.store.versions("b")).at(-1)!.version;
    await b.store.revertTo("b", first);
    const pos = b.pos();
    expect(b.posts).toEqual([]);
    expect(b.puts.filter((p) => p.path.startsWith("/api/v1/chart/"))).toEqual([]);
    expect(b.linked()).toEqual([101, 102, 103, 104, 105]);
    expect(rowOf(pos, chartComponent(pos, 102).id)).toEqual({ id: "ROW-k", children: ["CHART-x101", "CHART-x102"] });
    expect(where(pos, 103)).toEqual(["TAB-ov>TAB-lga"]);
    expect((pos["TAB-lga"] as any).children).toHaveLength(1);
    expect(chartComponent(pos, 103).meta.width).toBe(12);
    expect(layoutProblems(pos)).toEqual([]);
  });

  it("a chart in two tabs: restoring a removed placement brings back that one placement, no copies", async () => {
    const b = await board(topLevel());
    await b.patch([{ op: "remove_widget", id: "c101-2" }]);
    await b.store.revertTo("b", 1);
    const pos = b.pos();
    expect(where(pos, 101).sort()).toEqual(["TAB-ov", "TAB-stock"]);
    expect((pos["ROW-s"] as any).children).toHaveLength(2);
    expect(b.posts).toEqual([]);
    expect(Object.keys((await b.config()).widgets).sort()).toEqual(["c101", "c101-2", "c102", "c103", "c104", "c105"]);
  });

  it("a chart Lenspack made and deleted with its widget is made again, in the place it had", async () => {
    const b = await board(topLevel());
    await b.patch([add("k1")], { tabs: ["TAB-stock"] });
    const added = (await b.store.versions("b"))[0]!.version;
    await b.patch([{ op: "remove_widget", id: "k1" }]);
    expect(b.linked()).not.toContain(901);
    await b.store.revertTo("b", added);
    expect(b.posts).toHaveLength(2);
    expect(where(b.pos(), 902)).toEqual(["TAB-stock"]);
  });

  it("a restore keeps charts where they are now rather than refusing a move", async () => {
    const b = await board(topLevel());
    await b.patch([{ op: "resize_widget", id: "c101", width: "quarter" }]);
    expect(await b.store.revertTo("b", 1)).not.toBeNull();
    expect(chartComponent(b.pos(), 101).meta.width).toBe(6);
  });
});

describe("the layout check before every save", () => {
  it("passes Superset's own shapes", () => {
    expect(layoutProblems(topLevel())).toEqual([]);
    expect(layoutProblems(inGrid())).toEqual([]);
  });

  it("names what is wrong", () => {
    const p = inGrid();
    (p["ROW-3"] as any).children.push("CHART-gone");
    (p["CHART-x103"] as any).parents = P("ROOT_ID", "GRID_ID", "ROW-2");
    (p["TAB-a"] as any).children.push("ROW-3");
    p["CHART-lost"] = CH("CHART-lost", 106, P("ROOT_ID", "GRID_ID", "ROW-9"));
    (p.ROOT_ID as any).children.push("TABS-1");
    p["CHART-wrong-key"] = CH("CHART-other", 107, []);
    expect(layoutProblems(p)).toEqual(
      expect.arrayContaining([
        "ROOT_ID must hold exactly one GRID or TABS",
        "ROW-3 lists CHART-gone, which is not in the layout",
        "ROW-3 is listed by both TAB-a and TAB-b",
        "TABS-1 is listed by both ROOT_ID and GRID_ID",
        'CHART-x103\'s parents are ["ROOT_ID","GRID_ID","ROW-2"], not ["ROOT_ID","GRID_ID","TABS-1","TAB-a","ROW-2"]',
        "CHART-lost (chart 106) is not under ROOT_ID, so Superset would not show it",
        "CHART-wrong-key is stored under another component's id (CHART-other)",
      ]),
    );
    const loop = inGrid();
    (loop["ROW-1"] as any).children.push("GRID_ID");
    expect(layoutProblems(loop).join("\n")).toMatch(/inside itself|cannot sit in/);
    const misplaced = inGrid();
    (misplaced["TABS-1"] as any).children.push("CHART-new");
    misplaced["CHART-new"] = CH("CHART-new", 106, P("ROOT_ID", "GRID_ID", "TABS-1"));
    expect(layoutProblems(misplaced)).toEqual(["CHART-new (CHART) cannot sit in TABS-1 (TABS)"]);
  });

  it("a tab whose stored parents are stale still takes a new chart, with the right parents", async () => {
    const stale = topLevel();
    (stale["TAB-stock"] as any).parents = ["ROOT_ID"];
    const b = await board(stale);
    expect((await b.patch([add("k1")], { tabs: ["TAB-stock"] })).ok).toBe(true);
    const pos = b.pos();
    expect(chartComponent(pos, 901).parents).toEqual(["ROOT_ID", "TABS-top", "TAB-stock", rowOf(pos, chartComponent(pos, 901).id)!.id]);
    // The problem it already had is left as it was, not made worse.
    expect(layoutProblems(pos)).toEqual(['TAB-stock\'s parents are ["ROOT_ID"], not ["ROOT_ID","TABS-top"]']);
  });
});

describe("placeCharts (for copies of a dashboard)", () => {
  it("puts charts the layout doesn't draw in the first top-level tab, never under the left-behind grid", () => {
    const p = topLevel();
    (p.GRID_ID as any).children = ["ROW-old"];
    p["ROW-old"] = ROW("ROW-old", ["CHART-old"], P("ROOT_ID", "GRID_ID"));
    p["CHART-old"] = CH("CHART-old", 108, P("ROOT_ID", "GRID_ID", "ROW-old"));
    const out = placeCharts(p, [101, 102, 103, 104, 105, 107, 108, 109, 110]);
    expect(where(out, 107)).toEqual(["TAB-ov"]);
    expect(where(out, 108)).toEqual(["TAB-ov"]);
    expect(where(out, 110)).toEqual(["TAB-ov"]);
    expect(out["CHART-old"]).toBeUndefined();
    expect(layoutProblems(out)).toEqual([]);
    expect(placeCharts(inGrid(), [106]).GRID_ID).toMatchObject({ children: ["ROW-1", "TABS-1", "ROW-lp-1"] });
    expect(layoutProblems(placeCharts(undefined, [1, 2]))).toEqual([]);
  });
});

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stream = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) });
const tool = (toolName: string, input: unknown) => [
  { type: "tool-call", toolCallId: `c${Math.random().toString(36).slice(2)}`, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const say = (text: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];

describe("the chat on a dashboard with tabs", () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
  });
  async function chat(b: Awaited<ReturnType<typeof board>>, kind: string, steps: unknown[][], text: string, view?: unknown) {
    const prompts: string[] = [];
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async (call) => {
        prompts.push(JSON.stringify(call.prompt));
        return stream(steps[step++] ?? say("Done."));
      },
      doGenerate: async () => ({ content: [{ type: "text", text: JSON.stringify({ findings: [] }) }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
    });
    const host: Host = { name: "homes", pack, packYaml, connector: supersetConnector(b.client, binding), store: b.store, ctx: {}, boards: [] };
    registerLlmAdapter({ kind, defaultBaseUrl: "mock:", build: () => model });
    const providers: Provider[] = [{ ...buildProvider({ name: "m", kind, model: "m" }), available: true }];
    const server = createServer(createApp([host], { providers }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/homes/b/chat?model=m`;
    const body = await (await fetch(url, { method: "POST", body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text }] }], ...(view ? { view } : {}) }) })).text();
    return { prompts, body };
  }

  it("“add a chart here”: the model is told the tabs and the viewer's tab, and the chart lands on that tab", async () => {
    const b = await board(topLevel());
    const { prompts } = await chat(b, "superset-tabs-add", [tool("add_widget", { id: "homes", title: "Households", kind: "kpi", query_kind: "value", measure: "household_count", place: "bottom", width: "quarter" }), say("Added on the Stock tab.")], "add a households KPI here", { tabs: ["TAB-stock"], junk: 1 });
    expect(prompts[0]).toContain("TABS (the board is laid out in tabs");
    expect(prompts[0]).toContain("“Overview › Trend”: c104");
    expect(prompts[0]).toContain("The viewer is on the tab “Stock”.");
    expect(where(b.pos(), 901)).toEqual(["TAB-stock"]);
  });

  it("“move it to the top”: the tool says plainly it can't, and nothing is saved", async () => {
    const b = await board(topLevel());
    const { prompts } = await chat(b, "superset-tabs-move", [tool("move_widget", { id: "c105", place: "top", width: "half" }), say("I can't move charts on this dashboard yet.")], "move the stock chart to the top");
    expect(prompts[1]).toContain("can't move charts on it yet");
    expect(prompts[0]).toContain("Which tab the viewer is on is not known.");
    expect(b.puts).toEqual([]);
  });
});

describe("tabs as board edits", () => {
  it("the board carries the tabs and each widget's tab, nested tabs by their own contents", async () => {
    const b = await board(topLevel());
    const c = await b.config();
    expect(c.tabs).toEqual([
      { id: "TAB-ov", title: "Overview" },
      { id: "TAB-lga", title: "By LGA", parent: "TAB-ov" },
      { id: "TAB-trend", title: "Trend", parent: "TAB-ov" },
      { id: "TAB-stock", title: "Stock" },
    ]);
    expect(Object.fromEntries(c.layout.map((l) => [l.i, l.tab]))).toEqual({ c101: "TAB-ov", c102: "TAB-ov", c103: "TAB-lga", c104: "TAB-trend", c105: "TAB-stock", "c101-2": "TAB-stock" });
  });

  it("add_tab makes a tab at the end of the outermost tabs, and a widget asked for on it lands there", async () => {
    const b = await board(topLevel());
    expect((await b.patch([{ op: "add_tab", id: "TAB-lp-new", title: "olu" }])).ok).toBe(true);
    expect((await b.patch([{ ...add("k1"), placement: { place: "bottom", width: "quarter", tab: "TAB-lp-new" } } as BoardOp], { tabs: ["TAB-stock"] })).ok).toBe(true);
    const pos = b.pos();
    expect((pos["TABS-top"] as any).children).toEqual(["TAB-ov", "TAB-stock", "TAB-lp-new"]);
    expect((pos["TAB-lp-new"] as any).meta.text).toBe("olu");
    expect(where(pos, 901)).toEqual(["TAB-lp-new"]);
    expect(layoutProblems(pos)).toEqual([]);
    await b.store.pull("b", true);
    expect((await b.config()).tabs!.at(-1)).toEqual({ id: "TAB-lp-new", title: "olu" });
  });

  it("rename_tab renames; remove_tab takes the tab off with its charts; a restore brings it back with the same id", async () => {
    const b = await board(topLevel());
    await b.patch([{ op: "add_tab", id: "TAB-lp-new", title: "olu" }]);
    await b.patch([{ ...add("k1"), placement: { place: "bottom", width: "quarter", tab: "TAB-lp-new" } } as BoardOp]);
    await b.patch([{ op: "rename_tab", id: "TAB-lp-new", title: "olu: trend" }]);
    expect((b.pos()["TAB-lp-new"] as any).meta.text).toBe("olu: trend");
    const v = (await b.store.get("b"))!.version;
    expect((await b.patch([{ op: "remove_tab", id: "TAB-lp-new" }])).ok).toBe(true);
    expect(b.pos()["TAB-lp-new"]).toBeUndefined();
    expect(b.linked()).not.toContain(901);
    expect(layoutProblems(b.pos())).toEqual([]);
    await b.store.revertTo("b", v);
    const pos = b.pos();
    expect((pos["TABS-top"] as any).children).toEqual(["TAB-ov", "TAB-stock", "TAB-lp-new"]);
    expect(where(pos, 902)).toEqual(["TAB-lp-new"]);
    expect(layoutProblems(pos)).toEqual([]);
  });

  it("the only tab of its set is not removed, and a board without tabs gets no first tab", async () => {
    const b = await board(topLevel());
    expect(await b.patch([{ op: "remove_tab", id: "TAB-stock" }, { op: "remove_tab", id: "TAB-ov" }])).toMatchObject({ ok: false, error: expect.stringContaining("only tab") });
    const flat: Position = { DASHBOARD_VERSION_KEY: "v2", ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["GRID_ID"] }, GRID_ID: { id: "GRID_ID", type: "GRID", children: ["ROW-1"], parents: ["ROOT_ID"] }, "ROW-1": ROW("ROW-1", ["CHART-x101"], P("ROOT_ID", "GRID_ID")), "CHART-x101": CH("CHART-x101", 101, P("ROOT_ID", "GRID_ID", "ROW-1")) };
    const f = await board(flat);
    expect(await f.patch([{ op: "add_tab", id: "TAB-lp-x", title: "x" }])).toMatchObject({ ok: false, error: expect.stringContaining("no tabs") });
  });

  it("the last check before saving: a protected tab, its charts and its place stay as Superset has them", async () => {
    const f = fake(topLevel());
    const store = supersetBoards({ inner: memoryStore(), client: f.client, pack, binding, dashboards: { b: 7 }, stateFile: join(mkdtempSync(join(tmpdir(), "lp-tabs-")), "s.json"), protectedTabs: () => ["TAB-stock"] });
    await store.seed();
    const r = await store.patch({ id: "b", ops: [{ op: "resize_widget", id: "c105", width: "third" }], catalogue });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("protected tab") });
    expect(f.puts).toEqual([]);
    expect((await store.patch({ id: "b", ops: [{ op: "remove_tab", id: "TAB-stock" }], catalogue })).ok).toBe(false);
    // Elsewhere is fine.
    expect((await store.patch({ id: "b", ops: [{ op: "resize_widget", id: "c102", width: "third" }], catalogue })).ok).toBe(true);
  });
});

/** Records in memory, as the state directory's file keeps them. */
function memoryRecords<T>(): RecordStore<T> {
  const all = new Map<string, T>();
  return { list: async () => [...all.values()], get: async (id) => all.get(id) ?? null, put: async (id, v) => void all.set(id, v), delete: async (id) => all.delete(id) };
}

describe("the tab rules through the server", () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
  });

  async function serve(rules: { protected?: Record<string, string[]>; create?: boolean; playground?: boolean }, steps: unknown[][] = []) {
    const b = await board(topLevel());
    const records = memoryRecords<TabRecord>();
    const tabs = supersetTabs({ records, configured: { ...TAB_DEFAULTS, protected: rules.protected ?? {} }, saved: () => ({}), switches: () => ({ create: !!rules.create, playground: !!rules.playground }), client: b.client, dashboardOf: () => 7 });
    const prompts: string[] = [];
    let step = 0;
    const kind = `superset-tab-rules-${Math.random().toString(36).slice(2)}`;
    const model = new MockLanguageModelV4({
      doStream: async (call) => {
        prompts.push(JSON.stringify(call.prompt));
        return stream(steps[step++] ?? say("Done."));
      },
      doGenerate: async () => ({ content: [{ type: "text", text: JSON.stringify({ findings: [] }) }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
    });
    registerLlmAdapter({ kind, defaultBaseUrl: "mock:", build: () => model });
    const providers: Provider[] = [{ ...buildProvider({ name: "m", kind, model: "m" }), available: true }];
    const who = { user: "ben", admin: false, edits: true };
    const host: Host = { name: "homes", pack, packYaml, connector: supersetConnector(b.client, binding), store: b.store, ctx: {}, boards: [] };
    const server = createServer(createApp([host], { providers, tabs: async (_req, turn) => tabs.port(who, turn.boardId), boardGuard: () => (board, before, after) => tabs.check(who, board, before, after) }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/homes/b`;
    const ask = async (text: string) => (await fetch(`${base}/chat?model=m&review=off`, { method: "POST", body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text }] }] }) })).text();
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${base}/${path}`, { method: "POST", body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as any };
    };
    return { b, ask, post, prompts, records };
  }

  it("a protected tab: the chat's tool refuses and the prompt says so; the board API and a restore are refused too", async () => {
    const t = await serve({ protected: { b: ["TAB-stock"] } }, [tool("remove_widget", { id: "c105" }), say("That tab is protected.")]);
    await t.ask("remove the stock chart");
    expect(t.prompts[0]).toContain("TAB RULES");
    expect(t.prompts[0]).toContain("Protected (the chat never changes them");
    expect(t.prompts[1]).toContain("is protected on this deployment");
    expect(t.b.puts).toEqual([]);
    expect((await t.post("ops", { ops: [{ op: "resize_widget", id: "c105", width: "third" }] })).body).toMatchObject({ ok: false, error: expect.stringContaining("protected") });
    // A change elsewhere goes through; restoring the version before it would not touch Stock either.
    expect((await t.post("ops", { ops: [{ op: "resize_widget", id: "c102", width: "third" }] })).body).toMatchObject({ ok: true });
    expect(t.b.puts.length).toBeGreaterThan(0);
  });

  it("a tab made through the chat is recorded with its maker, and is theirs to fill", async () => {
    const t = await serve({ create: true }, [tool("add_tab", { title: "Mine" }), tool("add_widget", { id: "homes", title: "Households", kind: "kpi", query_kind: "value", measure: "household_count", tab: "Mine" }), say("Done.")]);
    await t.ask("make me a tab with a households KPI");
    const rec = await t.records.list();
    expect(rec).toEqual([expect.objectContaining({ board: "b", title: "Mine", user: "ben" })]);
    expect(where(t.b.pos(), 901)).toEqual([rec[0]!.tab]);
  });
});
