import { type BoardConfig, type LayoutItem, type Widget, boardConfigSchema } from "@lenspack/core";
import type { Pack } from "@lenspack/pack";

import type { Binding } from "./catalogue";
import type { SupersetClient } from "./client";
import { type PlacedChart, filtersFromNative, nativeFiltersAfter } from "./filters";
import { chartToWidget, queryContextOf, widgetToChart } from "./query";

// A Superset dashboard is the board. Reading one: its charts become widgets
// (or locked text widgets, for charts lenspack cannot say exactly), its
// markdown blocks become text widgets, position_json becomes the grid, and
// its filter bar becomes the board's filters (filters.ts).
// Writing one: only what changed between two board configs is sent — new
// charts, changed charts, removed charts, then the layout, title and filters.

/** What lenspack remembers about one dashboard between reads: which widget is which chart. */
export type DashboardState = {
  dashboardId: number;
  /** Widget id → chart id. */
  charts: Record<string, number>;
  /** Charts lenspack created (deleted from Superset when their widget is removed). */
  created: number[];
  /** Widgets standing in for charts lenspack cannot edit. */
  locked: string[];
  /** Widget id → markdown component id. */
  markdown: Record<string, string>;
  changedOn?: string;
};

type Component = { id: string; type: string; children: string[]; parents?: string[]; meta?: Record<string, any> };
type Position = Record<string, Component | string>;
type DashboardChart = { id: number; slice_name: string; form_data: Record<string, any> };

const UNIT_PX = 8; // Superset's GRID_BASE_UNIT
// One lenspack grid row in Superset pixels: its 40px row plus the margin around it,
// so a lenspack chart (7 rows) is about a Superset default chart (50 units).
const ROW_PX = 56;
const toLensH = (h: number) => Math.max(1, Math.min(20, Math.round((h * UNIT_PX) / ROW_PX)));
const toSupersetH = (h: number) => Math.max(8, Math.round((h * ROW_PX) / UNIT_PX));
const widgetIdFor = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40) || "w";

export async function readDashboard(client: SupersetClient, id: number) {
  const [{ result: dash }, { result: charts }] = await Promise.all([
    client.get<{ result: { id: number; dashboard_title: string; position_json: string | null; json_metadata: string | null; changed_on: string } }>(`/api/v1/dashboard/${id}`),
    client.get<{ result: DashboardChart[] }>(`/api/v1/dashboard/${id}/charts`),
  ]);
  const position: Position = dash.position_json ? JSON.parse(dash.position_json) : {};
  return { dash, charts, position };
}

/** Components under the grid in reading order: each row's children, left to right. */
function rows(position: Position): Component[][] {
  const grid = position.GRID_ID as Component | undefined;
  if (!grid) return [];
  const out: Component[][] = [];
  const visit = (id: string, row: Component[] | null) => {
    const c = position[id] as Component | undefined;
    if (!c || typeof c !== "object") return;
    if (c.type === "ROW") {
      const r: Component[] = [];
      out.push(r);
      for (const k of c.children) visit(k, r);
    } else if (c.type === "CHART" || c.type === "MARKDOWN") {
      if (row) row.push(c);
      else out.push([c]);
    } else for (const k of c.children ?? []) visit(k, row);
  };
  for (const k of grid.children) visit(k, null);
  return out;
}

/** Whether the layout has tabs or columns, which lenspack's grid does not model: then layout writes only append and remove. */
const nested = (position: Position) => Object.values(position).some((c) => typeof c === "object" && (c.type === "TABS" || c.type === "TAB" || c.type === "COLUMN"));

/** A dashboard as a board config, and the state that ties its widgets to charts. */
export function dashboardToBoard(read: Awaited<ReturnType<typeof readDashboard>>, pack: Pack, binding: Binding, prior?: DashboardState): { config: BoardConfig; state: DashboardState; notes: string[] } {
  const { dash, charts, position } = read;
  const byChart = new Map(Object.entries(prior?.charts ?? {}).map(([w, c]) => [c, w]));
  const byMarkdown = new Map(Object.entries(prior?.markdown ?? {}).map(([w, m]) => [m, w]));
  const state: DashboardState = { dashboardId: dash.id, charts: {}, created: (prior?.created ?? []).filter((c) => charts.some((x) => x.id === c)), locked: [], markdown: {}, changedOn: dash.changed_on };
  const widgets: Record<string, Widget> = {};
  const layout: LayoutItem[] = [];
  const notes: string[] = [];
  const used = new Set<string>();
  const unique = (id: string) => {
    let k = id;
    for (let i = 2; used.has(k); i++) k = `${id.slice(0, 37)}-${i}`;
    used.add(k);
    return k;
  };
  const chartById = new Map(charts.map((c) => [c.id, c]));
  const place = (c: Component, x: number, y: number): number => {
    const w = Math.max(1, Math.min(12, c.meta?.width ?? 4));
    const h = toLensH(c.meta?.height ?? 50);
    if (c.type === "MARKDOWN") {
      const id = unique(byMarkdown.get(c.id) ?? widgetIdFor(`md-${c.id.replace(/^MARKDOWN-/, "")}`));
      widgets[id] = { kind: "text", title: "Note", body: String(c.meta?.code ?? "").slice(0, 2000) };
      state.markdown[id] = c.id;
      layout.push({ i: id, x, y, w, h });
      return h;
    }
    const chart = chartById.get(c.meta?.chartId);
    if (!chart) return 0;
    const id = unique(byChart.get(chart.id) ?? `c${chart.id}`);
    const got = chartToWidget({ slice_name: chart.slice_name, viz_type: chart.form_data?.viz_type, params: chart.form_data ?? {}, datasource_id: Number(String(chart.form_data?.datasource ?? "").split("__")[0]) }, pack, binding);
    if (got.widget) widgets[id] = got.widget;
    else {
      // Kept as Superset has it: visible to the model by title, never rewritten.
      widgets[id] = { kind: "text", title: chart.slice_name.slice(0, 120) || `Chart ${chart.id}`, body: `Superset chart “${chart.slice_name}” (${chart.form_data?.viz_type}), kept as it is in Superset because ${got.reason}. It can be moved, resized or removed here; edit its contents in Superset.` };
      state.locked.push(id);
      notes.push(`${chart.slice_name}: ${got.reason}`);
    }
    state.charts[id] = chart.id;
    layout.push({ i: id, x, y, w, h });
    return h;
  };
  let y = 0;
  const placed = new Set<number>();
  for (const row of rows(position)) {
    let x = 0;
    let tallest = 0;
    for (const c of row) {
      if (x + (c.meta?.width ?? 4) > 12) {
        y += tallest;
        x = 0;
        tallest = 0;
      }
      tallest = Math.max(tallest, place(c, x, y));
      if (c.type === "CHART") placed.add(c.meta?.chartId);
      x += Math.max(1, Math.min(12, c.meta?.width ?? 4));
    }
    y += tallest;
  }
  // Charts on the dashboard but not in its layout: Superset draws them at the bottom, so does this.
  let x = 0;
  for (const chart of charts.filter((c) => !placed.has(c.id))) {
    if (x + 4 > 12) {
      x = 0;
      y += 10;
    }
    place({ id: `CHART-${chart.id}`, type: "CHART", children: [], meta: { chartId: chart.id, width: 4, height: 50 } }, x, y);
    x += 4;
  }
  const widgetOf = new Map(Object.entries(state.charts).map(([w, c]) => [c, w]));
  const filters = filtersFromNative(metadata(dash.json_metadata), binding, placedCharts(position, charts.map((c) => c.id)), widgetOf);
  const config = boardConfigSchema.parse({ version: 2, pack: pack.pack, packVersion: pack.version, title: dash.dashboard_title.slice(0, 160) || `Dashboard ${dash.id}`, grid: { cols: 12, rowHeight: 40, fill: true }, layout, widgets, filters });
  return { config, state, notes };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** json_metadata as an object; one that is missing or not JSON reads as empty. */
function metadata(json: string | null): Record<string, unknown> {
  try {
    const v = json ? JSON.parse(json) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Every chart on the dashboard with the layout components above it; one not in the layout sits under none. */
function placedCharts(position: Position, ids: number[]): PlacedChart[] {
  const parents = new Map<number, string[]>();
  for (const c of Object.values(position)) if (typeof c === "object" && c.type === "CHART" && typeof c.meta?.chartId === "number") parents.set(c.meta.chartId, c.parents ?? []);
  return ids.map((id) => ({ id, parents: parents.get(id) ?? [] }));
}

/** Sends what changed between two board configs to the dashboard. Returns the updated state. */
export async function pushBoard(client: SupersetClient, before: BoardConfig, after: BoardConfig, pack: Pack, binding: Binding, given: DashboardState, log: (s: string) => void = () => {}, owners?: number[]): Promise<DashboardState> {
  const state: DashboardState = structuredClone(given);
  const dashId = state.dashboardId;
  const ids = new Set([...Object.keys(before.widgets), ...Object.keys(after.widgets)]);
  // Charts first: a new chart needs its id before the layout can name it.
  for (const id of ids) {
    const was = before.widgets[id];
    const now = after.widgets[id];
    const chartId = state.charts[id];
    if (!now) {
      if (chartId && state.created.includes(chartId)) {
        await client.delete(`/api/v1/chart/${chartId}`).catch((e) => log(`could not delete chart ${chartId}: ${e.message}`));
        state.created = state.created.filter((c) => c !== chartId);
      }
      delete state.charts[id];
      delete state.markdown[id];
      state.locked = state.locked.filter((l) => l !== id);
      continue;
    }
    if (now.kind === "text" && !chartId) {
      if (!state.markdown[id]) state.markdown[id] = `MARKDOWN-lp-${id}`;
      continue;
    }
    if (state.locked.includes(id)) {
      // Only its title can travel; its contents are Superset's.
      if (was && was.title !== now.title && chartId) await client.put(`/api/v1/chart/${chartId}`, { slice_name: now.title });
      continue;
    }
    if (was && same(was, now) && chartId) continue;
    // A rename only renames: rewriting the chart would replace the formats and options
    // Superset's author chose with the ones Lenspack would pick.
    if (was && chartId && was.title !== now.title && same({ ...was, title: now.title }, now)) {
      await client.put(`/api/v1/chart/${chartId}`, { slice_name: now.title });
      log(`chart ${chartId} renamed`);
      continue;
    }
    const spec = widgetToChart(now, pack, binding);
    if (!spec) continue;
    const body = { slice_name: now.title, viz_type: spec.viz_type, params: JSON.stringify(spec.params), query_context: queryContextOf(spec) === null ? null : JSON.stringify(queryContextOf(spec)), datasource_id: spec.datasetId, datasource_type: "table" };
    if (chartId) {
      await client.put(`/api/v1/chart/${chartId}`, body);
      log(`chart ${chartId} ← ${id}`);
    } else {
      // On a person's own dashboard, a new chart is theirs in Superset too (else it would be Lenspack's account's).
      const made = await client.post<{ id: number }>("/api/v1/chart", { ...body, dashboards: [dashId], ...(owners?.length ? { owners } : {}) });
      state.charts[id] = made.id;
      state.created.push(made.id);
      log(`chart ${made.id} ← new ${id}`);
    }
  }

  // Then the dashboard: title, layout, and its chart list (Superset reads that from positions).
  const { dash, position: old } = await readDashboard(client, dashId);
  const position = nested(old) ? patchedPosition(old, after, state) : gridPosition(old, after, state);
  // Parsed strictly: a json_metadata that is not JSON is refused, never overwritten.
  const meta = dash.json_metadata ? JSON.parse(dash.json_metadata) : {};
  const charts = placedCharts(position, [...new Set(Object.values(state.charts))]);
  const filters = nativeFiltersAfter(meta, before.filters, after.filters, { pack, binding, charts, chartOf: (w) => state.charts[w] });
  if (filters) log(`filter bar now has ${filters.length} entr${filters.length === 1 ? "y" : "ies"}`);
  const body: Record<string, unknown> = { position_json: JSON.stringify(position), json_metadata: JSON.stringify({ ...meta, positions: position, ...(filters ? { native_filter_configuration: filters } : {}) }) };
  if (before.title !== after.title || dash.dashboard_title !== after.title) body.dashboard_title = after.title;
  await client.put(`/api/v1/dashboard/${dashId}`, body);
  const fresh = await client.get<{ result: { changed_on: string } }>(`/api/v1/dashboard/${dashId}`);
  state.changedOn = fresh.result.changed_on;
  return state;
}

function component(id: string, type: string, parents: string[], meta?: Record<string, unknown>): Component {
  return { id, type, children: [], parents, ...(meta ? { meta } : {}) };
}

function widgetComponent(widgetId: string, config: BoardConfig, state: DashboardState, old: Position, parents: string[], l: { w: number; h: number }): Component | null {
  const widget = config.widgets[widgetId]!;
  const chartId = state.charts[widgetId];
  if (chartId) {
    const prev = Object.values(old).find((c): c is Component => typeof c === "object" && c.type === "CHART" && c.meta?.chartId === chartId);
    return { ...component(prev?.id ?? `CHART-lp-${chartId}`, "CHART", parents), meta: { ...(prev?.meta ?? {}), chartId, width: l.w, height: toSupersetH(l.h), sliceName: widget.title } };
  }
  if (widget.kind === "text") {
    const id = state.markdown[widgetId] ?? `MARKDOWN-lp-${widgetId}`;
    return { ...component(id, "MARKDOWN", parents), meta: { width: l.w, height: toSupersetH(l.h), code: widget.body } };
  }
  return null;
}

/** A flat grid: rows by y, left to right. */
function gridPosition(old: Position, config: BoardConfig, state: DashboardState): Position {
  const pos: Position = {
    DASHBOARD_VERSION_KEY: "v2",
    ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["GRID_ID"] },
    GRID_ID: { id: "GRID_ID", type: "GRID", children: [], parents: ["ROOT_ID"] },
    HEADER_ID: { id: "HEADER_ID", type: "HEADER", children: [], meta: { text: config.title } },
  };
  const items = config.layout.filter((l) => config.widgets[l.i]).sort((a, b) => a.y - b.y || a.x - b.x);
  const byRow = new Map<number, LayoutItem[]>();
  for (const l of items) byRow.set(l.y, [...(byRow.get(l.y) ?? []), l]);
  // A Superset row holds at most 12 columns: a row that would overflow wraps.
  const rowsOut: LayoutItem[][] = [];
  for (const [, row] of [...byRow].sort((a, b) => a[0] - b[0])) {
    let cur: LayoutItem[] = [];
    let used = 0;
    for (const l of row) {
      if (used + l.w > 12 && cur.length) {
        rowsOut.push(cur);
        cur = [];
        used = 0;
      }
      cur.push(l);
      used += l.w;
    }
    if (cur.length) rowsOut.push(cur);
  }
  let n = 0;
  for (const row of rowsOut) {
    const rowId = `ROW-lp-${++n}`;
    const r: Component = { ...component(rowId, "ROW", ["ROOT_ID", "GRID_ID"]), meta: { background: "BACKGROUND_TRANSPARENT" } };
    for (const l of row) {
      const c = widgetComponent(l.i, config, state, old, ["ROOT_ID", "GRID_ID", rowId], l);
      if (!c) continue;
      pos[c.id] = c;
      r.children.push(c.id);
    }
    if (r.children.length) {
      pos[rowId] = r;
      (pos.GRID_ID as Component).children.push(rowId);
    }
  }
  return pos;
}

/** Tabs or columns: keep the layout, drop removed widgets, add new ones in rows at the end. */
function patchedPosition(old: Position, config: BoardConfig, state: DashboardState): Position {
  const pos: Position = structuredClone(old);
  const keepCharts = new Set(Object.entries(state.charts).filter(([w]) => config.widgets[w]).map(([, c]) => c));
  const keepMd = new Set(Object.entries(state.markdown).filter(([w]) => config.widgets[w]).map(([, m]) => m));
  for (const [k, c] of Object.entries(pos)) {
    if (typeof c !== "object") continue;
    const gone = (c.type === "CHART" && !keepCharts.has(c.meta?.chartId)) || (c.type === "MARKDOWN" && !keepMd.has(c.id));
    if (gone) delete pos[k];
  }
  for (const c of Object.values(pos)) if (typeof c === "object") c.children = (c.children ?? []).filter((k) => pos[k]);
  const present = new Set(Object.values(pos).flatMap((c) => (typeof c === "object" && c.type === "CHART" ? [c.meta?.chartId] : typeof c === "object" && c.type === "MARKDOWN" ? [c.id] : [])));
  let n = 0;
  for (const l of config.layout) {
    const chartId = state.charts[l.i];
    const md = state.markdown[l.i];
    if ((chartId && present.has(chartId)) || (md && present.has(md))) continue;
    const rowId = `ROW-lp-add-${Date.now().toString(36)}-${++n}`;
    const c = widgetComponent(l.i, config, state, old, ["ROOT_ID", "GRID_ID", rowId], l);
    if (!c) continue;
    pos[c.id] = c;
    pos[rowId] = { ...component(rowId, "ROW", ["ROOT_ID", "GRID_ID"]), children: [c.id], meta: { background: "BACKGROUND_TRANSPARENT" } };
    (pos.GRID_ID as Component).children.push(rowId);
  }
  if (typeof pos.HEADER_ID === "object") pos.HEADER_ID.meta = { ...(pos.HEADER_ID.meta ?? {}), text: config.title };
  return pos;
}
