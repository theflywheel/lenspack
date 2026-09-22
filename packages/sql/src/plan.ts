import type { Fragment, Pack, PackDimension, PackMeasure } from "@lenspack/spec";

import { type Ast, type Expr, type Join, type Source } from "./ast";
import type { BoundDimension, BoundFilter, BoundPlan, TimeWindow } from "./resolve";

// Planning turns a bound plan into an AST. Each entity becomes a subquery that
// projects the pack's dimension and measure fragments under reserved aliases,
// so an unqualified column in a fragment can only ever mean a column of that
// entity's own table — joins cannot make it ambiguous.

const D = (key: string) => `__d_${key}`;
const M = (key: string) => `__m_${key}`;

const col = (alias: string, name: string): Expr => ({ t: "col", alias, col: name });
const raw = (sql: Fragment): Expr => ({ t: "raw", sql });
const param = (value: unknown, cast?: "timestamp" | "double" | "int"): Expr => ({ t: "param", value, cast });

function dimensionExpr(d: PackDimension): Expr {
  if (d.json) return { t: "json", alias: "", col: d.json[0]!, path: d.json.slice(1) };
  return raw(d.sql!);
}

// A measure's row-level value. A `filter` folds into a CASE so the aggregate
// simply ignores rows outside it; `count` gets a literal 1 to count.
function measureRowExpr(m: PackMeasure): Expr | null {
  if (m.derived) return null;
  const base: Expr = m.agg === "count" ? { t: "lit", value: 1 } : raw(m.sql!);
  if (!m.filter) return m.agg === "count" ? null : base;
  return { t: "case", when: raw(m.filter), then: base };
}

export type Shape = "breakdown" | "series" | "value" | "rows";

export function plan(bound: BoundPlan, pack: Pack): { ast: Ast; shape: Shape } {
  const { query, root } = bound;
  const sources = new Map<string, Source>();
  const source = (entity: string): Source => {
    let s = sources.get(entity);
    if (!s) {
      const def = pack.entities[entity]!;
      s = { alias: entity, table: def.source, projections: [], where: [] };
      if (def.tenant && bound.tenant !== null) s.where.push({ t: "bin", op: "=", l: col("", def.tenant), r: param(bound.tenant) });
      sources.set(entity, s);
    }
    return s;
  };
  const project = (entity: string, alias: string, expr: Expr) => {
    const s = source(entity);
    if (!s.projections.some((p) => p.alias === alias)) s.projections.push({ alias, expr });
  };

  // Root first so it is the FROM.
  const rootSource = source(root);
  const joins: Join[] = [];
  const joined = new Set<string>([root]);
  const ensureJoined = (d: BoundDimension) => {
    for (const step of d.path) {
      if (joined.has(step.to)) continue;
      joined.add(step.to);
      const s = source(step.to);
      const leftIsFrom = step.on.left.entity === step.from;
      const fromSide = leftIsFrom ? step.on.left : step.on.right;
      const toSide = leftIsFrom ? step.on.right : step.on.left;
      joins.push({ source: s, on: { left: col(step.from, fromSide.column), right: col(step.to, toSide.column) } });
    }
  };
  const dimRef = (d: BoundDimension): Expr => {
    ensureJoined(d);
    project(d.def.entity, D(d.def.key), dimensionExpr(d.def));
    return col(d.def.entity, D(d.def.key));
  };

  const where: Expr[] = [];
  const timeCol = bound.rootEntity.time ? col(root, bound.rootEntity.time) : null;
  const inWindow = (w: TimeWindow): Expr => ({
    t: "bin",
    op: "AND",
    l: { t: "bin", op: ">=", l: timeCol!, r: param(w.from, "timestamp") },
    r: { t: "bin", op: "<", l: timeCol!, r: param(w.to, "timestamp") },
  });

  for (const f of bound.filters) where.push(filterExpr(dimRef(f.dimension), f));

  // For a comparison, both windows share one scan and the aggregate picks its
  // rows with a CASE; otherwise the window is an ordinary predicate.
  const windowed = !!bound.previous;
  if (bound.time && !windowed) where.push(inWindow(bound.time));
  if (windowed) {
    where.push({ t: "bin", op: ">=", l: timeCol!, r: param(bound.previous!.from, "timestamp") });
    where.push({ t: "bin", op: "<", l: timeCol!, r: param(bound.time!.to, "timestamp") });
  }

  // Aggregates over the root's projected measure columns.
  const aggOf = (m: PackMeasure, cond: Expr | null): Expr => {
    const rowExpr = measureRowExpr(m);
    if (rowExpr) project(root, M(m.key), rowExpr);
    const ref: Expr | null = rowExpr ? col(root, M(m.key)) : null;
    if (m.agg === "count") {
      const arg: Expr = cond ? { t: "case", when: cond, then: ref ?? { t: "lit", value: 1 } } : (ref ?? { t: "star" });
      return { t: "agg", fn: "count", arg };
    }
    const arg: Expr = cond ? { t: "case", when: cond, then: ref! } : ref!;
    return { t: "agg", fn: m.agg!, arg };
  };
  const valueExpr = (cond: Expr | null): Expr => {
    const m = bound.measure!;
    if (m.kind === "simple") return aggOf(m.def, cond);
    // Ratio of two aggregates; the denominator is guarded against zero.
    return {
      t: "bin",
      op: "/",
      l: { t: "cast", arg: aggOf(m.numerator, cond), to: "double" },
      r: { t: "nullif0", arg: aggOf(m.denominator, cond) },
    };
  };

  const select: Ast["select"] = [];
  const groupBy: Expr[] = [];
  const orderBy: Ast["orderBy"] = [];
  let limit: number;
  let shape: Shape;

  switch (query.kind) {
    case "breakdown": {
      const g = dimRef(bound.dimension!);
      select.push({ alias: "group", expr: g }, { alias: "value", expr: valueExpr(null) }, { alias: "n", expr: { t: "agg", fn: "count", arg: { t: "star" } } });
      groupBy.push(g);
      // Ties broken by name so the same data always prints the same rows.
      orderBy.push({ expr: col("", "value"), dir: query.sort }, { expr: col("", "group"), dir: "asc" });
      limit = query.limit;
      shape = "breakdown";
      break;
    }
    case "series": {
      const bucket: Expr = { t: "trunc", grain: query.grain, arg: timeCol! };
      select.push({ alias: "bucket", expr: bucket });
      groupBy.push(bucket);
      if (bound.dimension) {
        const g = dimRef(bound.dimension);
        select.push({ alias: "series", expr: g });
        groupBy.push(g);
      }
      select.push({ alias: "value", expr: valueExpr(null) }, { alias: "n", expr: { t: "agg", fn: "count", arg: { t: "star" } } });
      orderBy.push({ expr: col("", "bucket"), dir: "asc" });
      if (bound.dimension) orderBy.push({ expr: col("", "series"), dir: "asc" });
      limit = 5000;
      shape = "series";
      break;
    }
    case "value": {
      const current = windowed ? inWindow(bound.time!) : null;
      select.push({ alias: "value", expr: valueExpr(current) });
      select.push({ alias: "n", expr: { t: "agg", fn: "count", arg: current ? { t: "case", when: current, then: { t: "lit", value: 1 } } : { t: "star" } } });
      if (windowed) select.push({ alias: "previous", expr: valueExpr(inWindow(bound.previous!)) });
      limit = 1;
      shape = "value";
      break;
    }
    case "rows": {
      for (const c of bound.columns) select.push({ alias: c.def.key, expr: dimRef(c) });
      if (bound.orderBy) orderBy.push({ expr: dimRef(bound.orderBy.dimension), dir: bound.orderBy.dir });
      limit = query.limit;
      shape = "rows";
      break;
    }
  }

  return { ast: { select, from: rootSource, joins, where, groupBy, orderBy, limit }, shape };
}

function filterExpr(ref: Expr, f: BoundFilter): Expr {
  const v = f.value as string | number | boolean | (string | number | boolean)[];
  const one = (x: unknown) => param(x);
  switch (f.op) {
    case "eq":
      return { t: "bin", op: "=", l: ref, r: one(v) };
    case "neq":
      return { t: "bin", op: "<>", l: ref, r: one(v) };
    case "gte":
      return { t: "bin", op: ">=", l: ref, r: one(v) };
    case "lte":
      return { t: "bin", op: "<=", l: ref, r: one(v) };
    case "in":
      return { t: "in", l: ref, values: (Array.isArray(v) ? v : [v]).map(one) };
    case "between": {
      const [a, b] = Array.isArray(v) ? v : [v, v];
      return { t: "bin", op: "AND", l: { t: "bin", op: ">=", l: ref, r: one(a) }, r: { t: "bin", op: "<=", l: ref, r: one(b) } };
    }
    case "contains":
      return { t: "bin", op: "ILIKE", l: { t: "cast", arg: ref, to: "text" }, r: one(`%${String(v).replace(/[%_\\]/g, (c) => `\\${c}`)}%`) };
  }
}
