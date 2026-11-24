import { type BoundFilter, type BoundPlan, MAX_SERIES, ResolveError, type Row, type TimeWindow, bucketZone, localWallClock, sortGroups } from "@lenspack/engine";
import { type Fragment, type Pack, type PackDimension, type PackMeasure, type Where, evaluate, maybeFragmentFor, tenantOf } from "@lenspack/spec";

// The query IR, compiled to one search request. Every structural decision —
// which entity, which dimensions, tenancy, the time window — was made by the
// resolver; this file only spells it in the aggregation DSL, and says how to
// read the response back into the engine's raw rows.

export type Env = {
  /** The mapped type of a field path, if known ("keyword", "text", "long", "date", …). */
  typeOf(path: string): string | undefined;
  version: { major: number; minor: number };
};

type Json = Record<string, unknown>;
type Bucket = Record<string, any>;

export type SearchRequest = {
  index: string;
  body: Json;
  approximate: boolean;
  /** Response → the engine's raw rows (group / series / bucket / value / n / previous). */
  decode(response: Bucket): Row[];
};

const refuse = (message: string, key?: string): never => {
  throw new ResolveError("NOT_SUPPORTED", message, key);
};

// A text field cannot be grouped or matched exactly; its keyword sub-field can.
function exact(path: string, env: Env): string {
  if (env.typeOf(path) === "text" && env.typeOf(`${path}.keyword`) === "keyword") return `${path}.keyword`;
  return path;
}

const isDate = (path: string, env: Env) => /^date/.test(env.typeOf(path) ?? "");

/** The search engine is this version or later. */
const atLeast = ({ version: v }: Env, major: number, minor: number) => v.major > major || (v.major === major && v.minor >= minor);

// A wildcard pattern's own characters, matched literally.
const wild = (x: unknown) => String(x).replace(/[*?\\]/g, (c) => `\\${c}`);

// A node of a dotted path and everything under it.
const subtree = (field: string, v: unknown): Json => ({ bool: { should: [{ term: { [field]: v } }, { prefix: { [field]: `${String(v)}.` } }], minimum_should_match: 1 } });

function esFragment(fragment: Fragment, what: string, key: string): string {
  return maybeFragmentFor(fragment, "elasticsearch") ?? refuse(`${what} "${key}" is written in SQL only; add an elasticsearch: entry to use it on this source`, key);
}

/** Where a dimension reads from: a field, or a Painless script. */
function dimensionSource(d: PackDimension, env: Env): Json {
  if (d.field) return { field: exact(d.field, env) };
  if (d.sql) return { script: { source: esFragment(d.sql, "Dimension", d.key), lang: "painless" } };
  return refuse(`Dimension "${d.key}" reads a JSON column path, which a search index does not have`, d.key);
}

function dimensionField(d: PackDimension, env: Env, use: string): string {
  if (!d.field) refuse(`Dimension "${d.key}" is computed by a script, so it cannot be ${use} on this source`, d.key);
  return exact(d.field!, env);
}

function whereClause(w: Where, env: Env): { must?: Json; mustNot?: Json } {
  const f = exact(w.field, env);
  switch (w.op) {
    case "eq":
      return { must: { term: { [f]: w.value } } };
    case "neq":
      // Rows without the field are kept, as SQL's IS DISTINCT FROM keeps NULLs.
      return { mustNot: { term: { [f]: w.value } } };
    case "in":
      return { must: { terms: { [f]: w.value } } };
    case "exists":
      return { must: { exists: { field: f } } };
    case "missing":
      return { mustNot: { exists: { field: f } } };
    default:
      return { must: { range: { [f]: { [w.op]: w.value } } } };
  }
}

function filterClause(f: BoundFilter, env: Env): { must: Json[]; mustNot: Json[] } {
  const field = dimensionField(f.dimension.def, env, "filtered");
  const v = f.value as string | number | boolean | (string | number | boolean)[];
  switch (f.op) {
    case "eq":
      return { must: [{ term: { [field]: v } }], mustNot: [] };
    case "neq":
      // SQL's <> drops rows where the column is NULL; so does this.
      return { must: [{ exists: { field } }], mustNot: [{ term: { [field]: v } }] };
    case "in":
      return { must: [{ terms: { [field]: Array.isArray(v) ? v : [v] } }], mustNot: [] };
    case "gte":
      return { must: [{ range: { [field]: { gte: v } } }], mustNot: [] };
    case "lte":
      return { must: [{ range: { [field]: { lte: v } } }], mustNot: [] };
    case "between": {
      const [a, b] = Array.isArray(v) ? v : [v, v];
      return { must: [{ range: { [field]: { gte: a, lte: b } } }], mustNot: [] };
    }
    case "segment": {
      const values = Array.isArray(v) ? v : [v];
      return { must: [{ bool: { should: values.flatMap((x) => [{ term: { [field]: x } }, { wildcard: { [field]: `${wild(x)}|*` } }, { wildcard: { [field]: `*|${wild(x)}` } }, { wildcard: { [field]: `*|${wild(x)}|*` } }]), minimum_should_match: 1 } }], mustNot: [] };
    }
    case "subtree":
      return { must: [subtree(field, v)], mustNot: [] };
    case "contains": {
      const needle = `*${wild(v)}*`;
      return { must: [{ wildcard: { [field]: atLeast(env, 7, 10) ? { value: needle, case_insensitive: true } : { value: needle.toLowerCase() } } }], mustNot: [] };
    }
  }
}

const bool = (must: Json[], mustNot: Json[]): Json =>
  must.length === 1 && mustNot.length === 0 ? must[0]! : { bool: { ...(must.length ? { filter: must } : {}), ...(mustNot.length ? { must_not: mustNot } : {}) } };

function predicates(where: Where[] | undefined, fragment: Fragment | undefined, env: Env, owner: string): { must: Json[]; mustNot: Json[] } {
  const must: Json[] = [];
  const mustNot: Json[] = [];
  for (const w of where ?? []) {
    const c = whereClause(w, env);
    if (c.must) must.push(c.must);
    if (c.mustNot) mustNot.push(c.mustNot);
  }
  if (fragment) {
    const dsl = esFragment(fragment, "The filter of", owner);
    try {
      must.push(JSON.parse(dsl) as Json);
    } catch {
      refuse(`The elasticsearch filter of "${owner}" is not valid JSON query DSL`, owner);
    }
  }
  return { must, mustNot };
}

type Metric = { aggs: Json; read(b: Bucket): number | null; order: string | null; approximate: boolean };

/** One measure as a metric aggregation named `name`, and how to read it from a bucket. */
function metric(m: PackMeasure, name: string, env: Env): Metric {
  const src: Json | null = m.field
    ? { field: m.agg === "count" || m.agg === "count_distinct" ? exact(m.field, env) : m.field }
    : m.sql
      ? { script: { source: esFragment(m.sql, "Measure", m.key), lang: "painless" } }
      : null;
  let inner: Json | null = null;
  let readInner: (b: Bucket) => number | null = () => null;
  let approximate = false;
  let orderSuffix = "";
  switch (m.agg) {
    case "count":
      if (src) {
        inner = { value_count: src };
        readInner = (b) => b[name]?.value ?? null;
      }
      break;
    case "count_distinct":
      inner = { cardinality: { ...src, precision_threshold: 40000 } };
      readInner = (b) => b[name]?.value ?? null;
      approximate = true;
      break;
    case "median":
    case "p90": {
      const pct = m.agg === "median" ? 50 : 90;
      inner = { percentiles: { ...src, percents: [pct] } };
      readInner = (b) => {
        const values = b[name]?.values ?? {};
        const v = Object.values(values)[0];
        return typeof v === "number" ? v : null;
      };
      orderSuffix = `.${pct}`;
      approximate = true;
      break;
    }
    default:
      inner = { [m.agg!]: src };
      readInner = (b) => b[name]?.value ?? null;
  }
  const { must, mustNot } = predicates(m.where, m.filter, env, m.key);
  const filtered = must.length + mustNot.length > 0;
  const scale = (v: number | null) => (v === null || !m.scale ? v : v * m.scale);
  // SQL's sum/min/max over no rows is NULL where a search engine says 0;
  // lenspack follows SQL so the two backends print the same board.
  const overRows = (b: Bucket, v: number | null) => (m.agg !== "count" && m.agg !== "count_distinct" && (b.doc_count ?? 1) === 0 ? null : v);
  if (!filtered) {
    return {
      aggs: inner ? { [name]: inner } : {},
      read: (b) => scale(inner ? overRows(b, readInner(b)) : (b.doc_count ?? null)),
      order: inner ? `${name}${orderSuffix}` : "_count",
      approximate,
    };
  }
  const f = `${name}_rows`;
  return {
    aggs: { [f]: { filter: bool(must, mustNot), ...(inner ? { aggs: { [name]: inner } } : {}) } },
    read: (b) => scale(inner ? overRows(b[f] ?? {}, readInner(b[f] ?? {})) : (b[f]?.doc_count ?? null)),
    // A single-bucket aggregation's own path sorts by its document count.
    order: inner ? `${f}>${name}${orderSuffix}` : f,
    approximate,
  };
}

/** The bound measure — simple or a same-entity ratio — as metric aggregations. */
function measureAggs(bound: BoundPlan, env: Env): Metric {
  const m = bound.measure!;
  if (m.kind === "simple") return metric(m.def, "m", env);
  // Every operand as its own metric in one request, combined after.
  const parts = new Map(m.operands.map((o, i) => [o.key, metric(o, `o${i}`, env)]));
  return {
    aggs: Object.assign({}, ...[...parts.values()].map((p) => p.aggs)),
    read: (b) => evaluate(m.expr, (key) => parts.get(key)!.read(b)),
    // Arithmetic cannot order a terms aggregation; the groups are sorted after.
    order: null,
    approximate: [...parts.values()].some((p) => p.approximate),
  };
}

const groupKey = (b: Bucket) => b.key_as_string ?? b.key;

export function toRequest(bound: BoundPlan, pack: Pack, env: Env): SearchRequest {
  const { query, rootEntity: entity, root } = bound;
  const must: Json[] = [];
  const mustNot: Json[] = [];

  const tenant = tenantOf(entity);
  if (tenant && bound.tenant !== null) {
    const f = exact(tenant.field, env);
    must.push(tenant.match === "subtree" ? subtree(f, bound.tenant) : { term: { [f]: bound.tenant } });
  }
  const own = predicates(entity.where, entity.filter, env, root);
  must.push(...own.must);
  mustNot.push(...own.mustNot);
  for (const f of bound.filters) {
    const c = filterClause(f, env);
    must.push(...c.must);
    mustNot.push(...c.mustNot);
  }

  // A date field, or a number of epoch (milli)seconds; a histogram over a
  // numeric field reads it as milliseconds, so seconds cannot be bucketed.
  const time = entity.time;
  const timeField = !time ? null : typeof time === "string" ? time : "field" in time ? time.field : null;
  const perMs = time && typeof time === "object" && "unit" in time && time.unit === "epoch_s" ? 1 / 1000 : 1;
  const needsTime = !!bound.time || query.kind === "series";
  if (needsTime && !timeField) refuse(`"${root}" keeps its time in a SQL expression, which this source cannot evaluate; point time: at a field`, root);
  if (query.kind === "series" && perMs !== 1) refuse(`"${root}" keeps time in epoch seconds, which this source cannot bucket by date`, root);
  const range = (w: TimeWindow): Json => ({
    range: {
      [timeField!]: isDate(timeField!, env)
        ? { gte: w.from.getTime(), lt: w.to.getTime(), format: "epoch_millis" }
        : { gte: Math.floor(w.from.getTime() * perMs), lt: Math.floor(w.to.getTime() * perMs) },
    },
  });
  if (bound.time && !bound.previous) must.push(range(bound.time));
  if (bound.previous) must.push(range({ from: bound.previous.from, to: bound.time!.to }));

  const body: Json = { size: 0, query: bool(must, mustNot) };
  if (must.length + mustNot.length === 0) body.query = { match_all: {} };

  const interval = atLeast(env, 7, 2) ? "calendar_interval" : "interval";
  const answer = (approximate: boolean, decode: (r: Bucket) => Row[]): SearchRequest => ({ index: entity.source, body, approximate, decode });

  switch (query.kind) {
    case "breakdown": {
      const dim = bound.dimension!.def;
      const metricAggs = measureAggs(bound, env);
      const termsOf = (d: PackDimension, size: number, order?: unknown) => {
        const missing = d.field && (d.type === "string" || d.type === "enum") && env.typeOf(exact(d.field, env)) === "keyword" ? { missing: "" } : {};
        return { ...dimensionSource(d, env), ...missing, size, ...(order ? { order } : {}) };
      };
      // A comparison reads each group's two windows as filter buckets; the
      // groups are the current period's, so one with no current rows is dropped.
      const windows = bound.previous ? { cur: { filter: range(bound.time!), aggs: metricAggs.aggs }, prev: { filter: range(bound.previous), aggs: metricAggs.aggs } } : null;
      const read = (b: Bucket): Row =>
        windows ? { value: metricAggs.read(b.cur ?? {}), n: b.cur?.doc_count ?? 0, previous: metricAggs.read(b.prev ?? {}) } : { value: metricAggs.read(b), n: b.doc_count };
      // With a second dimension, a comparison, or an order the terms aggregation
      // cannot express, every group comes back and the rows are sorted here; the
      // engine keeps the first groups.
      const sortAfter = metricAggs.order === null || !!bound.split || !!windows;
      const order = query.sortBy === "group" ? [{ _key: query.sort }] : sortAfter ? undefined : [{ [metricAggs.order!]: query.sort }, ...(query.sortBy === "measure" ? [] : [{ _key: "asc" }])];
      const leaf = windows ?? metricAggs.aggs;
      const inner = bound.split ? { s: { terms: termsOf(bound.split.def, 1000), aggs: leaf } } : leaf;
      body.aggs = { g: { terms: termsOf(dim, sortAfter ? 10_000 : query.limit, order), aggs: inner } };
      return answer(metricAggs.approximate, (r) => {
        const groups = (r.aggregations?.g?.buckets ?? []) as Bucket[];
        let rows: Row[] = bound.split
          ? groups.flatMap((g) => ((g.s?.buckets ?? []) as Bucket[]).map((b) => ({ group: groupKey(g), series: groupKey(b), ...read(b) })))
          : groups.map((b) => ({ group: groupKey(b), ...read(b) }));
        if (windows) rows = rows.filter((r) => (r.n as number) > 0);
        // Buckets sorted here have no order of their own to keep, so ties
        // under "measure" fall to the names, as under "value".
        if (sortAfter) rows = sortGroups(rows, { sort: query.sort, sortBy: query.sortBy === "measure" ? "value" : query.sortBy });
        return rows;
      });
    }
    case "series": {
      const metricAggs = measureAggs(bound, env);
      // In a zone, buckets start at local midnight and are keyed by that
      // instant; the key is read back as local time, as SQL returns it.
      const zone = bucketZone(pack.timeZone);
      const local = (key: number) => (zone ? localWallClock(key, zone) : key);
      // A numeric field (epoch milliseconds) takes no time_zone in a
      // date_histogram, so in a zone it is read through a date-typed runtime
      // field (7.11+). Without runtime fields the zoned series is refused
      // rather than bucketed at UTC midnight under a local label.
      let histogramField = timeField!;
      if (zone && env.typeOf(timeField!) !== "date" && env.typeOf(timeField!) !== "date_nanos") {
        if (!atLeast(env, 7, 11))
          refuse(`"${root}" keeps time as epoch numbers, which this source cannot bucket in ${pack.timeZone}; it needs Elasticsearch 7.11+ (runtime fields)`, root);
        histogramField = "__lenspack_time";
        body.runtime_mappings = {
          [histogramField]: {
            type: "date",
            script: { source: "def f = doc[params.f]; if (f.size() > 0) emit(f.value.longValue())", params: { f: timeField! } },
          },
        };
      }
      const histogram = { date_histogram: { field: histogramField, [interval]: query.grain, min_doc_count: 1, ...(zone ? { time_zone: zone } : {}) }, aggs: metricAggs.aggs };
      if (!bound.dimension) {
        body.aggs = { t: histogram };
        return answer(metricAggs.approximate, (r) => ((r.aggregations?.t?.buckets ?? []) as Bucket[]).map((b) => ({ bucket: local(b.key), value: metricAggs.read(b), n: b.doc_count })));
      }
      // The top series by the measure over the whole window, each over time:
      // the same series the SQL path keeps. A computed query's base reads every
      // series, as many as its row cap allows; the engine counts the rows.
      const src = dimensionSource(bound.dimension.def, env);
      const order = metricAggs.order ? [{ [metricAggs.order]: "desc" }, { _key: "asc" }] : [{ _count: "desc" }, { _key: "asc" }];
      const size = bound.base ? Math.min(bound.base.rows + 1, 10_000) : MAX_SERIES;
      body.aggs = { s: { terms: { ...src, size, order }, aggs: { ...metricAggs.aggs, t: histogram } } };
      return answer(metricAggs.approximate, (r) =>
        ((r.aggregations?.s?.buckets ?? []) as Bucket[]).flatMap((s) => ((s.t?.buckets ?? []) as Bucket[]).map((b) => ({ bucket: local(b.key), series: groupKey(s), value: metricAggs.read(b), n: b.doc_count }))),
      );
    }
    case "value": {
      const metricAggs = measureAggs(bound, env);
      if (bound.previous) {
        body.aggs = { w: { filters: { filters: { current: range(bound.time!), previous: range(bound.previous) } }, aggs: metricAggs.aggs } };
        return answer(metricAggs.approximate, (r) => {
          const b = r.aggregations?.w?.buckets ?? {};
          return [{ value: metricAggs.read(b.current ?? {}), n: b.current?.doc_count ?? 0, previous: metricAggs.read(b.previous ?? {}) }];
        });
      }
      // A match_all bucket gives the row count the same way on every version,
      // where hits.total changed shape and stopped being exact by default.
      body.aggs = { all: { filter: { match_all: {} }, aggs: metricAggs.aggs } };
      return answer(metricAggs.approximate, (r) => {
        const b = r.aggregations?.all ?? {};
        return [{ value: metricAggs.read(b), n: b.doc_count ?? 0 }];
      });
    }
    case "rows": {
      const cols = bound.columns.map((c) => ({ key: c.def.key, path: dimensionField(c.def, env, "listed").replace(/\.keyword$/, "") }));
      body.size = query.limit;
      // A later page; from + size stays within the default 10,000 window.
      if (query.offset) body.from = query.offset;
      body._source = cols.map((c) => c.path);
      // Ties fall to the remaining columns in the order listed, as in SQL.
      // A page with no order is ordered by the columns, so pages do not overlap.
      const order = bound.orderBy ?? (query.offset !== undefined && bound.columns[0] ? { dimension: bound.columns[0], dir: "asc" as const } : null);
      if (order)
        body.sort = [order, ...bound.columns.filter((c) => c.def.key !== order.dimension.def.key).map((dimension) => ({ dimension, dir: "asc" as const }))].map((o) => ({ [dimensionField(o.dimension.def, env, "sorted")]: { order: o.dir } }));
      return answer(false, (r) => ((r.hits?.hits ?? []) as Bucket[]).map((h) => Object.fromEntries(cols.map((c) => [c.key, get(h._source ?? {}, c.path) ?? null]))));
    }
    case "points":
      // Not in ELASTICSEARCH_CAPABILITIES: resolution refuses a map before it gets here.
      throw new Error("points queries are not supported by the search connector");
  }
}

// Reads "a.b.c" from a document whether it was indexed nested or with dotted keys.
function get(doc: Bucket, path: string): unknown {
  if (path in doc) return doc[path];
  const [head, ...rest] = path.split(".");
  let cursor: unknown = doc;
  for (const part of [head!, ...rest]) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    const obj = cursor as Bucket;
    if (!(part in obj)) {
      // A dotted remainder stored as one key: {"Data": {"a.b": 1}}.
      const idx = path.indexOf(part);
      const remainder = path.slice(idx);
      return remainder in obj ? obj[remainder] : undefined;
    }
    cursor = obj[part];
  }
  return cursor;
}
