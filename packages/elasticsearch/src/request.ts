import { type BoundDimension, type BoundFilter, type BoundPlan, MAX_SERIES, ResolveError, type Row, type TimeWindow } from "@lenspack/engine";
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
      const esc = (x: unknown) => String(x).replace(/[*?\\]/g, (c) => `\\${c}`);
      return { must: [{ bool: { should: values.flatMap((x) => [{ term: { [field]: x } }, { wildcard: { [field]: `${esc(x)}|*` } }, { wildcard: { [field]: `*|${esc(x)}` } }, { wildcard: { [field]: `*|${esc(x)}|*` } }]), minimum_should_match: 1 } }], mustNot: [] };
    }
    case "subtree":
      return { must: [{ bool: { should: [{ term: { [field]: v } }, { prefix: { [field]: `${String(v)}.` } }], minimum_should_match: 1 } }], mustNot: [] };
    case "contains": {
      const needle = `*${String(v).replace(/[*?\\]/g, (c) => `\\${c}`)}*`;
      const insensitive = env.version.major > 7 || (env.version.major === 7 && env.version.minor >= 10);
      return { must: [{ wildcard: { [field]: insensitive ? { value: needle, case_insensitive: true } : { value: needle.toLowerCase() } } }], mustNot: [] };
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
    must.push(tenant.match === "subtree" ? { bool: { should: [{ term: { [f]: bound.tenant } }, { prefix: { [f]: `${bound.tenant}.` } }], minimum_should_match: 1 } } : { term: { [f]: bound.tenant } });
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

  const interval = env.version.major > 7 || (env.version.major === 7 && env.version.minor >= 2) ? "calendar_interval" : "interval";

  switch (query.kind) {
    case "breakdown": {
      const dim = bound.dimension!.def;
      const metricAggs = measureAggs(bound, env);
      const termsOf = (d: PackDimension, size: number, order?: unknown) => {
        const missing = d.field && (d.type === "string" || d.type === "enum") && env.typeOf(exact(d.field, env)) === "keyword" ? { missing: "" } : {};
        return { ...dimensionSource(d, env), ...missing, size, ...(order ? { order } : {}) };
      };
      const byGroup = query.sortBy === "group";
      // With a second dimension, or an order the terms aggregation cannot
      // express, every group comes back and the rows are sorted and cut here.
      const sortAfter = metricAggs.order === null || !!bound.split;
      const order = byGroup ? [{ _key: query.sort }] : sortAfter ? undefined : [{ [metricAggs.order!]: query.sort }, ...(query.sortBy === "measure" ? [] : [{ _key: "asc" }])];
      const inner = bound.split ? { s: { terms: termsOf(bound.split.def, 1000), aggs: metricAggs.aggs } } : metricAggs.aggs;
      body.aggs = { g: { terms: termsOf(dim, sortAfter ? 10_000 : query.limit, order), aggs: inner } };
      return {
        index: entity.source,
        body,
        approximate: metricAggs.approximate,
        decode(r) {
          const groups = (r.aggregations?.g?.buckets ?? []) as Bucket[];
          let rows: Row[] = bound.split
            ? groups.flatMap((g) => ((g.s?.buckets ?? []) as Bucket[]).map((b) => ({ group: groupKey(g), series: groupKey(b), value: metricAggs.read(b), n: b.doc_count })))
            : groups.map((b) => ({ group: groupKey(b), value: metricAggs.read(b), n: b.doc_count }));
          if (sortAfter && query.sortBy !== "none") {
            const dir = query.sort === "asc" ? 1 : -1;
            const cmp = (x: unknown, y: unknown) => String(x).localeCompare(String(y));
            rows.sort((a, b) =>
              byGroup
                ? cmp(a.group, b.group) * dir || cmp(a.series ?? "", b.series ?? "")
                : ((a.value as number | null) === null ? 1 : (b.value as number | null) === null ? -1 : ((a.value as number) - (b.value as number)) * dir) || cmp(a.group, b.group) || cmp(a.series ?? "", b.series ?? ""),
            );
          }
          return rows.slice(0, query.limit);
        },
      };
    }
    case "series": {
      const metricAggs = measureAggs(bound, env);
      const histogram = { date_histogram: { field: timeField!, [interval]: query.grain, min_doc_count: 1 }, aggs: metricAggs.aggs };
      if (!bound.dimension) {
        body.aggs = { t: histogram };
        return {
          index: entity.source,
          body,
          approximate: metricAggs.approximate,
          decode: (r) => ((r.aggregations?.t?.buckets ?? []) as Bucket[]).map((b) => ({ bucket: b.key, value: metricAggs.read(b), n: b.doc_count })),
        };
      }
      // The top series by the measure over the whole window, each over time:
      // the same series the SQL path keeps.
      const src = dimensionSource(bound.dimension.def, env);
      const order = metricAggs.order ? [{ [metricAggs.order]: "desc" }, { _key: "asc" }] : [{ _count: "desc" }, { _key: "asc" }];
      body.aggs = { s: { terms: { ...src, size: MAX_SERIES, order }, aggs: { ...metricAggs.aggs, t: histogram } } };
      return {
        index: entity.source,
        body,
        approximate: metricAggs.approximate,
        decode: (r) =>
          ((r.aggregations?.s?.buckets ?? []) as Bucket[])
            .flatMap((s) => ((s.t?.buckets ?? []) as Bucket[]).map((b) => ({ bucket: b.key, series: groupKey(s), value: metricAggs.read(b), n: b.doc_count })))
            .sort((a, b) => a.bucket - b.bucket || String(a.series).localeCompare(String(b.series))),
      };
    }
    case "value": {
      const metricAggs = measureAggs(bound, env);
      if (bound.previous) {
        body.aggs = { w: { filters: { filters: { current: range(bound.time!), previous: range(bound.previous) } }, aggs: metricAggs.aggs } };
        return {
          index: entity.source,
          body,
          approximate: metricAggs.approximate,
          decode(r) {
            const b = r.aggregations?.w?.buckets ?? {};
            return [{ value: metricAggs.read(b.current ?? {}), n: b.current?.doc_count ?? 0, previous: metricAggs.read(b.previous ?? {}) }];
          },
        };
      }
      // A match_all bucket gives the row count the same way on every version,
      // where hits.total changed shape and stopped being exact by default.
      body.aggs = { all: { filter: { match_all: {} }, aggs: metricAggs.aggs } };
      return {
        index: entity.source,
        body,
        approximate: metricAggs.approximate,
        decode(r) {
          const b = r.aggregations?.all ?? {};
          return [{ value: metricAggs.read(b), n: b.doc_count ?? 0 }];
        },
      };
    }
    case "rows": {
      const cols = bound.columns.map((c) => ({ key: c.def.key, path: dimensionField(c.def, env, "listed").replace(/\.keyword$/, "") }));
      body.size = query.limit;
      body._source = cols.map((c) => c.path);
      // Ties fall to the remaining columns in the order listed, as in SQL.
      if (bound.orderBy)
        body.sort = [bound.orderBy, ...bound.columns.filter((c) => c.def.key !== bound.orderBy!.dimension.def.key).map((dimension) => ({ dimension, dir: "asc" as const }))].map((o) => ({ [dimensionField(o.dimension.def, env, "sorted")]: { order: o.dir } }));
      return {
        index: entity.source,
        body,
        approximate: false,
        decode: (r) =>
          ((r.hits?.hits ?? []) as Bucket[]).map((h) => Object.fromEntries(cols.map((c) => [c.key, get(h._source ?? {}, c.path) ?? null]))),
      };
    }
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

export type { BoundDimension };
