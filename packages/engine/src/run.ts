import type { BoardConfig, BoardOp, Query, Widget } from "@lenspack/core";
import { type Pack, type PackMeasure, parseDerived } from "@lenspack/spec";

import type { Connector } from "./connector";
import type { DataRow, WidgetData } from "./data";
import { type Capabilities, type Ctx, ResolveError, SQL_CAPABILITIES, resolve } from "./resolve";

export type RunOptions = { pack: Pack; connector: Connector; ctx?: Ctx; timeoutMs?: number };

// Groups fetched per side of a cross-entity ratio. The sides are joined after
// aggregation, so each must return every group, not its own top N.
const ACROSS_LIMIT = 10_000;

/**
 * A ratio whose operands live on different entities (delivered per target,
 * where deliveries and targets are separate tables or indexes). Each side is
 * the same query over its own measure; the results are joined on the group.
 * Returns null for anything else.
 */
export function acrossEntities(
  query: Query,
  pack: Pack,
): { numerator: Query; denominator: Query; def: PackMeasure; operands: [PackMeasure, PackMeasure]; unfiltered: string[] } | null {
  if (query.kind === "rows") return null;
  const def = pack.measures.find((m) => m.key === query.measure);
  if (!def?.derived) return null;
  const { numerator, denominator } = parseDerived(def.derived);
  const num = pack.measures.find((m) => m.key === numerator);
  const den = pack.measures.find((m) => m.key === denominator);
  if (!num || !den || num.entity === den.entity) return null;
  const side = (key: string): Query => (query.kind === "breakdown" ? { ...query, measure: key, limit: ACROSS_LIMIT } : { ...query, measure: key });
  // A filter on a dimension the denominator does not have (a kind of item,
  // when the goal is set per region) narrows the numerator only: this kind
  // over the whole goal. Explain says so.
  const onDen = (dimension: string) => {
    const d = pack.dimensions.find((x) => x.key === dimension);
    return !d || d.entity === den.entity || !!d.also?.[den.entity];
  };
  const kept = (query.filters ?? []).filter((f) => onDen(f.dimension));
  const unfiltered = [...new Set((query.filters ?? []).filter((f) => !onDen(f.dimension)).map((f) => f.dimension))];
  const denSide = { ...side(denominator), filters: kept.length ? kept : undefined } as Query;
  return { numerator: side(numerator), denominator: denSide, def, operands: [num, den], unfiltered };
}

// A group missing on one side had no rows there: zero for an additive
// operand (nothing delivered yet), unknown for anything else.
const additive = (m: PackMeasure) => m.agg === "count" || m.agg === "sum";
const divide = (n: number | null, d: number | null) => (n === null || d === null || d === 0 ? null : n / d);

function joinSides(query: Query, num: WidgetData, den: WidgetData, def: PackMeasure, [nm, dm]: [PackMeasure, PackMeasure]): WidgetData {
  const format = def.format ?? "number";
  const approximate = num.approximate || den.approximate || undefined;
  const keyOf = (r: DataRow) => `${r.group}\u0000${r.series ?? ""}`;
  if (query.kind === "value") {
    const n = num.rows[0]?.value ?? null;
    const d = den.rows[0]?.value ?? null;
    const data: WidgetData = { rows: [{ group: def.key, value: divide(n, d), count: num.total }], total: num.total, format, approximate };
    if (num.compare && den.compare) {
      const value = divide(n, d);
      const previous = divide(num.compare.previous, den.compare.previous);
      data.compare = { previous, delta: value !== null && previous !== null && previous !== 0 ? (value - previous) / Math.abs(previous) : null };
    }
    return data;
  }
  const nByKey = new Map(num.rows.map((r) => [keyOf(r), r]));
  const dByKey = new Map(den.rows.map((r) => [keyOf(r), r]));
  const keys = [...new Set([...nByKey.keys(), ...dByKey.keys()])];
  let rows: DataRow[] = keys.map((k) => {
    const n = nByKey.get(k);
    const d = dByKey.get(k);
    const base = (n ?? d)!;
    const nv = n ? n.value : additive(nm) ? 0 : null;
    const dv = d ? d.value : additive(dm) ? 0 : null;
    return { group: base.group, ...(base.series !== undefined ? { series: base.series } : {}), value: divide(nv, dv), count: n?.count ?? 0 };
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
  try {
    const across = acrossEntities(query, opts.pack);
    if (across) {
      const [num, den] = await Promise.all([run(across.numerator, opts), run(across.denominator, opts)]);
      if (num.error) return num;
      if (den.error) return den;
      return joinSides(query, num, den, across.def, across.operands);
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
export async function explain(query: Query, opts: Omit<RunOptions, "timeoutMs">): Promise<Explained> {
  const across = acrossEntities(query, opts.pack);
  if (across) {
    const [n, d] = await Promise.all([explain(across.numerator, opts), explain(across.denominator, opts)]);
    return {
      text:
        `-- ${across.def.key} = ${across.operands[0].key} / ${across.operands[1].key}, each computed on its own and joined on the group\n` +
        (across.unfiltered.length ? `-- the denominator is not narrowed by ${across.unfiltered.join(", ")}: "${across.operands[1].entity}" has no such dimension\n` : "") +
        `-- numerator\n${n.text}\n-- denominator\n${d.text}`,
      root: n.root,
      entities: [...new Set([...n.entities, ...d.entities])],
      tenant: n.tenant ?? d.tenant,
      approximate: n.approximate || d.approximate,
    };
  }
  const bound = resolve(query, opts.pack, opts.ctx, opts.connector.capabilities);
  const plan = await opts.connector.compile(bound, opts.pack);
  return { text: plan.text, root: bound.root, entities: bound.entitiesUsed, tenant: bound.tenant, approximate: !!plan.approximate };
}

/** Resolution only: every refusal a query would get, with no backend call. */
export function check(query: Query, pack: Pack, opts: { ctx?: Ctx; capabilities?: Capabilities } = {}) {
  const across = acrossEntities(query, pack);
  for (const q of across ? [across.numerator, across.denominator] : [query]) resolve(q, pack, opts.ctx, opts.capabilities ?? SQL_CAPABILITIES);
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
      const query = widgetQuery(config, id, widget, selections);
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
