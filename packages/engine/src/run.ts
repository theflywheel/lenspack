import type { BoardConfig, BoardOp, Query, Widget } from "@lenspack/core";
import { type MeasureExpr, type Pack, type PackMeasure, evaluate, expandedExpr, formatExpr, operands } from "@lenspack/spec";

import type { Connector } from "./connector";
import type { DataRow, WidgetData } from "./data";
import { drilledQuery, packAtLevel, viewedLevel } from "./levels";
import { type Capabilities, type Ctx, ResolveError, SQL_CAPABILITIES, resolve } from "./resolve";

export type RunOptions = { pack: Pack; connector: Connector; ctx?: Ctx; timeoutMs?: number };

// Groups fetched per operand of a cross-entity measure. The operands are
// combined after aggregation, so each must return every group, not its own top N.
const ACROSS_LIMIT = 10_000;

export type AcrossSide = {
  measure: PackMeasure;
  query: Query;
  /** The operand's entity has no time: one number for every period (per series if split). */
  timeless: boolean;
  /** Filters this operand's entity has no dimension for, so they do not narrow it. */
  unfiltered: string[];
};
export type Across = { def: PackMeasure; expr: MeasureExpr; sides: AcrossSide[] };

/**
 * Arithmetic whose operands live on different entities (delivered per target,
 * where deliveries and targets are separate tables or indexes). Each operand
 * is the same query over its own measure; the results are combined per group.
 * Returns null for anything else.
 */
export function acrossEntities(query: Query, pack: Pack): Across | null {
  if (query.kind === "rows") return null;
  const def = pack.measures.find((m) => m.key === query.measure);
  if (!def?.derived) return null;
  const expr = expandedExpr(pack, def.key);
  const measures = operands(expr).map((k) => pack.measures.find((m) => m.key === k)).filter((m): m is PackMeasure => !!m);
  if (new Set(measures.map((m) => m.entity)).size < 2) return null;
  const base = (key: string): Query => (query.kind === "breakdown" ? { ...query, measure: key, limit: ACROSS_LIMIT } : { ...query, measure: key });
  const sides = measures.map((m): AcrossSide => {
    const home = m.entity === def.entity;
    // A filter on a dimension another operand's entity does not have (a kind
    // of item, when the goal is set per region) narrows the home operand only:
    // this kind over the whole goal. Explain says so.
    const has = (dimension: string) => {
      const d = pack.dimensions.find((x) => x.key === dimension);
      return !d || d.entity === m.entity || !!d.also?.[m.entity];
    };
    const kept = home ? (query.filters ?? []) : (query.filters ?? []).filter((f) => has(f.dimension));
    const unfiltered = home ? [] : [...new Set((query.filters ?? []).filter((f) => !has(f.dimension)).map((f) => f.dimension))];
    let q = { ...base(m.key), filters: kept.length ? kept : undefined } as Query;
    // An operand with no time (a target, a capacity) is the same in every
    // period: each bucket, and the previous period, use that one number.
    const timeless = !home && !pack.entities[m.entity]?.time;
    if (timeless) {
      const { time: _time, ...rest } = q as Query & { time?: unknown };
      if (q.kind === "series")
        q = q.by ? { kind: "breakdown", dimension: q.by, measure: m.key, limit: ACROSS_LIMIT, sort: "desc", filters: rest.filters } : { kind: "value", measure: m.key, filters: rest.filters };
      else if (q.kind === "value") q = { kind: "value", measure: m.key, filters: rest.filters };
      else q = rest as Query;
    }
    return { measure: m, query: q, timeless, unfiltered };
  });
  return { def, expr, sides };
}

// A group missing from an operand had no rows there: zero for an additive
// operand (nothing delivered yet), unknown for anything else.
const additive = (m: PackMeasure) => m.agg === "count" || m.agg === "sum";

function combine(query: Query, across: Across, data: WidgetData[]): WidgetData {
  const { def, expr, sides } = across;
  const format = def.format ?? "number";
  const approximate = data.some((d) => d.approximate) || undefined;
  const homeIndex = Math.max(0, sides.findIndex((s) => s.measure.entity === def.entity));
  const home = data[homeIndex]!;
  const keyOf = (r: DataRow) => `${r.group}\u0000${r.series ?? ""}`;

  if (query.kind === "value") {
    const now = (i: number) => data[i]!.rows[0]?.value ?? null;
    const value = evaluate(expr, (k) => now(sides.findIndex((s) => s.measure.key === k)));
    const out: WidgetData = { rows: [{ group: def.key, value, count: home.total }], total: home.total, format, approximate };
    if (sides.every((s, i) => s.timeless || data[i]!.compare)) {
      const previous = evaluate(expr, (k) => {
        const i = sides.findIndex((s) => s.measure.key === k);
        return sides[i]!.timeless ? now(i) : data[i]!.compare!.previous;
      });
      out.compare = { previous, delta: value !== null && previous !== null && previous !== 0 ? (value - previous) / Math.abs(previous) : null };
    }
    return out;
  }

  const byKey = data.map((d) => new Map(d.rows.map((r) => [keyOf(r), r])));
  // A timeless operand of a series has no buckets of its own to contribute.
  const keys = [...new Set(sides.flatMap((s, i) => (s.timeless && query.kind === "series" ? [] : data[i]!.rows.map(keyOf))))];
  let rows: DataRow[] = keys.map((k) => {
    const shape = sides.map((_, i) => byKey[i]!.get(k)).find(Boolean)!;
    const operand = (i: number): number | null => {
      const s = sides[i]!;
      if (s.timeless && query.kind === "series") {
        const hit = query.by ? data[i]!.rows.find((d) => d.group === shape.series) : data[i]!.rows[0];
        return hit ? hit.value : additive(s.measure) ? 0 : null;
      }
      const r = byKey[i]!.get(k);
      return r ? r.value : additive(s.measure) ? 0 : null;
    };
    const value = evaluate(expr, (key) => operand(sides.findIndex((s) => s.measure.key === key)));
    return { group: shape.group, ...(shape.series !== undefined ? { series: shape.series } : {}), value, count: byKey[homeIndex]!.get(k)?.count ?? 0 };
  });
  if (query.kind === "breakdown") {
    const dir = query.sort === "asc" ? 1 : -1;
    rows.sort((a, b) => (a.value === null ? 1 : b.value === null ? -1 : (a.value - b.value) * dir) || a.group.localeCompare(b.group));
    rows = rows.slice(0, query.limit);
  } else {
    rows.sort((a, b) => a.group.localeCompare(b.group) || (a.series ?? "").localeCompare(b.series ?? ""));
  }
  return { rows, total: rows.reduce((s, r) => s + r.count, 0), format, approximate };
}

const refusal = (e: ResolveError): WidgetData => ({ rows: [], total: 0, format: "number", error: e.message, hint: e.nearest });

/** Compile and run one query. Resolution errors come back as data, not throws. */
export async function run(query: Query, opts: RunOptions): Promise<WidgetData> {
  // Per-level measures are read at the level this query views.
  const view = { ...opts, pack: packAtLevel(opts.pack, viewedLevel(query, opts.pack)) };
  const data = query.kind !== "rows" && query.measures?.length ? await runMeasures(query, view) : await runOne(query, view);
  return query.kind === "breakdown" ? withoutEmptyGroups(data, query.measure, view.pack) : data;
}

// A measure's where narrows the rows it counts, not the groups: a group with
// no rows for it at all (a per-level target's other levels) comes back empty.
// Such a group is dropped. A zero count stays, and so does a ratio that
// could not be computed: those are answers, an empty group is not.
function withoutEmptyGroups(data: WidgetData, measure: string, pack: Pack): WidgetData {
  const m = pack.measures.find((x) => x.key === measure);
  if (!m || data.error) return data;
  const plain = !m.derived || /^\s*[a-z][a-z0-9_]*\s*$/.test(m.derived);
  if (!plain) return data;
  const rows = data.rows.filter((r) => r.value !== null || r.count === 0);
  return rows.length === data.rows.length ? data : { ...data, rows, total: rows.reduce((n, r) => n + r.count, 0) };
}

/** The query without its further measures, and one query per further measure. */
export function splitMeasures(query: Query, pack?: Pack): { primary: Query; extras: { key: string; query: Query }[] } {
  if (query.kind === "rows" || !query.measures?.length) return { primary: query, extras: [] };
  const { measures, ...primary } = query;
  // A further measure on an entity with no time (a target beside today's
  // deliveries) shows its whole value rather than refusing the window.
  const timeless = (key: string) => {
    const m = pack?.measures.find((x) => x.key === key);
    if (!m || !pack) return false;
    const entities = m.derived ? operands(expandedExpr(pack, m.key)).map((k) => pack.measures.find((x) => x.key === k)?.entity) : [m.entity];
    return entities.every((e) => e && !pack.entities[e]?.time);
  };
  return {
    primary: primary as Query,
    extras: measures.map((key) => {
      let q = (query.kind === "breakdown" ? { ...primary, measure: key, limit: ACROSS_LIMIT } : { ...primary, measure: key }) as Query;
      if (timeless(key)) {
        const { time: _t, ...rest } = q as Query & { time?: unknown; compare?: unknown };
        q = (q.kind === "series" ? { kind: "value", measure: key, filters: rest.filters } : q.kind === "value" ? { kind: "value", measure: key, filters: rest.filters } : rest) as Query;
      }
      return { key, query: q };
    }),
  };
}

// Further measures follow the primary's groups: the primary decides which
// groups are shown and in what order, and each other measure fills in its
// column, from whichever entity it lives on.
async function runMeasures(query: Exclude<Query, { kind: "rows" }>, opts: RunOptions): Promise<WidgetData> {
  const { primary, extras } = splitMeasures(query, opts.pack);
  const [main, ...others] = await Promise.all([runOne(primary, opts), ...extras.map((e) => runOne(e.query, opts))]);
  if (main!.error) return main!;
  const failed = others.findIndex((o) => o.error);
  if (failed >= 0) return { ...others[failed]!, error: `${extras[failed]!.key}: ${others[failed]!.error}` };
  const keyOf = (r: DataRow) => `${r.group}\u0000${r.series ?? ""}`;
  const defs = extras.map((e) => opts.pack.measures.find((m) => m.key === e.key));
  const lookups = others.map((o) => new Map(o.rows.map((r) => [keyOf(r), r.value])));
  const rows = main!.rows.map((r) => ({
    ...r,
    values: Object.fromEntries(
      extras.map((e, i) => {
        // A timeless measure beside a series is one number for every bucket.
        const flat = e.query.kind === "value" && query.kind === "series";
        const hit = flat ? (others[i]!.rows[0]?.value ?? null) : lookups[i]!.get(keyOf(r));
        return [e.key, hit !== undefined ? hit : defs[i] && additive(defs[i]!) ? 0 : null];
      }),
    ),
  }));
  return {
    ...main!,
    rows,
    measures: [{ key: query.measure, format: main!.format }, ...extras.map((e, i) => ({ key: e.key, format: others[i]!.format }))],
    approximate: main!.approximate || others.some((o) => o.approximate) || undefined,
  };
}

async function runOne(query: Query, opts: RunOptions): Promise<WidgetData> {
  try {
    const across = acrossEntities(query, opts.pack);
    if (across) {
      const data = await Promise.all(
        across.sides.map(async (s) => {
          const d = await runOne(s.query, opts);
          return s.query.kind === "breakdown" ? withoutEmptyGroups(d, s.measure.key, opts.pack) : d;
        }),
      );
      const failed = data.find((d) => d.error);
      return failed ?? combine(query, across, data);
    }
    const bound = resolve(query, opts.pack, opts.ctx, opts.connector.capabilities);
    const plan = await opts.connector.compile(bound, opts.pack);
    return await opts.connector.execute(plan, { timeoutMs: opts.timeoutMs });
  } catch (e) {
    if (e instanceof ResolveError) return refusal(e);
    throw e;
  }
}

export type Explained = { text: string; root: string; entities: string[]; tenant: string | null; approximate: boolean };

/** What would run, without running it. Throws ResolveError for a refusal. */
export async function explain(query: Query, given: Omit<RunOptions, "timeoutMs">): Promise<Explained> {
  const opts = { ...given, pack: packAtLevel(given.pack, viewedLevel(query, given.pack)) };
  const { primary, extras } = splitMeasures(query, opts.pack);
  if (extras.length) {
    const parts = await Promise.all([explain(primary, opts), ...extras.map((e) => explain(e.query, opts))]);
    return {
      text: parts.map((p, i) => `-- ${i === 0 ? (primary as { measure: string }).measure : extras[i - 1]!.key}\n${p.text}`).join("\n"),
      root: parts[0]!.root,
      entities: [...new Set(parts.flatMap((p) => p.entities))],
      tenant: parts.find((p) => p.tenant)?.tenant ?? null,
      approximate: parts.some((p) => p.approximate),
    };
  }
  const across = acrossEntities(query, opts.pack);
  if (across) {
    const parts = await Promise.all(across.sides.map((s) => explain(s.query, opts)));
    const notes = across.sides.flatMap((s) => [
      ...(s.unfiltered.length ? [`-- ${s.measure.key} is not narrowed by ${s.unfiltered.join(", ")}: "${s.measure.entity}" has no such dimension`] : []),
      ...(s.timeless ? [`-- "${s.measure.entity}" has no time: every period uses the same ${s.measure.key}`] : []),
    ]);
    return {
      text: [`-- ${across.def.key} = ${formatExpr(across.expr)}, each measure computed on its own and combined per group`, ...notes, ...across.sides.map((s, i) => `-- ${s.measure.key}\n${parts[i]!.text}`)].join("\n"),
      root: parts[0]!.root,
      entities: [...new Set(parts.flatMap((p) => p.entities))],
      tenant: parts.find((p) => p.tenant)?.tenant ?? null,
      approximate: parts.some((p) => p.approximate),
    };
  }

  const bound = resolve(query, opts.pack, opts.ctx, opts.connector.capabilities);
  const plan = await opts.connector.compile(bound, opts.pack);
  return { text: plan.text, root: bound.root, entities: bound.entitiesUsed, tenant: bound.tenant, approximate: !!plan.approximate };
}

/** Resolution only: every refusal a query would get, with no backend call. */
export function check(query: Query, given: Pack, opts: { ctx?: Ctx; capabilities?: Capabilities } = {}) {
  const pack = packAtLevel(given, viewedLevel(query, given));
  const { primary, extras } = splitMeasures(query, pack);
  if (extras.length) {
    for (const q of [primary, ...extras.map((e) => e.query)]) check(q, pack, opts);
    return;
  }
  const across = acrossEntities(query, pack);
  for (const q of across ? across.sides.map((s) => s.query) : [query]) resolve(q, pack, opts.ctx, opts.capabilities ?? SQL_CAPABILITIES);
}

/**
 * Checks every query an add/update op would put on the board, so a widget the
 * pack cannot answer is refused at edit time rather than rendering an error
 * later. Vocabulary is checked by core's applyOps; this catches what only
 * resolution knows: join paths, fan-out, tenancy, time, what the source can do.
 */
export function checkOps(
  ops: BoardOp[],
  pack: Pack,
  opts: { ctx?: Ctx; capabilities?: Capabilities } = {},
): { ok: true } | { ok: false; opIndex: number; error: string; hint?: string } {
  for (const [opIndex, op] of ops.entries()) {
    if (op.op !== "add_widget" && op.op !== "update_widget") continue;
    if (op.widget.kind === "text") continue;
    try {
      check(op.widget.query, pack, opts);
    } catch (e) {
      if (e instanceof ResolveError) return { ok: false, opIndex, error: e.message, hint: e.nearest };
      throw e;
    }
  }
  return { ok: true };
}

// Merges a board's filter selections into a widget's own filter clauses. A
// filter narrows only the widgets it says it applies to.
export function widgetQuery(config: BoardConfig, id: string, widget: Widget, selections: Record<string, string> = {}): Query | null {
  if (widget.kind === "text") return null;
  const extra = config.filters
    .filter((f) => selections[f.field] && (f.applies.includes("*") || f.applies.includes(id)))
    .map((f) => ({ dimension: f.field, op: "eq" as const, value: selections[f.field]! }));
  if (extra.length === 0) return widget.query;
  return { ...widget.query, filters: [...(widget.query.filters ?? []), ...extra] } as Query;
}

/**
 * One pass over a board, resolving each widget. Identical queries run once:
 * three widgets drawing the same breakdown differently should cost one scan.
 */
export async function resolveBoard(config: BoardConfig, opts: RunOptions, selections: Record<string, string> = {}): Promise<Record<string, WidgetData>> {
  const byKey = new Map<string, Promise<WidgetData>>();
  const data: Record<string, WidgetData> = {};
  await Promise.all(
    Object.entries(config.widgets).map(async ([id, widget]) => {
      const query = drilledQuery(config, id, widget, selections, opts.pack, { ctx: opts.ctx, capabilities: opts.connector.capabilities });
      if (!query) return;
      const key = JSON.stringify(query);
      if (!byKey.has(key)) byKey.set(key, run(query, opts));
      try {
        data[id] = await byKey.get(key)!;
      } catch (error) {
        // One widget that cannot load must not take the board down with it.
        data[id] = { rows: [], total: 0, format: "number", error: String(error instanceof Error ? error.message : error).slice(0, 200) };
      }
    }),
  );
  return data;
}

/** Distinct values of a dimension, for filter controls. */
export async function dimensionValues(dimension: string, opts: RunOptions, limit = 50) {
  const dim = opts.pack.dimensions.find((d) => d.key === dimension);
  const measure =
    opts.pack.measures.find((m) => m.agg === "count" && !m.field && !m.where && !m.filter && m.entity === dim?.entity) ??
    opts.pack.measures.find((m) => m.agg === "count" && m.entity === dim?.entity) ??
    opts.pack.measures.find((m) => m.agg === "count");
  if (!measure) return [];
  const data = await run({ kind: "breakdown", dimension, measure: measure.key, limit: Math.min(50, limit), sort: "desc" }, opts);
  return data.rows.map((r) => ({ value: r.group, count: r.count }));
}
