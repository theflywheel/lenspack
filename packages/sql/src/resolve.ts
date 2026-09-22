import { type Query, nearest } from "@lenspack/core";
import { type Pack, type PackDimension, type PackMeasure, parseDerived, parseJoinOn } from "@lenspack/spec";

// Resolution binds every key in a query to a pack object and finds a join path
// for every dimension. It is where the model's mistakes surface as loud
// errors with a `nearest` suggestion — and where a fan-out is refused rather
// than computed.

export type Ctx = { tenant?: string; now?: Date };

export type ResolveErrorCode =
  | "UNKNOWN_MEASURE"
  | "UNKNOWN_DIMENSION"
  | "UNKNOWN_ENTITY"
  | "NO_JOIN_PATH"
  | "FANOUT_REFUSED"
  | "TENANT_REQUIRED"
  | "NO_TIME"
  | "NEEDS_TIME_RANGE"
  | "WRONG_ENTITY"
  | "TIME_DIMENSION";

export class ResolveError extends Error {
  constructor(
    public readonly code: ResolveErrorCode,
    message: string,
    public readonly key?: string,
    public readonly nearest?: string,
  ) {
    super(message);
    this.name = "ResolveError";
  }
  toJSON() {
    return { code: this.code, error: this.message, key: this.key, nearest: this.nearest };
  }
}

export type JoinStep = { from: string; to: string; on: { left: { entity: string; column: string }; right: { entity: string; column: string } } };

export type BoundDimension = { def: PackDimension; path: JoinStep[] };
export type BoundMeasure =
  | { kind: "simple"; def: PackMeasure }
  | { kind: "derived"; def: PackMeasure; numerator: PackMeasure; denominator: PackMeasure };

export type BoundFilter = { dimension: BoundDimension; op: Query["filters"] extends (infer F)[] | undefined ? (F extends { op: infer O } ? O : never) : never; value: unknown };

export type TimeWindow = { from: Date; to: Date };

export type BoundPlan = {
  query: Query;
  root: string;
  rootEntity: Pack["entities"][string];
  tenant: string | null;
  entitiesUsed: string[];
  measure: BoundMeasure | null;
  dimension: BoundDimension | null; // breakdown dimension or series `by`
  columns: BoundDimension[]; // rows
  orderBy: { dimension: BoundDimension; dir: "asc" | "desc" } | null;
  filters: BoundFilter[];
  time: TimeWindow | null;
  previous: TimeWindow | null;
};

type Edge = { to: string; type: "many_to_one" | "one_to_one" | "one_to_many"; step: JoinStep };

function edges(pack: Pack): Map<string, Edge[]> {
  const graph = new Map<string, Edge[]>();
  const add = (from: string, edge: Edge) => graph.set(from, [...(graph.get(from) ?? []), edge]);
  const invert = { many_to_one: "one_to_many", one_to_many: "many_to_one", one_to_one: "one_to_one" } as const;
  for (const [from, entity] of Object.entries(pack.entities)) {
    for (const join of entity.joins) {
      const on = parseJoinOn(join.on);
      add(from, { to: join.to, type: join.type, step: { from, to: join.to, on } });
      add(join.to, { to: from, type: invert[join.type], step: { from: join.to, to: from, on } });
    }
  }
  return graph;
}

// Shortest path over joins that cannot multiply rows. If the only way there
// is through a one-to-many step, that is a fan-out and it is refused.
function joinPath(pack: Pack, graph: Map<string, Edge[]>, root: string, target: string, dimensionKey: string): JoinStep[] {
  if (root === target) return [];
  const search = (allowFanout: boolean) => {
    const prev = new Map<string, { from: string; step: JoinStep }>();
    const seen = new Set([root]);
    const queue = [root];
    while (queue.length) {
      const here = queue.shift()!;
      for (const edge of graph.get(here) ?? []) {
        if (!allowFanout && edge.type === "one_to_many") continue;
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        prev.set(edge.to, { from: here, step: edge.step });
        if (edge.to === target) {
          const path: JoinStep[] = [];
          let cursor = target;
          while (cursor !== root) {
            const p = prev.get(cursor)!;
            path.unshift(p.step);
            cursor = p.from;
          }
          return path;
        }
        queue.push(edge.to);
      }
    }
    return null;
  };
  const safe = search(false);
  if (safe) return safe;
  if (search(true))
    throw new ResolveError(
      "FANOUT_REFUSED",
      `"${dimensionKey}" lives on "${target}", which has many rows per "${root}" row; grouping a ${root}-level measure by it would multiply the numbers. Measure something on "${target}" instead, or pick a dimension on "${root}".`,
      dimensionKey,
    );
  throw new ResolveError("NO_JOIN_PATH", `No join path from "${root}" to "${target}" is declared in the pack`, dimensionKey);
}

const UNITS: Record<string, number> = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 };

function window(query: Query, now: Date): TimeWindow | null {
  if (!query.time) return null;
  if ("last" in query.time) {
    const n = Number(query.time.last.slice(0, -1));
    const unit = query.time.last.slice(-1);
    return { from: new Date(now.getTime() - n * UNITS[unit]!), to: now };
  }
  return { from: new Date(query.time.from), to: new Date(query.time.to) };
}

export function resolve(query: Query, pack: Pack, ctx: Ctx = {}): BoundPlan {
  const now = ctx.now ?? new Date();
  const dimKeys = pack.dimensions.map((d) => d.key);
  const measureKeys = pack.measures.map((m) => m.key);
  const graph = edges(pack);

  const findMeasure = (key: string): PackMeasure => {
    const m = pack.measures.find((x) => x.key === key);
    if (!m) throw new ResolveError("UNKNOWN_MEASURE", `"${key}" is not a measure in pack "${pack.pack}"`, key, nearest(key, measureKeys) ?? undefined);
    return m;
  };
  const findDimension = (key: string): PackDimension => {
    const d = pack.dimensions.find((x) => x.key === key);
    if (!d) throw new ResolveError("UNKNOWN_DIMENSION", `"${key}" is not a dimension in pack "${pack.pack}"`, key, nearest(key, dimKeys) ?? undefined);
    return d;
  };

  // The root is the measure's entity: every number is computed at its grain.
  let root: string;
  let measure: BoundMeasure | null = null;
  if (query.kind === "rows") {
    if (!pack.entities[query.entity])
      throw new ResolveError("UNKNOWN_ENTITY", `"${query.entity}" is not an entity in pack "${pack.pack}"`, query.entity, nearest(query.entity, Object.keys(pack.entities)) ?? undefined);
    root = query.entity;
  } else {
    const def = findMeasure(query.measure);
    root = def.entity;
    if (def.derived) {
      const { numerator, denominator } = parseDerived(def.derived);
      measure = { kind: "derived", def, numerator: findMeasure(numerator), denominator: findMeasure(denominator) };
    } else {
      measure = { kind: "simple", def };
    }
  }
  const rootEntity = pack.entities[root]!;

  const bind = (key: string): BoundDimension => {
    const def = findDimension(key);
    return { def, path: joinPath(pack, graph, root, def.entity, key) };
  };

  let dimension: BoundDimension | null = null;
  const columns: BoundDimension[] = [];
  let orderBy: BoundPlan["orderBy"] = null;

  if (query.kind === "breakdown") {
    dimension = bind(query.dimension);
    if (dimension.def.type === "time")
      throw new ResolveError("TIME_DIMENSION", `"${query.dimension}" is a time dimension; use a series to break down by time`, query.dimension, "series");
  } else if (query.kind === "series") {
    if (!rootEntity.time) throw new ResolveError("NO_TIME", `"${root}" has no time column, so nothing on it can be plotted over time`, query.measure);
    if (query.by) dimension = bind(query.by);
  } else if (query.kind === "value") {
    if (query.compare) {
      if (!rootEntity.time) throw new ResolveError("NO_TIME", `"${root}" has no time column, so there is no previous period`, query.measure);
      if (!query.time) throw new ResolveError("NEEDS_TIME_RANGE", "A previous-period comparison needs a time range", query.measure, 'time: { last: "30d" }');
    }
  } else {
    for (const key of query.columns) {
      const bound = bind(key);
      if (bound.def.entity !== root) throw new ResolveError("WRONG_ENTITY", `"${key}" belongs to "${bound.def.entity}", not "${root}"`, key);
      columns.push(bound);
    }
    if (query.orderBy) orderBy = { dimension: bind(query.orderBy.key), dir: query.orderBy.dir };
  }

  const filters: BoundFilter[] = (query.filters ?? []).map((f) => ({ dimension: bind(f.dimension), op: f.op, value: f.value })) as BoundFilter[];

  if (query.time && !rootEntity.time)
    throw new ResolveError("NO_TIME", `"${root}" has no time column, so a time range cannot apply`, query.kind === "rows" ? query.entity : query.measure);

  const time = window(query, now);
  const previous = query.kind === "value" && query.compare && time ? { from: new Date(time.from.getTime() - (time.to.getTime() - time.from.getTime())), to: time.from } : null;

  const entitiesUsed = [...new Set([root, ...[dimension, ...columns, orderBy?.dimension ?? null, ...filters.map((f) => f.dimension)].filter((d): d is BoundDimension => !!d).flatMap((d) => d.path.map((s) => s.to))])];

  // Tenancy is structural: if any entity in play declares a tenant column,
  // a tenant must be supplied. There is no "forgot to filter" state.
  const needsTenant = entitiesUsed.some((e) => pack.entities[e]!.tenant);
  if (needsTenant && !ctx.tenant) throw new ResolveError("TENANT_REQUIRED", `Pack "${pack.pack}" is multi-tenant; a tenant is required to query "${root}"`);

  return { query, root, rootEntity, tenant: needsTenant ? ctx.tenant! : null, entitiesUsed, measure, dimension, columns, orderBy, filters, time, previous };
}
