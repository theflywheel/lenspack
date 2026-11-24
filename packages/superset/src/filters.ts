import type { Filter } from "@lenspack/core";
import type { Pack } from "@lenspack/spec";

import type { Binding } from "./catalogue";

// A dashboard's own filter bar (Superset calls them native filters, kept in
// json_metadata.native_filter_configuration) is the board's filters. A filter
// on a column the pack has as a dimension becomes a select; a time range
// becomes a date range; the rest (numeric ranges, time grains, a select on a
// column outside the pack, ...) stay exactly as Superset has them and reach
// the model as a "Superset-only filter" note, so it can say what they do and
// remove one when asked, but never rewrites one. Writing back changes only the
// filters the board changed and leaves every other key and entry as it was.

type NativeFilter = {
  id: string;
  type?: string;
  name?: string;
  filterType?: string;
  targets?: { datasetId?: number; column?: { name?: string } }[];
  controlValues?: Record<string, unknown>;
  defaultDataMask?: { extraFormData?: Record<string, unknown>; filterState?: { value?: unknown }; ownState?: unknown };
  scope?: { rootPath?: string[]; excluded?: number[] };
  [key: string]: unknown;
};

/** A chart on the dashboard, and the layout components it sits under (for filter scopes rooted at a tab). */
export type PlacedChart = { id: number; parents: string[] };

const PREFIX = "NATIVE_FILTER-";
/** The board filter id for a native filter id, and back: the same id without Superset's prefix. */
const boardId = (nativeId: string) => (nativeId.startsWith(PREFIX) ? nativeId.slice(PREFIX.length) : nativeId);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Superset's time range words for the defaults a board date range can have, both ways.
const PRESETS: [string, NonNullable<Filter["default"]>][] = [
  ["Last day", { days: 1 }],
  ["Last week", { days: 7 }],
  ["Last month", { months: 1 }],
  ["Last quarter", { months: 3 }],
  ["Last year", { months: 12 }],
];
const BACK = /^DATEADD\(DATETIME\("today"\), -(\d+), (day|month)\) : today$/;

/** A Superset time range as a board date range default: undefined for none, null for one a board cannot hold. */
function timeDefault(v: unknown): Filter["default"] | undefined | null {
  if (v === undefined || v === null || v === "" || v === "No filter") return undefined;
  if (typeof v !== "string") return null;
  const preset = PRESETS.find(([s]) => s === v);
  if (preset) return preset[1];
  const m = BACK.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "day" ? (n <= 3660 ? { days: n } : null) : n <= 60 ? { months: n } : null;
}

function timeRange(d: NonNullable<Filter["default"]>): string {
  const preset = PRESETS.find(([, p]) => same(p, d));
  if (preset) return preset[0];
  return d.months ? `DATEADD(DATETIME("today"), -${d.months}, month) : today` : `DATEADD(DATETIME("today"), -${d.days}, day) : today`;
}

/** The charts a native filter's scope covers: those under its root (every chart for the dashboard root), less the excluded. */
function inScope(scope: NativeFilter["scope"], charts: PlacedChart[]): Set<number> {
  const root = scope?.rootPath ?? ["ROOT_ID"];
  const excluded = new Set(scope?.excluded ?? []);
  return new Set(charts.filter((c) => !excluded.has(c.id) && (root.includes("ROOT_ID") || c.parents.some((p) => root.includes(p)))).map((c) => c.id));
}

/** The board filters a dashboard's filter bar stands for. `widgetOf` maps chart ids to widget ids. */
export function filtersFromNative(meta: Record<string, unknown>, binding: Binding, charts: PlacedChart[], widgetOf: Map<number, string>): Filter[] {
  const config = Array.isArray(meta.native_filter_configuration) ? (meta.native_filter_configuration as NativeFilter[]) : [];
  const out: Filter[] = [];
  for (const nf of config) {
    // Section headings in the filter bar: kept on write, not filters.
    if (!nf || typeof nf.id !== "string" || nf.type === "DIVIDER") continue;
    const label = (String(nf.name ?? "").trim() || nf.id).slice(0, 120);
    const target = nf.targets?.[0];
    const column = target?.column?.name;
    const entity = target?.datasetId === undefined ? undefined : binding.entityOf.get(target.datasetId);
    const field = entity && column ? binding.dimensionOf.get(entity)?.get(column) : undefined;
    const value = nf.defaultDataMask?.filterState?.value;
    const controls = nf.controlValues ?? {};
    const covered = [...inScope(nf.scope, charts)].flatMap((c) => (widgetOf.has(c) ? [widgetOf.get(c)!] : []));
    const applies = covered.length === widgetOf.size ? ["*"] : covered;
    const kept = (what: string): Filter => ({
      id: boardId(nf.id),
      type: "host",
      label,
      field: field ?? "",
      applies: ["*"],
      note: `Superset-only filter: “${label}”, ${what}. It stays as Superset has it: it can be removed here, but changed only in Superset.`.slice(0, 400),
    });
    const on = column ? `of ${column}` : "";
    if (!applies.length) {
      out.push(kept(`which applies to no chart on this dashboard`));
      continue;
    }
    if (nf.filterType === "filter_select") {
      if (!field) out.push(kept(`a list of values ${on || "of a column"}, which this data pack does not have`));
      else if ((nf.targets?.length ?? 0) > 1) out.push(kept(`a list of values read from several datasets`));
      else if (controls.inverseSelection) out.push(kept(`which leaves out the values picked ${on}`));
      else if (controls.defaultToFirstItem) out.push(kept(`a list of values ${on}, set to its first value by default`));
      else {
        const values = Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined).map(String).slice(0, 100) : [];
        out.push({ id: boardId(nf.id), type: "select", label, field, applies, ...(values.length ? { default: { values } } : {}) });
      }
    } else if (nf.filterType === "filter_time") {
      const def = timeDefault(value ?? nf.defaultDataMask?.extraFormData?.time_range);
      if (def === null) out.push(kept(`a time range, set to “${String(value)}” by default`));
      else out.push({ id: boardId(nf.id), type: "daterange", label, field: "time", applies, ...(def ? { default: def } : {}) });
    } else if (nf.filterType === "filter_range") {
      const [lo, hi] = Array.isArray(value) ? value : [];
      out.push(kept(`a range of values ${on || "of a number"}${lo != null || hi != null ? `, set to ${lo ?? "any"} to ${hi ?? "any"} by default` : ""}`));
    } else if (nf.filterType === "filter_timegrain") out.push(kept(`which picks the time grain (day, week, month...) charts are grouped by${value ? `, set to ${String(value)} by default` : ""}`));
    else if (nf.filterType === "filter_timecolumn") out.push(kept(`which picks the time column charts use${value ? `, set to ${String(value)} by default` : ""}`));
    else out.push(kept(`a filter of the kind Superset calls ${nf.filterType ?? "unknown"}`));
  }
  return out;
}

export type FilterWriteContext = {
  pack: Pack;
  binding: Binding;
  /** Every chart on the dashboard after the write, with where it sits. */
  charts: PlacedChart[];
  /** Widget id → chart id. */
  chartOf: (widget: string) => number | undefined;
};

/**
 * The dashboard's native filters after the board's filters changed from `before` to `after`, or null when
 * nothing about them changed. A filter the board did not change is kept exactly, byte for byte, unless the
 * charts it covers changed; one the board never had (a section heading, one added in Superset meanwhile) is
 * kept too.
 */
export function nativeFiltersAfter(meta: Record<string, unknown>, before: Filter[], after: Filter[], ctx: FilterWriteContext): NativeFilter[] | null {
  const old = Array.isArray(meta.native_filter_configuration) ? (meta.native_filter_configuration as NativeFilter[]) : [];
  const was = new Map(before.map((f) => [f.id, f]));
  const now = new Map(after.map((f) => [f.id, f]));
  let changed = false;
  const out: NativeFilter[] = [];
  for (const nf of old) {
    const id = nf && typeof nf.id === "string" ? boardId(nf.id) : null;
    const b = id === null ? undefined : was.get(id);
    const a = id === null ? undefined : now.get(id);
    if (b && !a) {
      changed = true;
      continue;
    }
    if (!a || a.type === "host") {
      out.push(nf);
      continue;
    }
    const next = b && same(a, b) ? nf : patched(nf, a, b, ctx);
    const scoped = withScope(next, a, ctx);
    if (scoped !== nf) changed = true;
    out.push(scoped);
  }
  const known = new Set(old.map((nf) => (nf && typeof nf.id === "string" ? boardId(nf.id) : "")));
  for (const f of after)
    if (!known.has(f.id) && f.type !== "host") {
      out.push(withScope(created(f, ctx), f, ctx));
      changed = true;
    }
  return changed ? out : null;
}

/** A native filter the board changed: only the parts that changed are rewritten. */
function patched(nf: NativeFilter, a: Filter, b: Filter | undefined, ctx: FilterWriteContext): NativeFilter {
  const out: NativeFilter = structuredClone(nf);
  if (a.label !== b?.label) out.name = a.label;
  if (a.field !== b?.field && a.type !== "daterange") out.targets = [target(a.field, ctx)];
  if (!same(a.default, b?.default)) {
    out.defaultDataMask = { ...(nf.defaultDataMask ?? {}), ...mask(a, ctx) };
    if ((a.default?.values?.length ?? 0) > 1) out.controlValues = { ...(nf.controlValues ?? {}), multiSelect: true };
  }
  return out;
}

function created(f: Filter, ctx: FilterWriteContext): NativeFilter {
  const time = f.type === "daterange";
  return {
    id: `${PREFIX}${f.id}`,
    type: "NATIVE_FILTER",
    name: f.label,
    filterType: time ? "filter_time" : "filter_select",
    targets: time ? [{}] : [target(f.field, ctx)],
    controlValues: time ? { enableEmptyFilter: false } : { enableEmptyFilter: false, defaultToFirstItem: false, multiSelect: true, searchAllOptions: false, inverseSelection: false },
    defaultDataMask: { ownState: {}, ...mask(f, ctx) },
    cascadeParentIds: [],
    scope: { rootPath: ["ROOT_ID"], excluded: [] },
    tabsInScope: [],
    description: "",
  };
}

/** Which dataset and column a filter on a dimension reads its values from: the dimension's first dataset. */
function target(field: string, ctx: FilterWriteContext) {
  const [entity, column] = [...(ctx.binding.columns.get(field) ?? [])][0] ?? [];
  const ds = entity ? ctx.binding.datasets.get(entity) : undefined;
  if (!ds || !column) throw new Error(`"${field}" has no Superset column for a dashboard filter`);
  return { datasetId: ds.id, column: { name: column } };
}

/** What a filter is set to before anyone picks, as Superset keeps it. */
function mask(f: Filter, ctx: FilterWriteContext): Pick<NonNullable<NativeFilter["defaultDataMask"]>, "extraFormData" | "filterState"> {
  if (f.type === "daterange") {
    const range = f.default && (f.default.months || f.default.days) ? timeRange(f.default) : null;
    return range ? { extraFormData: { time_range: range }, filterState: { value: range } } : { extraFormData: {}, filterState: {} };
  }
  const values = f.default?.values;
  if (!values?.length) return { extraFormData: {}, filterState: {} };
  const type = ctx.pack.dimensions.find((d) => d.key === f.field)?.type;
  const typed = values.map((v) => (type === "number" && Number.isFinite(Number(v)) ? Number(v) : type === "boolean" ? v === "true" : v));
  return { extraFormData: { filters: [{ col: target(f.field, ctx).column.name, op: "IN", val: typed }] }, filterState: { value: typed } };
}

/**
 * The filter with a scope that covers exactly the charts the board filter applies to. The scope is left as it
 * is (and the same object returned) when it already covers them, so a tab-rooted or hand-made scope survives.
 */
function withScope(nf: NativeFilter, f: Filter, ctx: FilterWriteContext): NativeFilter {
  const all = ctx.charts.map((c) => c.id);
  const want = new Set(f.applies.includes("*") ? all : f.applies.flatMap((w) => (ctx.chartOf(w) === undefined ? [] : [ctx.chartOf(w)!])));
  const has = inScope(nf.scope, ctx.charts);
  if (has.size === want.size && [...want].every((c) => has.has(c))) return nf;
  return { ...nf, scope: { rootPath: ["ROOT_ID"], excluded: all.filter((c) => !want.has(c)) }, chartsInScope: all.filter((c) => want.has(c)), tabsInScope: [] };
}
