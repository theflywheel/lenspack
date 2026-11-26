import { type BoardConfig, type LayoutItem, type Widget, boardConfigSchema } from "@lenspack/core";
import type { Pack } from "@lenspack/pack";

import type { Binding } from "./catalogue";
import type { SupersetClient } from "./client";
import { type PlacedChart, filtersFromNative, nativeFiltersAfter } from "./filters";
import { plainNote } from "./note";
import { type Component, type Position, COLUMNS, componentAt, defaultContainer, freshId, insertInRow, insertRow, isComponent, layoutProblems, locate, nestedLayout, openTab, parentMap, reachable, removeComponent, rowWidth, wrapRow } from "./layout";
import { chartToWidget, queryContextOf, widgetToChart } from "./query";

// A Superset dashboard is the board. Reading one: its charts become widgets
// (or locked text widgets, for charts lenspack cannot say exactly), its
// markdown blocks become text widgets, position_json becomes the grid, and
// its filter bar becomes the board's filters (filters.ts).
// Writing one: only what changed between two board configs is sent — new
// charts, changed charts, removed charts, then the layout, title and filters.
// A layout with tabs or columns is kept as it is and changed in place
// (patchedPosition); a flat one is written from the board's grid. Either is
// checked before it is saved (layout.ts layoutProblems).

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
  /**
   * Widget id → its CHART component in the layout. A chart placed twice is two widgets that keep
   * their ids from one read to the next, and a resize or a removal touches the one placement.
   */
  placements?: Record<string, string>;
  /** Widgets Lenspack removed, by id: what they showed and where, so restoring a version puts the same chart back in the same place. */
  removed?: Record<string, Removed>;
  changedOn?: string;
};

/** A removed widget: its chart (unless Lenspack made it and so deleted it), its component and where that sat. */
export type Removed = {
  chartId?: number;
  /** The chart was Lenspack's own and was deleted with its widget: a restore makes it again. */
  deleted?: boolean;
  locked?: boolean;
  /** The widget as it was, to tell whether a restore brings back the same one. */
  widget: string;
  component?: string;
  meta?: Record<string, any>;
  container?: string;
  blockIndex?: number;
  row?: string;
  index?: number;
  at: number;
};

/** Where an edit asked for a new widget, and the tabs the viewer had open: kept by the store between the edit and its save. */
export type PlacementHint = { place: string; tabs?: string[] };

/** Said when a move can't be written: the layout has tabs or columns, which the board's grid does not model yet. */
export const MOVE_REFUSAL =
  "This dashboard has tabs (or columns), and Lenspack can't move charts on it yet. Move the chart in Superset: Edit dashboard, then drag it. Adding, resizing, changing and removing charts work here.";

/** Removed widgets remembered per dashboard. */
const REMEMBERED = 50;

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

/**
 * The charts and notes Superset draws, in reading order: each row's children, left to right, from
 * ROOT_ID down through grids, tabs (one after another, inner ones in place) and columns.
 */
function rows(position: Position): Component[][] {
  const root = componentAt(position, "ROOT_ID") ?? componentAt(position, "GRID_ID");
  if (!root) return [];
  const out: Component[][] = [];
  const seen = new Set<string>();
  const visit = (id: string, row: Component[] | null) => {
    const c = componentAt(position, id);
    if (!c || seen.has(id)) return;
    seen.add(id);
    if (c.type === "ROW") {
      const r: Component[] = [];
      out.push(r);
      for (const k of c.children) visit(k, r);
    } else if (c.type === "CHART" || c.type === "MARKDOWN") {
      if (row) row.push(c);
      else out.push([c]);
    } else for (const k of c.children ?? []) visit(k, row);
  };
  for (const k of root.children) visit(k, null);
  return out;
}

/** A dashboard as a board config, and the state that ties its widgets to charts. */
export function dashboardToBoard(read: Awaited<ReturnType<typeof readDashboard>>, pack: Pack, binding: Binding, prior?: DashboardState): { config: BoardConfig; state: DashboardState; notes: string[] } {
  const { dash, charts, position } = read;
  const byChart = new Map(Object.entries(prior?.charts ?? {}).map(([w, c]) => [c, w]));
  const byMarkdown = new Map(Object.entries(prior?.markdown ?? {}).map(([w, m]) => [m, w]));
  const byComponent = new Map(Object.entries(prior?.placements ?? {}).map(([w, c]) => [c, w]));
  const state: DashboardState = { dashboardId: dash.id, charts: {}, created: (prior?.created ?? []).filter((c) => charts.some((x) => x.id === c)), locked: [], markdown: {}, placements: {}, removed: prior?.removed ?? {}, changedOn: dash.changed_on };
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
    const id = unique(byComponent.get(c.id) ?? byChart.get(chart.id) ?? `c${chart.id}`);
    const got = chartToWidget({ slice_name: chart.slice_name, viz_type: chart.form_data?.viz_type, params: chart.form_data ?? {}, datasource_id: Number(String(chart.form_data?.datasource ?? "").split("__")[0]) }, pack, binding);
    if (got.widget) widgets[id] = got.widget;
    else {
      // Kept as Superset has it: visible to the model by title, never rewritten.
      widgets[id] = { kind: "text", title: chart.slice_name.slice(0, 120) || `Chart ${chart.id}`, body: `Superset chart “${chart.slice_name}” (${chart.form_data?.viz_type}), kept as it is in Superset because ${got.reason}. It can be moved, resized or removed here; edit its contents in Superset.` };
      state.locked.push(id);
      notes.push(`${chart.slice_name}: ${got.reason}`);
    }
    state.charts[id] = chart.id;
    if (position[c.id] === c) state.placements![id] = c.id;
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
  // Charts on the dashboard but not drawn by its layout: Superset draws them at the bottom (of the first tab), so does this.
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

/** A widget's own width: on a packed board the last one in a row is widened to the edge, and fw keeps what it was. */
const ownWidth = (l: LayoutItem) => (l.fw !== undefined && l.fw < l.w ? l.fw : l.w);
const readingOrder = (layout: LayoutItem[]) => [...layout].sort((a, b) => a.y - b.y || a.x - b.x);

/**
 * Whether the only change is widgets swapping places (a drag, a move): no widget added, removed or
 * resized, and the reading order changed. A move can't be written into a layout with tabs yet.
 */
export function onlyMoved(before: BoardConfig, after: BoardConfig): boolean {
  const a = Object.keys(before.widgets);
  if (a.length !== Object.keys(after.widgets).length || a.some((w) => !after.widgets[w])) return false;
  const was = new Map(before.layout.map((l) => [l.i, l]));
  for (const l of after.layout) {
    const b = was.get(l.i);
    if (!b || ownWidth(b) !== ownWidth(l) || b.h !== l.h) return false;
  }
  const order = (c: BoardConfig) => readingOrder(c.layout).filter((l) => c.widgets[l.i]).map((l) => l.i).join(" ");
  return order(before) !== order(after);
}

export type PushOptions = {
  /** Where edits asked for new widgets, by widget id (the store keeps these between an edit and its save). */
  hints?: Record<string, PlacementHint>;
  /** "keep": a layout with tabs keeps its charts where they are rather than refusing a move (a restore). Default "refuse". */
  moves?: "refuse" | "keep";
  /** Told the layout once Superset has taken it. */
  written?: (position: Position) => void;
  log?: (s: string) => void;
  /** Owners for the charts it makes (a person's own dashboard: that person); absent, Lenspack's account. */
  owners?: number[];
};

/** Sends what changed between two board configs to the dashboard. Returns the updated state. */
export async function pushBoard(client: SupersetClient, before: BoardConfig, after: BoardConfig, pack: Pack, binding: Binding, given: DashboardState, logOrOptions: ((s: string) => void) | PushOptions = {}): Promise<DashboardState> {
  const o: PushOptions = typeof logOrOptions === "function" ? { log: logOrOptions } : logOrOptions;
  const log = o.log ?? (() => {});
  const owners = o.owners;
  const state: DashboardState = structuredClone(given);
  state.placements ??= {};
  state.removed ??= {};
  const dashId = state.dashboardId;
  // The layout as Superset has it now: where removed widgets sat, and what is kept.
  const { dash, position: old } = await readDashboard(client, dashId);
  const nested = nestedLayout(old);
  if (nested && o.moves !== "keep" && onlyMoved(before, after)) throw new Error(MOVE_REFUSAL);
  const ids = new Set([...Object.keys(before.widgets), ...Object.keys(after.widgets)]);
  const dropped: string[] = [];
  const restored: Record<string, Removed> = {};
  const made: number[] = [];
  const shared = (chartId: number, but: string) => Object.entries(state.charts).some(([w, c]) => c === chartId && w !== but && after.widgets[w]);
  // Charts first: a new chart needs its id before the layout can name it.
  for (const id of ids) {
    const was = before.widgets[id];
    const now = after.widgets[id];
    let chartId = state.charts[id];
    if (!now) {
      const component = state.placements[id] ?? state.markdown[id];
      const at = component ? locate(old, component) : null;
      // A chart placed twice keeps its other placement, and so its chart.
      const deleted = !!chartId && state.created.includes(chartId) && !shared(chartId, id);
      if (deleted) {
        await client.delete(`/api/v1/chart/${chartId}`).catch((e) => log(`could not delete chart ${chartId}: ${e.message}`));
        state.created = state.created.filter((c) => c !== chartId);
      }
      if (was) {
        state.removed[id] = {
          ...(chartId ? { chartId } : {}),
          ...(deleted ? { deleted } : {}),
          ...(state.locked.includes(id) ? { locked: true } : {}),
          widget: JSON.stringify(was),
          ...(component ? { component, meta: componentAt(old, component)?.meta } : {}),
          ...(at ? { container: at.container, blockIndex: at.blockIndex, ...(at.row ? { row: at.row, index: at.index } : {}) } : {}),
          at: Date.now(),
        };
      }
      if (component) dropped.push(component);
      delete state.charts[id];
      delete state.markdown[id];
      delete state.placements[id];
      state.locked = state.locked.filter((l) => l !== id);
      continue;
    }
    // Back after Lenspack removed it (a restore): the same chart, or note, where it was.
    const gone = !was ? state.removed[id] : undefined;
    if (gone) {
      restored[id] = gone;
      delete state.removed[id];
      if (!chartId && gone.chartId && !gone.deleted && (await chartExists(client, gone.chartId))) {
        chartId = state.charts[id] = gone.chartId;
        if (gone.locked) state.locked.push(id);
        log(`chart ${chartId} back on the dashboard as ${id}`);
        // As it was: nothing to write, and the author's formats stay.
        if (gone.widget === JSON.stringify(now) || gone.locked) continue;
      } else if (!chartId && !gone.chartId && gone.component && now.kind === "text") state.markdown[id] = gone.component;
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
      const created = await client.post<{ id: number }>("/api/v1/chart", { ...body, dashboards: [dashId], ...(owners?.length ? { owners } : {}) });
      state.charts[id] = created.id;
      state.created.push(created.id);
      made.push(created.id);
      log(`chart ${created.id} ← new ${id}`);
    }
  }
  const removed = Object.entries(state.removed).sort((a, b) => b[1].at - a[1].at).slice(0, REMEMBERED);
  state.removed = Object.fromEntries(removed);

  // Then the dashboard: title, layout, and its chart list (Superset reads that from positions).
  const position = nested ? patchedPosition(old, before, after, state, { dropped, restored, hints: o.hints ?? {}, known: new Set(Object.values(given.charts)), knownMarkdown: new Set(Object.values(given.markdown)) }) : gridPosition(old, after, state, restored);
  // Never a layout Superset can't draw. Problems it already had are left as they were.
  const had = new Set(layoutProblems(old));
  const wrong = layoutProblems(position).filter((p) => !had.has(p));
  if (wrong.length) {
    for (const c of made) await client.delete(`/api/v1/chart/${c}`).catch(() => {});
    log(`layout refused: ${wrong.join("; ")}`);
    throw new Error(`the dashboard layout this change would save is not valid (${wrong.slice(0, 3).join("; ")}), so nothing was saved to the layout`);
  }
  for (const p of had) log(`layout already had a problem, left as it is: ${p}`);
  // Parsed strictly: a json_metadata that is not JSON is refused, never overwritten.
  const meta = dash.json_metadata ? JSON.parse(dash.json_metadata) : {};
  const charts = placedCharts(position, [...new Set(Object.values(state.charts))]);
  const filters = nativeFiltersAfter(meta, before.filters, after.filters, { pack, binding, charts, chartOf: (w) => state.charts[w] });
  if (filters) log(`filter bar now has ${filters.length} entr${filters.length === 1 ? "y" : "ies"}`);
  const body: Record<string, unknown> = { position_json: JSON.stringify(position), json_metadata: JSON.stringify({ ...meta, positions: position, ...(filters ? { native_filter_configuration: filters } : {}) }) };
  if (before.title !== after.title || dash.dashboard_title !== after.title) body.dashboard_title = after.title;
  await client.put(`/api/v1/dashboard/${dashId}`, body);
  o.written?.(position);
  const fresh = await client.get<{ result: { changed_on: string } }>(`/api/v1/dashboard/${dashId}`);
  state.changedOn = fresh.result.changed_on;
  return state;
}

/** Whether Superset still has this chart (a removed widget's chart, before it is put back). */
async function chartExists(client: SupersetClient, id: number) {
  try {
    await client.get(`/api/v1/chart/${id}`);
    return true;
  } catch {
    return false;
  }
}

function component(id: string, type: string, parents: string[], meta?: Record<string, unknown>): Component {
  return { id, type, children: [], parents, ...(meta ? { meta } : {}) };
}

/** A widget's component: its chart's (the one it had, or the one it had before it was removed), or its note's. */
function widgetComponent(widgetId: string, config: BoardConfig, state: DashboardState, old: Position, parents: string[], l: { w: number; h: number }, was?: Removed): Component | null {
  const widget = config.widgets[widgetId]!;
  const chartId = state.charts[widgetId];
  if (chartId) {
    const placed = componentAt(old, state.placements?.[widgetId]);
    const prev = placed?.type === "CHART" && placed.meta?.chartId === chartId ? placed : Object.values(old).find((c): c is Component => isComponent(c) && c.type === "CHART" && c.meta?.chartId === chartId);
    const size = was?.meta && was.chartId === chartId ? { width: was.meta.width ?? l.w, height: was.meta.height ?? toSupersetH(l.h) } : { width: l.w, height: toSupersetH(l.h) };
    const id = prev?.id ?? (was?.component && was.chartId === chartId && !(was.component in old) ? was.component : `CHART-lp-${chartId}`);
    return { ...component(id, "CHART", parents), meta: { ...(was?.chartId === chartId ? (was.meta ?? {}) : {}), ...(prev?.meta ?? {}), chartId, ...size, sliceName: widget.title } };
  }
  if (widget.kind === "text") {
    const id = state.markdown[widgetId] ?? `MARKDOWN-lp-${widgetId}`;
    // A block someone wrote in Superset keeps its text while the note is unchanged (it is read
    // cut to 2000 characters); a note Lenspack wrote or changed is made plain (note.ts).
    const had = componentAt(old, id)?.meta?.code;
    const code = typeof had === "string" && had.slice(0, 2000) === widget.body ? had : plainNote(widget.body);
    return { ...component(id, "MARKDOWN", parents), meta: { width: l.w, height: toSupersetH(l.h), code } };
  }
  return null;
}

/** A flat grid: rows by y, left to right. */
function gridPosition(old: Position, config: BoardConfig, state: DashboardState, restored: Record<string, Removed> = {}): Position {
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
      if (used + l.w > COLUMNS && cur.length) {
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
      // The board's grid is the layout here: the size is the board's, whatever the chart had before.
      const was = restored[l.i];
      const c = widgetComponent(l.i, config, state, old, ["ROOT_ID", "GRID_ID", rowId], l, was ? { ...was, meta: { ...was.meta, width: l.w, height: toSupersetH(l.h) } } : undefined);
      if (!c) continue;
      // A chart placed twice: each placement its own component.
      if (pos[c.id]) c.id = freshId(pos, c.id);
      pos[c.id] = c;
      r.children.push(c.id);
      if (state.charts[l.i]) state.placements![l.i] = c.id;
    }
    if (r.children.length) {
      pos[rowId] = r;
      (pos.GRID_ID as Component).children.push(rowId);
    }
  }
  return pos;
}

type PatchInputs = {
  /** Components of the widgets this change removed. */
  dropped: string[];
  /** Widgets this change brings back, with where they were. */
  restored: Record<string, Removed>;
  hints: Record<string, PlacementHint>;
  /** Chart ids and note components the state knew before this change (a state from before placements were kept). */
  known: Set<number>;
  knownMarkdown: Set<string>;
};

/**
 * Tabs or columns: the layout is kept and changed in place. Removed widgets' components go (and
 * rows they leave empty); a resized widget's component takes its new size where it is (a row
 * then wider than 12 columns wraps); a widget Superset doesn't draw (new, restored, or under a
 * part ROOT_ID doesn't reach) is placed: where it was before it was removed; else after or below
 * the widget its edit named; else at the top or bottom of the tab the viewer had open; else where
 * Superset draws charts that have no place, the first top-level tab or the grid.
 */
export function patchedPosition(old: Position, before: BoardConfig, after: BoardConfig, state: DashboardState, o: PatchInputs): Position {
  const pos: Position = structuredClone(old);
  const placements = (state.placements ??= {});
  const componentOf = (w: string): string | undefined => placements[w] ?? state.markdown[w];
  const kept = new Set(Object.keys(after.widgets).map(componentOf).filter((c): c is string => !!c));
  const keptCharts = new Set(Object.entries(state.charts).filter(([w]) => after.widgets[w]).map(([, c]) => c));
  const drop = new Set(o.dropped);
  const parents = parentMap(pos);
  for (const [k, c] of Object.entries(old)) {
    if (!isComponent(c) || kept.has(k) || !pos[k]) continue;
    const gone =
      drop.has(k) ||
      (c.type === "CHART" && o.known.has(c.meta?.chartId) && !keptCharts.has(c.meta?.chartId)) ||
      (c.type === "MARKDOWN" && o.knownMarkdown.has(k) && !Object.values(state.markdown).includes(k));
    if (!gone) continue;
    removeComponent(pos, k);
    const row = parents.get(k);
    const r = componentAt(pos, row ?? undefined);
    if (r?.type === "ROW" && r.children.length === 0) removeComponent(pos, r.id);
  }

  // Resized where it stands.
  const was = new Map(before.layout.map((l) => [l.i, l]));
  const holder = parentMap(pos);
  const drawn = new Set(holder.keys());
  const resized = new Set<string>();
  for (const l of after.layout) {
    const b = was.get(l.i);
    const id = componentOf(l.i);
    const c = componentAt(pos, id);
    if (!b || !c || !drawn.has(c.id)) continue;
    if (ownWidth(b) !== ownWidth(l)) c.meta = { ...(c.meta ?? {}), width: Math.max(1, Math.min(COLUMNS, ownWidth(l))) };
    if (b.h !== l.h) c.meta = { ...(c.meta ?? {}), height: toSupersetH(l.h) };
    if (ownWidth(b) !== ownWidth(l) || b.h !== l.h) resized.add(holder.get(c.id) ?? "");
  }
  for (const row of resized) if (componentAt(pos, row)?.type === "ROW") wrapRow(pos, row);

  // Placed: every widget Superset would not draw.
  for (const l of readingOrder(after.layout)) {
    if (!after.widgets[l.i]) continue;
    const id = componentOf(l.i);
    if (id && reachable(pos).has(id)) continue;
    if (id && componentAt(pos, id)) removeComponent(pos, id);
    // Copies of its chart that Superset doesn't draw (under the grid top-level tabs left behind) go: it is placed where it is seen.
    const chartId = state.charts[l.i];
    const seen = reachable(pos);
    if (chartId) for (const [k, x] of Object.entries(pos)) if (isComponent(x) && x.type === "CHART" && x.meta?.chartId === chartId && !seen.has(k)) removeComponent(pos, k);
    const back = o.restored[l.i];
    const c = widgetComponent(l.i, after, state, old, [], { w: ownWidth(l), h: l.h }, back);
    if (!c) continue;
    if (c.id in pos) c.id = freshId(pos, c.id);
    placeComponent(pos, c, back, o.hints[l.i], componentOf);
    if (state.charts[l.i]) placements[l.i] = c.id;
  }
  if (isComponent(pos.HEADER_ID)) pos.HEADER_ID.meta = { ...(pos.HEADER_ID.meta ?? {}), text: after.title };
  return pos;
}

/** Puts a widget's component into the layout (see patchedPosition for the order of preference). */
function placeComponent(pos: Position, c: Component, back: Removed | undefined, hint: PlacementHint | undefined, componentOf: (w: string) => string | undefined) {
  const width = Number(c.meta?.width ?? 4);
  const drawn = reachable(pos);
  if (back?.row && drawn.has(back.row) && rowWidth(pos, back.row) + width <= COLUMNS) return insertInRow(pos, back.row, c, back.index);
  if (back?.container && drawn.has(back.container)) return void insertRow(pos, back.container, [c], back.blockIndex);
  const m = /^(after|below):(.+)$/.exec(hint?.place ?? "");
  const anchor = m ? componentOf(m[2]!) : undefined;
  const at = anchor && drawn.has(anchor) ? locate(pos, anchor) : null;
  if (m && at) {
    if (m[1] === "after" && at.row && rowWidth(pos, at.row) + width <= COLUMNS) return insertInRow(pos, at.row, c, (at.index ?? -1) + 1);
    return void insertRow(pos, at.container, [c], at.blockIndex + 1);
  }
  const container = openTab(pos, hint?.tabs) ?? defaultContainer(pos) ?? "GRID_ID";
  insertRow(pos, container, [c], hint?.place === "top" ? 0 : undefined);
}
