import { type Query, type ScopeClause, type Widget, nearest, queryKeys } from "@lenspack/core";
import { type MeasureExpr, type Pack, type PackDimension, type PackEntity, type PackMeasure, datedTime, expandedExpr, operands, parseJoinOn } from "@lenspack/pack";

import { addDays, bucketZone, calendarRange, dayStartFrom, localDate, startOfLocalDay, writtenDayStart } from "./calendar";

// Resolution binds every key in a query to a pack object and finds a join path
// for every dimension. It is where the model's mistakes surface as loud
// errors with a `nearest` suggestion — and where a fan-out is refused rather
// than computed.

export type Ctx = {
  tenant?: string;
  now?: Date;
  /**
   * The caller's row scope: filters every query must carry, whatever the
   * board asks. A query that cannot be narrowed by one of them is refused
   * (OUT_OF_SCOPE) rather than answered unnarrowed. One with an entity
   * narrows only the queries that read that entity (a table's row-level security).
   */
  scope?: ScopeClause[];
  /**
   * Keys this caller may not use: a query naming one is refused
   * (NOT_PERMITTED), whatever asked for it. The scope above may still filter
   * on one, as the server set it, not the caller.
   */
  hidden?: ReadonlySet<string>;
  /** Entities this caller may not read: a query that reads one is refused (NOT_PERMITTED). */
  hiddenEntities?: ReadonlySet<string>;
  /**
   * The keys and entities above that the host keeps from this caller (their access, not the pack's rules), and why,
   * in words for them: a refusal of one is ACCESS_HIDDEN and says why, so it is not read as "not in the pack".
   */
  accessHidden?: { keys: ReadonlySet<string>; reason: string };
  /**
   * Keys the source can't answer right now, though the caller may use them: what they read is not being collected
   * or not set up. A query naming one is refused (UNAVAILABLE) with the host's notice, which says why in words for
   * the reader and may point at where to fix it, so a board shows that instead of a wrong or empty figure.
   */
  unavailable?: ReadonlyMap<string, Notice>;
};

/** Why a key can't be answered now, in words for the reader, and optionally where to fix it. */
export type Notice = { text: string; action?: { label: string; href: string } };

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
  | "TIME_DIMENSION"
  | "NEEDS_JOIN"
  | "NOT_SUPPORTED"
  | "OUT_OF_SCOPE"
  | "NOT_PERMITTED"
  | "ACCESS_HIDDEN"
  | "UNAVAILABLE";

/** What a backend can do. Resolution refuses the rest up front. */
export type Capabilities = {
  /** Row-level joins between entities. A search index has none. */
  joins: boolean;
  /** count_distinct is exact (false: an estimate, shown as ≈). */
  exactDistinct: boolean;
  /** median / p90 / p95 are exact. */
  exactPercentiles: boolean;
  /**
   * median / p90 can be computed at all. A SQL dialect with no percentile
   * function (MySQL, SQLite) says false, and such a measure is refused
   * rather than estimated some other way. Absent means true.
   */
  percentiles?: boolean;
  /** Series buckets can start at local hours and days in the pack's time zone; false refuses a zoned series rather than drawing it in UTC. Absent means true. */
  zonedBuckets?: boolean;
  /** Measures with `per` (one value per key, then an aggregate over those). Absent means true. */
  twoStage?: boolean;
  /** A heatmap's columns can be time buckets (a series heatmap). False where the host draws the chart and cannot keep a time axis in order. Absent means true. */
  timeHeatmap?: boolean;
  /** Points queries (a map): each row's latitude and longitude. Absent means false: a connector says it can. */
  points?: boolean;
  /** Heatmap charts may be made. False where a deployment turned them off. Absent means true. */
  heatmap?: boolean;
  /**
   * Where a widget is kept as the host's own chart, which must recompute its
   * steps itself (Superset): why one with this compute cannot be kept, or null.
   * Absent: any compute is kept, as Lenspack draws the widget.
   */
  savedCompute?: (widget: Widget, pack: Pack) => string | null;
};

export const SQL_CAPABILITIES: Capabilities = { joins: true, exactDistinct: true, exactPercentiles: true, points: true };

export class ResolveError extends Error {
  constructor(
    public readonly code: ResolveErrorCode,
    message: string,
    public readonly key?: string,
    public readonly nearest?: string,
    /** For UNAVAILABLE: the host's notice, drawn by a board in place of the widget. */
    public readonly notice?: Notice,
  ) {
    super(message);
    this.name = "ResolveError";
  }
  toJSON() {
    return { code: this.code, error: this.message, key: this.key, nearest: this.nearest, ...(this.notice ? { notice: this.notice } : {}) };
  }
}

/**
 * The refusal for a query that names a key the caller may not use, or null.
 * Checked on the query as asked, before anything is resolved, so no answer,
 * filter menu or compiled statement is ever built over a hidden key.
 */
export function notPermitted(query: Query, ctx: Ctx = {}): ResolveError | null {
  if (!ctx.hidden?.size && !ctx.unavailable?.size) return null;
  const k = queryKeys(query);
  const keys = [...k.measures, ...k.dimensions];
  const key = ctx.hidden?.size ? keys.find((x) => ctx.hidden!.has(x)) : undefined;
  if (key) return refusedKey(key, ctx);
  const gone = ctx.unavailable?.size ? keys.find((x) => ctx.unavailable!.has(x)) : undefined;
  if (!gone) return null;
  const notice = ctx.unavailable!.get(gone)!;
  return new ResolveError("UNAVAILABLE", `"${gone}" can't be answered right now: ${notice.text}`, gone, undefined, notice);
}

/** The refusal of a key or entity the caller may not use: the host's own reason when the host keeps it (ACCESS_HIDDEN). */
function refusedKey(key: string, ctx: Ctx): ResolveError {
  const host = ctx.accessHidden;
  if (host?.keys.has(key)) return new ResolveError("ACCESS_HIDDEN", `"${key}" is not available to you: ${host.reason}`, key);
  return new ResolveError("NOT_PERMITTED", `"${key}" is not available to you`, key);
}

export type JoinStep = { from: string; to: string; on: { left: { entity: string; column: string }; right: { entity: string; column: string } } };

export type BoundDimension = { def: PackDimension; path: JoinStep[] };
export type BoundMeasure =
  | { kind: "simple"; def: PackMeasure }
  | { kind: "derived"; def: PackMeasure; expr: MeasureExpr; operands: PackMeasure[] };

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
  split: BoundDimension | null; // a breakdown's second dimension
  columns: BoundDimension[]; // rows; a points query's colour and label
  /** A points query's coordinate columns on the root entity. */
  geo: { lat: string; lon: string } | null;
  orderBy: { dimension: BoundDimension; dir: "asc" | "desc" } | null;
  filters: BoundFilter[];
  time: TimeWindow | null;
  previous: TimeWindow | null;
  /**
   * Set for the base of a computed query: a split series keeps every series,
   * not its top few, and the connector returns at most rows + 1 rows (one
   * more tells the engine the answer was cut).
   */
  base?: { rows: number };
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
function joinPath(pack: Pack, graph: Map<string, Edge[]>, root: string, target: string, dimensionKey: string, shown: (key: string) => boolean = () => true): JoinStep[] {
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
  const fanout = search(true);
  if (fanout) {
    // Suggest measures on any entity the fan-out path crosses, not just its
    // far end: the useful answer usually lives on the intermediate table
    // (the join table rather than its far end), and a target with no measures
    // of its own would otherwise produce a refusal with no way forward.
    const crossed = [target, ...fanout.map((step) => step.to)];
    const onPath = pack.measures.filter((m) => crossed.includes(m.entity) && !m.derived).map((m) => m.key).filter(shown);
    const onRoot = pack.dimensions.filter((d) => d.entity === root && d.type !== "time").map((d) => d.key).filter(shown);
    throw new ResolveError(
      "FANOUT_REFUSED",
      `"${dimensionKey}" lives on "${target}", which has many rows per "${root}" row; grouping a ${root}-level measure by it would multiply the numbers.` +
        (onPath.length ? ` Measure one of these instead: ${onPath.join(", ")}.` : "") +
        (onRoot.length ? ` Or keep the measure and group by a dimension on "${root}": ${onRoot.join(", ")}.` : ""),
      dimensionKey,
      onPath[0],
    );
  }
  throw new ResolveError("NO_JOIN_PATH", `No join path from "${root}" to "${target}" is declared in the pack`, dimensionKey);
}

const UNITS: Record<string, number> = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 };

// The window and the one a comparison reads. A calendar range is compared
// with the calendar span before it; any other window with the same length
// of time just before it.
//
// Over a column of calendar dates (`dated`), a window is whole local days:
// each end moves to the start of a day in the pack's zone (the next one,
// unless it is at one already), so a date is in the window when its day
// starts in it. "The last 7 days" is today and the 6 days before, today
// being the date in the pack's zone. The source then compares dates.
function window(query: Query, now: Date, timeZone?: string, dated = false): { time: TimeWindow; previous: TimeWindow } | null {
  if (!query.time) return null;
  const t = query.time;
  const days = (w: TimeWindow): TimeWindow => ({ from: dayStartFrom(w.from, timeZone), to: dayStartFrom(w.to, timeZone) });
  if ("period" in t) {
    const { previous, ...time } = calendarRange(t, now, timeZone);
    return dated ? { time: days(time), previous: days(previous) } : { time, previous };
  }
  let time: TimeWindow;
  if ("last" in t) {
    const n = Number(t.last.slice(0, -1));
    const unit = t.last.slice(-1);
    time = { from: new Date(now.getTime() - n * UNITS[unit]!), to: now };
  } else if (dated) {
    time = { from: writtenDayStart(t.from, timeZone), to: writtenDayStart(t.to, timeZone) };
  } else {
    time = { from: new Date(t.from), to: new Date(t.to) };
  }
  if (dated) {
    time = days(time);
    // As many days just before it.
    const [from, to] = [localDate(time.from, timeZone), localDate(time.to, timeZone)];
    const n = Math.round((Date.parse(to) - Date.parse(from)) / 86400e3);
    return { time, previous: { from: startOfLocalDay(addDays(from, -n), timeZone), to: time.from } };
  }
  return { time, previous: { from: new Date(time.from.getTime() - (time.to.getTime() - time.from.getTime())), to: time.from } };
}

/** The entity a query reads: its own for rows and points, else its measure's. */
const entityOf = (query: Query, pack: Pack): PackEntity | undefined =>
  pack.entities[query.kind === "rows" || query.kind === "points" ? query.entity : (pack.measures.find((m) => m.key === query.measure)?.entity ?? "")];

/** The window a query reads, on the clock resolve would read it with. */
export const timeWindowOf = (query: Query, pack: Pack, ctx: Ctx = {}): TimeWindow | null => window(query, nowOf(ctx), pack.timeZone, datedTime(entityOf(query, pack)))?.time ?? null;

/**
 * The zone an entity's series buckets are cut in: none for UTC, and none for
 * calendar dates, whose days, weeks and months are the same in every zone.
 */
export const bucketZoneOf = (pack: Pack, entity: PackEntity | undefined): string | undefined => (datedTime(entity) ? undefined : bucketZone(pack.timeZone));

// The clock to the minute: a widget drawn twice in that minute is the same statement, so a cache can answer it.
export const nowOf = (ctx: Ctx = {}) => ctx.now ?? new Date(Math.floor(Date.now() / 60e3) * 60e3);

export function resolve(query: Query, pack: Pack, ctx: Ctx = {}, caps: Capabilities = SQL_CAPABILITIES): BoundPlan {
  // Every path to a source resolves here: whatever built the query, a hidden key stops it.
  const denied = notPermitted(query, ctx);
  if (denied) throw denied;
  const now = nowOf(ctx);
  // A suggestion never names a key the caller may not use.
  const shown = (key: string) => !ctx.hidden?.has(key);
  const dimKeys = pack.dimensions.map((d) => d.key).filter(shown);
  const measureKeys = pack.measures.map((m) => m.key).filter(shown);
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
  if (query.kind === "rows" || query.kind === "points") {
    if (!pack.entities[query.entity])
      throw new ResolveError("UNKNOWN_ENTITY", `"${query.entity}" is not an entity in pack "${pack.pack}"`, query.entity, nearest(query.entity, Object.keys(pack.entities).filter((e) => !ctx.hiddenEntities?.has(e))) ?? undefined);
    root = query.entity;
    if (query.kind === "points") {
      if (!pack.entities[root]!.geo) throw new ResolveError("NOT_SUPPORTED", `"${root}" has no location (latitude and longitude), so it cannot be drawn as points`, root);
      if (!caps.points) throw new ResolveError("NOT_SUPPORTED", "Maps are not available here: this source or deployment cannot list points", root);
      if (query.size) {
        const def = findMeasure(query.size);
        if (def.entity !== root) throw new ResolveError("WRONG_ENTITY", `"${query.size}" is measured on "${def.entity}", not "${root}": a point's size must be a measure of the points' own entity`, query.size);
        if (def.derived) {
          const expr = expandedExpr(pack, def.key);
          measure = { kind: "derived", def, expr, operands: operands(expr).map(findMeasure) };
          if (measure.operands.some((o) => o.entity !== root || o.per)) throw new ResolveError("NOT_SUPPORTED", `"${def.key}" is computed across entities or per key, so it cannot size points`, def.key);
        } else {
          if (def.per) throw new ResolveError("NOT_SUPPORTED", `"${def.key}" aggregates one value per key, so it cannot size points`, def.key);
          measure = { kind: "simple", def };
        }
      }
    }
  } else {
    const def = findMeasure(query.measure);
    root = def.entity;
    if (def.derived) {
      const expr = expandedExpr(pack, def.key);
      measure = { kind: "derived", def, expr, operands: operands(expr).map(findMeasure) };
      // Operands on several entities are never joined row-wise: run()
      // computes each on its own and combines the aggregates (acrossEntities).
      if (new Set(measure.operands.map((o) => o.entity)).size > 1)
        throw new ResolveError("NOT_SUPPORTED", `"${def.key}" combines measures on several entities; it is computed by run(), not compiled as one query`, def.key);
      // A per-key operand is aggregated over its own inner query, so it too is computed on its own.
      if (measure.operands.some((o) => o.per))
        throw new ResolveError("NOT_SUPPORTED", `"${def.key}" combines a per-key measure with others; it is computed by run(), not compiled as one query`, def.key);
    } else {
      measure = { kind: "simple", def };
    }
  }
  const rootEntity = pack.entities[root]!;

  // A percentile the source cannot compute is refused, never approximated by
  // something that would print a different number under the same label.
  if (measure && caps.percentiles === false) {
    const pct = (measure.kind === "simple" ? [measure.def] : measure.operands).find((m) => m.agg === "median" || m.agg === "p90" || m.agg === "p95");
    if (pct)
      throw new ResolveError(
        "NOT_SUPPORTED",
        `"${pct.key}" is a ${pct.agg === "p90" ? "90th percentile" : pct.agg === "p95" ? "95th percentile" : "median"}, and this source has no percentile function, so it is not computed here`,
        pct.key,
      );
  }

  if (measure?.kind === "simple" && measure.def.per && caps.twoStage === false)
    throw new ResolveError("NOT_SUPPORTED", `"${measure.def.key}" aggregates one value per key, and this source cannot aggregate in two stages`, measure.def.key);

  const bind = (key: string): BoundDimension => {
    const def = findDimension(key);
    // A dimension that also lives on the root is read there, with no join.
    const local = def.entity !== root ? def.also?.[root] : undefined;
    if (local) return { def: { ...def, entity: root, field: local.field, sql: local.sql, json: local.json, also: undefined }, path: [] };
    if (!caps.joins && def.entity !== root) {
      const here = pack.dimensions.filter((d) => d.type !== "time" && (d.entity === root || d.also?.[root])).map((d) => d.key).filter(shown);
      throw new ResolveError(
        "NEEDS_JOIN",
        `"${key}" lives on "${def.entity}" and this source cannot join it to "${root}".` + (here.length ? ` Dimensions on "${root}": ${here.join(", ")}.` : ""),
        key,
        nearest(key, here) ?? here[0],
      );
    }
    return { def, path: joinPath(pack, graph, root, def.entity, key, shown) };
  };

  let dimension: BoundDimension | null = null;
  const columns: BoundDimension[] = [];
  let orderBy: BoundPlan["orderBy"] = null;

  let split: BoundDimension | null = null;
  if (query.kind === "breakdown") {
    dimension = bind(query.dimension);
    if (dimension.def.type === "time")
      throw new ResolveError("TIME_DIMENSION", `"${query.dimension}" is a time dimension; use a series to break down by time`, query.dimension, "series");
    if (query.by) split = bind(query.by);
  } else if (query.kind === "series") {
    if (!rootEntity.time) throw new ResolveError("NO_TIME", `"${root}" has no time column, so nothing on it can be plotted over time`, query.measure);
    // Calendar dates need no zone: a day of them is the same day anywhere.
    if (caps.zonedBuckets === false && bucketZoneOf(pack, rootEntity))
      throw new ResolveError(
        "NOT_SUPPORTED",
        `Pack "${pack.pack}" starts its days in ${pack.timeZone}, and this source can only bucket time by UTC days. "${root}" keeps a time of day, so a series of it is not drawn here. A series works when the time column holds calendar dates only (a DATE column), or when the pack keeps time in UTC`,
        query.measure,
      );
    if (query.by) dimension = bind(query.by);
  } else if (query.kind === "rows") {
    for (const key of query.columns) {
      const bound = bind(key);
      if (bound.def.entity !== root) throw new ResolveError("WRONG_ENTITY", `"${key}" belongs to "${bound.def.entity}", not "${root}"`, key);
      columns.push(bound);
    }
    if (query.orderBy) orderBy = { dimension: bind(query.orderBy.key), dir: query.orderBy.dir };
  } else if (query.kind === "points") {
    for (const key of [query.color, query.label]) if (key !== undefined && !columns.some((c) => c.def.key === key)) columns.push(bind(key));
  }
  const compare = (query.kind === "value" || query.kind === "breakdown") && !!query.compare;
  if (compare) {
    if (!rootEntity.time) throw new ResolveError("NO_TIME", `"${root}" has no time column, so there is no previous period`, query.measure);
    if (!query.time) throw new ResolveError("NEEDS_TIME_RANGE", "A previous-period comparison needs a time range", query.measure, 'time: { last: "30d" }');
  }

  const filters: BoundFilter[] = (query.filters ?? []).map((f) => ({ dimension: bind(f.dimension), op: f.op, value: f.value })) as BoundFilter[];
  const entitiesOf = (dims: (BoundDimension | null | undefined)[]) => [...new Set([root, ...dims.filter((d): d is BoundDimension => !!d).flatMap((d) => d.path.map((s) => s.to))])];
  const reads = entitiesOf([dimension, split, ...columns, orderBy?.dimension, ...filters.map((f) => f.dimension)]);
  // The caller's scope narrows every query. One it cannot reach is refused:
  // a number that ignores the caller's scope would show them other rows.
  for (const f of ctx.scope ?? []) {
    if (f.entity && !reads.includes(f.entity)) continue;
    let dimension: BoundDimension;
    try {
      dimension = bind(f.dimension);
    } catch (e) {
      if (!(e instanceof ResolveError)) throw e;
      throw new ResolveError("OUT_OF_SCOPE", `This view is limited by "${f.dimension}", which "${root}" cannot be narrowed by, so it is not shown`, f.dimension);
    }
    filters.push({ dimension, op: f.op, value: f.value } as BoundFilter);
  }

  if (query.time && !rootEntity.time)
    throw new ResolveError("NO_TIME", `"${root}" has no time column, so a time range cannot apply`, query.kind === "rows" || query.kind === "points" ? query.entity : query.measure);

  const windows = window(query, now, pack.timeZone, datedTime(rootEntity));
  const time = windows?.time ?? null;
  const previous = compare ? (windows?.previous ?? null) : null;

  const entitiesUsed = entitiesOf([dimension, split, ...columns, orderBy?.dimension, ...filters.map((f) => f.dimension)]);
  const off = entitiesUsed.find((e) => ctx.hiddenEntities?.has(e));
  if (off) throw refusedKey(off, ctx);

  // Tenancy is structural: if any entity in play declares a tenant column,
  // a tenant must be supplied. There is no "forgot to filter" state.
  const needsTenant = entitiesUsed.some((e) => pack.entities[e]!.tenant);
  if (needsTenant && !ctx.tenant) throw new ResolveError("TENANT_REQUIRED", `Pack "${pack.pack}" is multi-tenant; a tenant is required to query "${root}"`);

  const geo = query.kind === "points" ? rootEntity.geo! : null;
  return { query, root, rootEntity, tenant: needsTenant ? ctx.tenant! : null, entitiesUsed, measure, dimension, split, columns, geo, orderBy, filters, time, previous };
}
