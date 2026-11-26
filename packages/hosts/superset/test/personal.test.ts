// People's own dashboards and saved layouts, against a fake of Superset's dashboard and chart API that
// behaves as Superset 5.0 and 6.1 do (the copy endpoint clones the charts its layout places, keeps each
// layout component's id and makes the caller the owner). The real thing is in personal-live.test.ts.
import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BoardConfig, type PersonalDashboard, type SavedLayout, memoryRecords, memoryStore } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/pack";
import { NOT_OWN_MESSAGE, PERSONAL_DEFAULTS, type PersonalLimits, decide, principalOf } from "@lenspack/policy";
import { type Host, type Provider, buildProvider, createApp, registerLlmAdapter } from "@lenspack/serve";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";

import { type SupersetClient, SupersetError } from "../src/client";
import { supersetConnector } from "../src/connector";
import { READ_ONLY_MESSAGE } from "../src/identity";
import { type SupersetDataset, packFromDatasets, widgetToChart } from "../src/index";
import { type Position as LayoutPosition, layoutProblems } from "../src/layout";
import { type PersonalEvent, chartIdMap, completePositions, personalDashboards, remapChartIds } from "../src/personal";
import { fileRecords } from "../src/records";
import { supersetBoards } from "../src/store";

// Made-up datasets: stock moves, and visits (which some people may not read).
const DATASETS: SupersetDataset[] = [
  { id: 3, table_name: "stock_moves", main_dttm_col: "moved_at", columns: [{ column_name: "moved_at", is_dttm: true, type: "DATE" }, { column_name: "facility_level", groupby: true, type: "TEXT" }], metrics: [{ metric_name: "quantity", expression: "SUM(quantity)" }] },
  { id: 4, table_name: "visits", main_dttm_col: "visited_at", columns: [{ column_name: "visited_at", is_dttm: true, type: "DATE" }, { column_name: "ward", groupby: true, type: "TEXT" }], metrics: [{ metric_name: "visit_total", expression: "COUNT(*)" }] },
];
const { pack, packYaml, binding } = packFromDatasets(DATASETS, { pack: "stock", entities: { "3": "move", "4": "visit" } });

const LENSPACK_ID = 99;
const OWNER = { user: "olu", userId: 5, roles: [] };
const VIEWER = { user: "vee", userId: 6, roles: [] };
const ADMIN = { user: "ada", userId: 1, roles: ["admin"] };

const KPI = { kind: "kpi", title: "Stock moved", query: { kind: "value", measure: "quantity" } } as const;
const VISITS = { kind: "kpi", title: "Visits", query: { kind: "value", measure: "visit_total" } } as const;

/** Superset's dashboards and charts in memory, recording every write. */
function fakeSuperset() {
  const writes: { method: string; path: string; body?: any }[] = [];
  let nextDash = 7;
  let nextChart = 100;
  let tick = 0;
  type Dash = { id: number; dashboard_title: string; position_json: string | null; json_metadata: string | null; changed_on: string; owners: number[] };
  type Chart = { id: number; slice_name: string; form_data: Record<string, any>; owners: number[]; dashboards: number[] };
  const dashes = new Map<number, Dash>();
  const charts = new Map<number, Chart>();
  const chartFor = (widget: any, dash: number) => {
    const spec = widgetToChart(widget, pack, binding)!;
    const c: Chart = { id: nextChart++, slice_name: widget.title, form_data: { ...spec.params, viz_type: spec.viz_type, datasource: `${spec.datasetId}__table` }, owners: [LENSPACK_ID], dashboards: [dash] };
    charts.set(c.id, c);
    return c;
  };
  const missing = (path: string) => new SupersetError(404, `Superset GET ${path} → 404: Not found`);
  const client: SupersetClient = {
    url: "http://superset.test",
    async get(path): Promise<any> {
      let m = /^\/api\/v1\/dashboard\/(\d+)$/.exec(path);
      if (m) {
        const d = dashes.get(Number(m[1]));
        if (!d) throw missing(path);
        return { result: { ...d, owners: d.owners.map((id) => ({ id, first_name: "F", last_name: "L" })) } };
      }
      m = /^\/api\/v1\/dashboard\/(\d+)\/charts$/.exec(path);
      if (m) return { result: [...charts.values()].filter((c) => c.dashboards.includes(Number(m![1]))).map((c) => ({ id: c.id, slice_name: c.slice_name, form_data: c.form_data })) };
      m = /^\/api\/v1\/chart\/(\d+)$/.exec(path);
      if (m) {
        const c = charts.get(Number(m[1]));
        if (!c) throw missing(path);
        return { result: { id: c.id, dashboards: c.dashboards.map((id) => ({ id })) } };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body: any): Promise<any> {
      writes.push({ method: "POST", path, body });
      if (path === "/api/v1/dashboard/") {
        const d: Dash = { id: nextDash++, dashboard_title: body.dashboard_title, position_json: null, json_metadata: null, changed_on: `t${++tick}`, owners: body.owners ?? [LENSPACK_ID] };
        dashes.set(d.id, d);
        return { id: d.id, result: body };
      }
      const m = /^\/api\/v1\/dashboard\/(\d+)\/copy\/$/.exec(path);
      if (m) {
        const src = dashes.get(Number(m[1]))!;
        const meta = JSON.parse(body.json_metadata);
        const id = nextDash++;
        const map = new Map<number, number>();
        // As Superset does: every chart of the original cloned, the layout's chart ids renamed, owners the caller.
        for (const c of [...charts.values()].filter((c) => c.dashboards.includes(src.id))) {
          const clone: Chart = { ...structuredClone(c), id: nextChart++, owners: [LENSPACK_ID], dashboards: [] };
          charts.set(clone.id, clone);
          map.set(c.id, clone.id);
        }
        for (const v of Object.values<any>(meta.positions)) if (v?.meta?.chartId) v.meta.chartId = map.get(v.meta.chartId);
        const placed = new Set(Object.values<any>(meta.positions).flatMap((v) => (v?.type === "CHART" ? [v.meta.chartId] : [])));
        for (const c of map.values()) if (placed.has(c)) charts.get(c)!.dashboards.push(id);
        const { positions, ...rest } = meta;
        dashes.set(id, { id, dashboard_title: body.dashboard_title, position_json: JSON.stringify(positions), json_metadata: src.json_metadata ?? JSON.stringify(rest), changed_on: `t${++tick}`, owners: [LENSPACK_ID] });
        return { result: { id, last_modified_time: 0 } };
      }
      if (path === "/api/v1/chart") {
        const c: Chart = { id: nextChart++, slice_name: body.slice_name, form_data: { ...JSON.parse(body.params), viz_type: body.viz_type, datasource: `${body.datasource_id}__table` }, owners: body.owners ?? [LENSPACK_ID], dashboards: body.dashboards ?? [] };
        charts.set(c.id, c);
        return { id: c.id };
      }
      throw new Error(`unexpected POST ${path}`);
    },
    async put(path, body: any): Promise<any> {
      writes.push({ method: "PUT", path, body });
      let m = /^\/api\/v1\/dashboard\/(\d+)$/.exec(path);
      if (m) {
        const d = dashes.get(Number(m[1]))!;
        if (body.owners) d.owners = body.owners;
        if (body.json_metadata) d.json_metadata = body.json_metadata;
        if (body.position_json) {
          d.position_json = body.position_json;
          const ids = Object.values<any>(JSON.parse(body.position_json)).flatMap((v) => (v?.type === "CHART" ? [v.meta.chartId] : []));
          for (const c of charts.values()) c.dashboards = ids.includes(c.id) ? [...new Set([...c.dashboards, d.id])] : c.dashboards.filter((x) => x !== d.id);
        }
        if (body.dashboard_title) d.dashboard_title = body.dashboard_title;
        d.changed_on = `t${++tick}`;
        return {};
      }
      m = /^\/api\/v1\/chart\/(\d+)$/.exec(path);
      if (m) {
        const c = charts.get(Number(m[1]))!;
        if (body.owners) c.owners = body.owners;
        if (body.slice_name) c.slice_name = body.slice_name;
        return {};
      }
      throw new Error(`unexpected PUT ${path}`);
    },
    async delete(path): Promise<any> {
      writes.push({ method: "DELETE", path });
      let m = /^\/api\/v1\/dashboard\/(\d+)$/.exec(path);
      if (m) {
        dashes.delete(Number(m[1]));
        for (const c of charts.values()) c.dashboards = c.dashboards.filter((x) => x !== Number(m![1]));
        return {};
      }
      m = /^\/api\/v1\/chart\/(\d+)$/.exec(path);
      if (m) return charts.delete(Number(m[1])), {};
      throw new Error(`unexpected DELETE ${path}`);
    },
  };
  /** An official dashboard owned by someone, with charts drawn from these widgets and a filter bar scoped to the first. */
  function official(title: string, owners: number[], widgets: any[]) {
    const id = nextDash++;
    const made = widgets.map((w) => chartFor(w, id));
    const position: Record<string, any> = { DASHBOARD_VERSION_KEY: "v2", ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["GRID_ID"] }, GRID_ID: { id: "GRID_ID", type: "GRID", children: ["ROW-1"], parents: ["ROOT_ID"] }, "ROW-1": { id: "ROW-1", type: "ROW", children: [], parents: ["ROOT_ID", "GRID_ID"] } };
    for (const c of made) {
      position[`CHART-${c.id}`] = { id: `CHART-${c.id}`, type: "CHART", children: [], parents: ["ROOT_ID", "GRID_ID", "ROW-1"], meta: { chartId: c.id, width: 4, height: 50 } };
      position["ROW-1"].children.push(`CHART-${c.id}`);
    }
    const meta = { native_filter_configuration: [{ id: "NATIVE_FILTER-a", name: "Level", filterType: "filter_select", targets: [{ datasetId: 3, column: { name: "facility_level" } }], chartsInScope: made.map((c) => c.id), scope: { rootPath: ["ROOT_ID"], excluded: [] } }] };
    dashes.set(id, { id, dashboard_title: title, position_json: JSON.stringify(position), json_metadata: JSON.stringify(meta), changed_on: `t${++tick}`, owners });
    return { id, charts: made.map((c) => c.id) };
  }
  return { client, writes, dashes, charts, official };
}

function setup(limits: Partial<PersonalLimits> = {}) {
  const superset = fakeSuperset();
  const dashboards: Record<string, number> = {};
  const links = memoryRecords<PersonalDashboard>();
  const layouts = memoryRecords<SavedLayout>();
  const store = supersetBoards({
    inner: memoryStore(),
    client: superset.client,
    pack,
    binding,
    dashboards,
    stateFile: join(mkdtempSync(join(tmpdir(), "lp-mine-")), "boards.json"),
    ownersOf: async (board) => {
      const l = dashboards[board] === undefined ? null : await links.get(String(dashboards[board]));
      return l ? [l.ownerId] : undefined;
    },
  });
  const bindBoard = async (id: number) => {
    const board = `superset-${id}`;
    if (dashboards[board] === undefined) {
      dashboards[board] = id;
      await store.pull(board, true);
    }
    return board;
  };
  const audit: { user: string; action: string; outcome: string; detail?: string }[] = [];
  let n = 0;
  const events: PersonalEvent[] = [];
  const personal = personalDashboards({ client: superset.client, store, pack, bindBoard, links, layouts, limits: () => ({ ...PERSONAL_DEFAULTS, ...limits }), audit: (e) => audit.push(e), newId: () => `l_${++n}`, telemetry: (e) => events.push(e) });
  return { superset, store, dashboards, links, layouts, personal, audit, bindBoard, events };
}

const edit = (board: string) => ({ board, edit: true, ctx: {} });

describe("a dashboard of one's own", () => {
  it("is made blank, owned by the person in Superset, and bound so the chat works on it", async () => {
    const t = setup();
    const r = await t.personal.create(OWNER, "My stock view");
    expect(r).toMatchObject({ ok: true, title: "My stock view", url: expect.stringMatching(/\/superset\/dashboard\/\d+\/$/) });
    if (!r.ok) throw new Error();
    expect(t.superset.dashes.get(r.dashboard)!.owners).toEqual([OWNER.userId]);
    expect(t.dashboards[r.board]).toBe(r.dashboard);
    expect(await t.store.get(r.board)).toBeTruthy();
    expect((await t.links.get(String(r.dashboard)))!.owner).toBe("olu");
    expect(t.audit.at(-1)).toMatchObject({ user: "olu", action: "dashboard-create", outcome: "ok" });
    // A private draft: not published, no dashboard roles.
    expect(t.superset.writes.find((w) => w.method === "POST")!.body).toMatchObject({ published: false, roles: [] });
    // Telemetry: one event, ids only (no title).
    expect(t.events).toEqual([{ event: "personal-dashboard", how: "create", user: "olu", roles: [], board: r.board, data: { dashboard: r.dashboard }, at: expect.any(String) }]);
  });

  it("is copied with copies of the charts, owned by the person, with the filter bar pointed at the copies", async () => {
    const t = setup();
    const src = t.superset.official("Campaign", [ADMIN.userId], [KPI, VISITS]);
    const r = await t.personal.copy(VIEWER, { dashboard: src.id, view: true, edit: false });
    if (!r.ok) throw new Error(r.error);
    expect(r.title).toBe("Campaign (my copy)");
    // The copy carries none of the original's dashboard roles, and starts as a draft.
    expect(t.superset.writes.find((w) => w.method === "PUT" && w.path === `/api/v1/dashboard/${r.dashboard}`)!.body).toMatchObject({ published: false, roles: [] });
    expect(t.events.at(-1)).toMatchObject({ event: "personal-dashboard", how: "copy", data: { dashboard: r.dashboard, from: src.id, charts: 2 } });
    const copy = t.superset.dashes.get(r.dashboard)!;
    expect(copy.owners).toEqual([VIEWER.userId]);
    const copied = [...t.superset.charts.values()].filter((c) => c.dashboards.includes(r.dashboard));
    expect(copied).toHaveLength(2);
    // New charts, the person's own; the original's are untouched and still the original's.
    for (const c of copied) {
      expect(src.charts).not.toContain(c.id);
      expect(c.owners).toEqual([VIEWER.userId]);
    }
    for (const id of src.charts) expect(t.superset.charts.get(id)!.owners).toEqual([LENSPACK_ID]);
    expect(JSON.parse(copy.json_metadata!).native_filter_configuration[0].chartsInScope.sort()).toEqual(copied.map((c) => c.id).sort());
    // Bound, and editing it changes only the copies.
    const board = (await t.store.get(r.board))!;
    expect(Object.keys(board.config.widgets)).toHaveLength(2);
    const kpiId = Object.entries(board.config.widgets).find(([, w]) => w.title === "Stock moved")![0];
    const patched = await t.store.patch({ id: r.board, ops: [{ op: "update_widget", id: kpiId, widget: { ...KPI, title: "Stock moved (mine)" } }], catalogue: catalogueFrom(pack) });
    expect(patched.ok).toBe(true);
    expect(t.superset.charts.get(src.charts[0]!)!.slice_name).toBe("Stock moved");
  });

  it("keeps a chart that the original's layout leaves out", () => {
    const pos = completePositions({}, [11, 12]);
    expect(Object.values<any>(pos).filter((c) => c?.type === "CHART").map((c) => c.meta.chartId)).toEqual([11, 12]);
    expect(pos.GRID_ID.children).toHaveLength(1);
    const map = chartIdMap(pos, JSON.parse(JSON.stringify(pos).replaceAll('"chartId":11', '"chartId":21').replaceAll('"chartId":12', '"chartId":22')));
    expect([...map]).toEqual([[11, 21], [12, 22]]);
    expect(remapChartIds({ chart_configuration: { "11": { id: 11, crossFilters: { chartsInScope: [12] } } }, global_chart_configuration: { chartsInScope: [11, 12] } }, map)).toEqual({ chart_configuration: { "21": { id: 21, crossFilters: { chartsInScope: [22] } } }, global_chart_configuration: { chartsInScope: [21, 22] } });
  });

  it("puts a chart the layout leaves out in the first tab of a dashboard with tabs, and keeps the layout valid", () => {
    const tabbed = {
      ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["TABS-1"] },
      "TABS-1": { id: "TABS-1", type: "TABS", children: ["TAB-a", "TAB-b"], parents: ["ROOT_ID"] },
      "TAB-a": { id: "TAB-a", type: "TAB", children: ["ROW-1"], parents: ["ROOT_ID", "TABS-1"], meta: { text: "First" } },
      "TAB-b": { id: "TAB-b", type: "TAB", children: [], parents: ["ROOT_ID", "TABS-1"], meta: { text: "Second" } },
      "ROW-1": { id: "ROW-1", type: "ROW", children: ["CHART-11"], parents: ["ROOT_ID", "TABS-1", "TAB-a"], meta: {} },
      "CHART-11": { id: "CHART-11", type: "CHART", children: [], parents: ["ROOT_ID", "TABS-1", "TAB-a", "ROW-1"], meta: { chartId: 11, width: 4, height: 50 } },
    };
    const pos = completePositions(tabbed, [11, 12]);
    expect(layoutProblems(pos as LayoutPosition)).toEqual([]);
    const placed = Object.values<any>(pos).find((c) => c?.type === "CHART" && c.meta.chartId === 12);
    expect(placed.parents.slice(0, 3)).toEqual(["ROOT_ID", "TABS-1", "TAB-a"]);
  });

  it("is copied with a problem its original's layout already had, which the layout check leaves as it was", async () => {
    const t = setup();
    const src = t.superset.official("Broken", [ADMIN.userId], [KPI]);
    // A layout that lists a component that isn't there.
    t.superset.dashes.get(src.id)!.position_json = JSON.stringify({ ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["GRID_ID", "GRID_2"] }, GRID_ID: { id: "GRID_ID", type: "GRID", children: [], parents: ["ROOT_ID"] } });
    expect((await t.personal.copy(VIEWER, { dashboard: src.id, view: true, edit: false })).ok).toBe(true);
  });

  it("is removed again when Superset won't make it the person's", async () => {
    const t = setup();
    const src = t.superset.official("Campaign", [ADMIN.userId], [KPI]);
    const put = t.superset.client.put;
    t.superset.client.put = async (path, body: any) => {
      if (body?.owners && path.startsWith("/api/v1/dashboard/")) throw new Error("Superset said no");
      return put(path, body);
    };
    await expect(t.personal.copy(VIEWER, { dashboard: src.id, view: true, edit: false })).rejects.toThrow(/said no/);
    expect([...t.superset.dashes.keys()]).toEqual([src.id]);
    expect([...t.superset.charts.keys()]).toEqual(src.charts);
    expect(await t.links.list()).toEqual([]);
  });

  it("is not copied for someone who can't view the original", async () => {
    const t = setup();
    const src = t.superset.official("Campaign", [ADMIN.userId], [KPI]);
    expect(await t.personal.copy(VIEWER, { dashboard: src.id, view: false, edit: false })).toMatchObject({ ok: false, code: "no-view" });
    expect(t.superset.writes).toEqual([]);
  });

  it("is not made without the person's Superset id (an older plugin)", async () => {
    const t = setup();
    expect(await t.personal.create({ user: "olu", roles: [] }, "x")).toMatchObject({ ok: false, code: "no-user-id" });
  });

  it("is deleted by its owner with the charts made for it; another person's is refused; an admin may", async () => {
    const t = setup();
    const src = t.superset.official("Campaign", [ADMIN.userId], [KPI]);
    const mine = await t.personal.copy(OWNER, { dashboard: src.id, view: true, edit: false });
    if (!mine.ok) throw new Error();
    const copies = [...t.superset.charts.values()].filter((c) => c.dashboards.includes(mine.dashboard)).map((c) => c.id);
    // Someone else, and someone trying the official one.
    expect(await t.personal.remove(VIEWER, mine.dashboard)).toMatchObject({ ok: false, code: "not-yours" });
    expect(await t.personal.remove(OWNER, src.id)).toMatchObject({ ok: false, code: "not-yours" });
    expect(t.superset.dashes.has(mine.dashboard) && t.superset.dashes.has(src.id)).toBe(true);
    expect(t.audit.filter((a) => a.outcome === "denied")).toHaveLength(2);
    expect(await t.personal.remove(OWNER, mine.dashboard)).toMatchObject({ ok: true });
    expect(t.superset.dashes.has(mine.dashboard)).toBe(false);
    for (const c of copies) expect(t.superset.charts.has(c)).toBe(false);
    for (const c of src.charts) expect(t.superset.charts.has(c)).toBe(true);
    expect(t.dashboards[mine.board]).toBeUndefined();
    expect(await t.links.get(String(mine.dashboard))).toBeNull();
    // An admin may delete someone's.
    const theirs = await t.personal.create(VIEWER, "Theirs");
    if (!theirs.ok) throw new Error();
    expect(await t.personal.remove(ADMIN, theirs.dashboard)).toMatchObject({ ok: true });
  });

  it("stops at the per-person limit", async () => {
    const t = setup({ maxDashboardsPerUser: 2 });
    expect((await t.personal.create(OWNER, "a")).ok).toBe(true);
    expect((await t.personal.create(OWNER, "b")).ok).toBe(true);
    expect(await t.personal.create(OWNER, "c")).toMatchObject({ ok: false, code: "limit" });
    // Someone else has their own allowance.
    expect((await t.personal.create(VIEWER, "a")).ok).toBe(true);
    // One deleted in Superset no longer counts.
    const [first] = await t.personal.mineOf(OWNER);
    await t.superset.client.delete(`/api/v1/dashboard/${first!.dashboard}`);
    expect((await t.personal.create(OWNER, "c")).ok).toBe(true);
  });

  it("is refused everything when switched off", async () => {
    const t = setup({ on: false });
    expect(await t.personal.create(OWNER, "a")).toMatchObject({ ok: false, code: "off" });
    expect((await t.personal.overview(OWNER, null)).on).toBe(false);
  });
});

describe("saved layouts", () => {
  async function withBoards() {
    const t = setup();
    const src = t.superset.official("Campaign", [OWNER.userId], [KPI, VISITS]);
    const srcBoard = await t.bindBoard(src.id);
    const other = await t.personal.create(OWNER, "Scratch");
    if (!other.ok) throw new Error();
    return { ...t, src, srcBoard, other };
  }

  it("are saved, listed, renamed and deleted, each person seeing their own and an admin everyone's", async () => {
    const t = await withBoards();
    const config = (await t.store.get(t.srcBoard))!.config;
    const saved = await t.personal.saveLayout(OWNER, { dashboard: t.src.id, view: true, edit: true, board: t.srcBoard }, "Morning briefing layout", config);
    expect(saved).toMatchObject({ ok: true, name: "Morning briefing layout", replaced: false });
    const stored = (await t.layouts.list())[0]!;
    expect(stored).toMatchObject({ owner: "olu", source: { dashboard: t.src.id, title: "Campaign" }, pack: "stock", packVersion: pack.version });
    expect(Object.keys(stored.config.widgets)).toHaveLength(2);
    // Saving under the same name replaces it.
    expect(await t.personal.saveLayout(OWNER, { dashboard: t.src.id, view: true, edit: true, board: t.srcBoard }, "morning briefing layout", config)).toMatchObject({ ok: true, replaced: true });
    expect(await t.layouts.list()).toHaveLength(1);
    expect((await t.personal.overview(VIEWER, null)).layouts).toEqual([]);
    expect((await t.personal.overview(ADMIN, null)).layouts).toHaveLength(1);
    expect(await t.personal.renameLayout(VIEWER, stored.id, "Mine now")).toMatchObject({ ok: false });
    expect(await t.personal.renameLayout(OWNER, "morning", "Daily layout")).toMatchObject({ ok: true, name: "Daily layout" });
    expect(await t.personal.deleteLayout(VIEWER, "daily layout")).toMatchObject({ ok: false });
    expect(await t.personal.deleteLayout(OWNER, "daily layout")).toMatchObject({ ok: true });
    expect(await t.layouts.list()).toEqual([]);
    expect(t.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["layout-save", "layout-rename", "layout-delete"]));
  });

  it("are applied as one undoable change, with new charts on the target and none of the original's touched", async () => {
    const t = await withBoards();
    const config = (await t.store.get(t.srcBoard))!.config;
    await t.personal.saveLayout(OWNER, { dashboard: t.src.id, view: true, edit: true, board: t.srcBoard }, "Morning", config);
    const before = (await t.store.get(t.other.board))!;
    const r = await t.personal.applyLayout(OWNER, "morning", edit(t.other.board));
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ previous: before.version, version: before.version + 1, skipped: [] });
    const after = (await t.store.get(t.other.board))!;
    expect(Object.values(after.config.widgets).map((w) => w.title).sort()).toEqual(["Stock moved", "Visits"]);
    expect(after.config.title).toBe("Scratch");
    const made = [...t.superset.charts.values()].filter((c) => c.dashboards.includes(t.other.dashboard));
    expect(made).toHaveLength(2);
    // The new charts are the target's owner's, not Lenspack's account's.
    for (const c of made) expect(c.owners).toEqual([OWNER.userId]);
    for (const id of t.src.charts) expect(t.superset.charts.get(id)!.dashboards).toEqual([t.src.id]);
    expect((await t.store.versions(t.other.board))[0]!.summary).toBe("applied saved layout “Morning”");
    // Undo: back to the version before.
    await t.store.revertTo(t.other.board, r.previous);
    expect(Object.keys((await t.store.get(t.other.board))!.config.widgets)).toEqual([]);
  });

  it("are not applied to a dashboard the person can't edit", async () => {
    const t = await withBoards();
    const config = (await t.store.get(t.srcBoard))!.config;
    await t.personal.saveLayout(OWNER, { dashboard: t.src.id, view: true, edit: true, board: t.srcBoard }, "Morning", config);
    const before = (await t.store.get(t.srcBoard))!.version;
    expect(await t.personal.applyLayout(OWNER, "Morning", { board: t.srcBoard, edit: false, ctx: {} })).toMatchObject({ ok: false, code: "no-edit" });
    expect((await t.store.get(t.srcBoard))!.version).toBe(before);
    // Nor someone else's layout.
    expect(await t.personal.applyLayout(VIEWER, "Morning", edit(t.srcBoard))).toMatchObject({ ok: false, code: "missing" });
  });

  it("leave out, and name, the charts the person can't use there", async () => {
    const t = await withBoards();
    const config = (await t.store.get(t.srcBoard))!.config;
    await t.personal.saveLayout(OWNER, { dashboard: t.src.id, view: true, edit: true, board: t.srcBoard }, "Morning", config);
    // As hostPolicy: superset decides it for someone who may not read the visits dataset.
    const ctx = decide(principalOf({ user: "olu", hiddenEntities: ["visit"] }), pack, { host: {} })!.ctx;
    const r = await t.personal.applyLayout(OWNER, "Morning", { board: t.other.board, edit: true, ctx });
    if (!r.ok) throw new Error(r.error);
    expect(r.skipped).toEqual([expect.objectContaining({ title: "Visits" })]);
    expect(Object.values((await t.store.get(t.other.board))!.config.widgets).map((w) => w.title)).toEqual(["Stock moved"]);
  });

  it("stop at the per-person limit, but a save under an existing name still replaces it", async () => {
    const t = setup({ maxSavedLayoutsPerUser: 1 });
    const src = t.superset.official("Campaign", [OWNER.userId], [KPI]);
    const board = await t.bindBoard(src.id);
    const config = (await t.store.get(board))!.config;
    const here = { dashboard: src.id, view: true, edit: true, board };
    expect((await t.personal.saveLayout(OWNER, here, "One", config)).ok).toBe(true);
    expect(await t.personal.saveLayout(OWNER, here, "Two", config)).toMatchObject({ ok: false, code: "limit" });
    expect((await t.personal.saveLayout(OWNER, here, "One", config)).ok).toBe(true);
  });
});

describe("kept between restarts", () => {
  it("in a file that a second copy of the server reads too", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "lp-rec-")), "saved-layouts.json");
    const a = fileRecords<{ n: number }>(file);
    const b = fileRecords<{ n: number }>(file);
    await a.put("x", { n: 1 });
    expect(await b.get("x")).toEqual({ n: 1 });
    await b.put("y", { n: 2 });
    expect((await a.list()).map((r) => r.n).sort()).toEqual([1, 2]);
    expect(await a.delete("x")).toBe(true);
    expect(await b.get("x")).toBeNull();
  });
});

// ---- Through the chat, with a stub model.
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stream = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) });
const tool = (toolName: string, input: unknown) => [
  { type: "tool-call", toolCallId: `c${Math.random().toString(36).slice(2)}`, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const say = (text: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];
const scripted = (steps: unknown[][]) => {
  let step = 0;
  return new MockLanguageModelV4({ doStream: async () => stream(steps[step++] ?? say("Done.")) });
};

describe("in the chat", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  async function chat(name: string, who: typeof OWNER, readOnly: boolean | string, steps: unknown[][], prepare?: (t: Awaited<ReturnType<typeof setup>> & { board: string; dash: number }) => Promise<void>, byScope = false) {
    const t = setup();
    const src = t.superset.official("Campaign", [ADMIN.userId], [KPI]);
    const board = await t.bindBoard(src.id);
    await prepare?.({ ...t, board, dash: src.id });
    const host: Host = { name: "stock", pack, packYaml, connector: supersetConnector(t.superset.client, binding), store: t.store, ctx: {}, boards: [] };
    registerLlmAdapter({ kind: `mine-${name}`, defaultBaseUrl: "mock:", build: () => scripted(steps) });
    const providers: Provider[] = [{ ...buildProvider({ name, kind: `mine-${name}`, model: "m" }), available: true }];
    const app = createApp([host], {
      providers,
      review: () => false,
      access: async () => (readOnly ? { user: who.user, readOnly: typeof readOnly === "string" ? readOnly : READ_ONLY_MESSAGE } : { user: who.user, edit: true, maintain: true }),
      personal: (_req, turn) => t.personal.port(who, { dashboard: src.id, board: turn.boardId, view: true, edit: !turn.readOnly, byScope }),
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/stock/${board}/chat?model=${name}`;
    const body = await (await fetch(url, { method: "POST", body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "add a visits KPI" }] }] }) })).text();
    const outputs = body.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === "tool-output-available").map((e) => e.output);
    return { ...t, board, src, outputs };
  }

  it("offers a view-only person their own copy, and makes it on their word, carrying the change", async () => {
    const r = await chat("offer", VIEWER, true, [tool("add_widget", { id: "visits", kind: "kpi", title: "Visits", query_kind: "value", measure: "visit_total" }), tool("copy_dashboard", { title: "", then: "add a visits KPI" }), say("Made your copy.")]);
    expect(r.outputs[0]).toMatchObject({ applied: false, readOnly: true, offer: "copy_dashboard" });
    expect(r.outputs[1]).toMatchObject({ ok: true, title: "Campaign (my copy)", then: "add a visits KPI" });
    const copy = r.superset.dashes.get(r.outputs[1].dashboard)!;
    expect(copy.owners).toEqual([VIEWER.userId]);
    // The official dashboard is as it was.
    expect(Object.keys((await r.store.get(r.board))!.config.widgets)).toHaveLength(1);
  });

  it("saves and applies a layout by name, the apply refused on a dashboard the person can only view", async () => {
    const saved = await chat("save", OWNER, true, [tool("save_layout", { name: "Morning briefing layout" }), say("Saved.")]);
    expect(saved.outputs[0]).toMatchObject({ ok: true, name: "Morning briefing layout" });
    const refused = await chat("apply-ro", OWNER, true, [tool("apply_layout", { layout: "morning" }), say("No.")], async (t) => {
      await t.personal.saveLayout(OWNER, { dashboard: t.dash, view: true, edit: false, board: t.board }, "Morning", (await t.store.get(t.board))!.config);
    });
    expect(refused.outputs[0]).toMatchObject({ applied: false, readOnly: true, offer: "copy_dashboard" });
    const applied = await chat("apply", OWNER, false, [tool("apply_layout", { layout: "morning" }), say("Applied.")], async (t) => {
      const scratch = await t.personal.create(OWNER, "Scratch");
      if (!scratch.ok) throw new Error();
      const empty: BoardConfig = { ...(await t.store.get(t.board))!.config, widgets: {}, layout: [] };
      await t.personal.saveLayout(OWNER, { dashboard: t.dash, view: true, edit: true, board: t.board }, "Morning", empty);
    });
    expect(applied.outputs[0]).toMatchObject({ applied: true, layout: "Morning" });
    expect((await applied.store.versions(applied.board))[0]!.summary).toBe("applied saved layout “Morning”");
  });

  it("under editScope own, refuses an edit Superset would allow and offers a copy to edit", async () => {
    const r = await chat("own-only", OWNER, NOT_OWN_MESSAGE, [tool("add_widget", { id: "visits", kind: "kpi", title: "Visits", query_kind: "value", measure: "visit_total" }), say("Not here.")], undefined, true);
    expect(r.outputs[0]).toMatchObject({ applied: false, readOnly: true, offer: "copy_dashboard", ownOnly: true });
    expect(r.outputs[0].error).toMatch(/^On this deployment, the chat changes only dashboards of your own/);
  });

  it("makes and deletes the person's own dashboards by name, never someone else's", async () => {
    const r = await chat("make", OWNER, true, [tool("create_dashboard", { title: "Stock check" }), tool("delete_dashboard", { dashboard: "Campaign" }), tool("delete_dashboard", { dashboard: "stock check" }), say("Done.")]);
    expect(r.outputs[0]).toMatchObject({ ok: true, title: "Stock check" });
    expect(r.outputs[1]).toMatchObject({ ok: false, code: "missing" });
    expect(r.outputs[2]).toMatchObject({ ok: true, title: "Stock check" });
    expect(r.superset.dashes.has(r.src.id)).toBe(true);
  });
});
