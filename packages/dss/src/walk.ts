import type { Agg, Where } from "@lenspack/spec";

// Reads one DSS `aggrQuery` — hand-written aggregation DSL — into leaves:
// each leaf is a single number the chart draws, with the predicates above it,
// the bucket it is grouped by, and the names on the way down. Anything that
// is not a shape lenspack can express is returned as a reason, never guessed.

export type Bucket = { kind: "terms"; field: string; size?: number } | { kind: "date"; field: string; interval: string };

export type Leaf = {
  /** Agg names from the top of the tree to this leaf, including filters-bucket labels. */
  path: string[];
  agg: Agg;
  field?: string;
  where: Where[];
  scale?: number;
  buckets: Bucket[];
  /** A ratio of two sibling leaves (a bucket_script dividing them). */
  ratio?: { numerator: Leaf; denominator: Leaf; percent: boolean };
};

export type Walked = { leaves: Leaf[]; placeholders: { field: string; token: string }[]; problems: string[] };

type Json = Record<string, any>;

/** "Data.district.keyword" → "Data.district": connectors resolve text to keyword themselves. */
export const bare = (field: string) => field.replace(/\.keyword$/, "");

export function toWhere(q: Json, placeholders: Set<string>, out: Walked): Where[] | null {
  if (!q || typeof q !== "object") return [];
  const [kind, body] = Object.entries(q)[0] ?? [];
  if (!kind) return [];
  const one = (field: string, raw: unknown): Where[] | null => {
    const value = raw && typeof raw === "object" && "value" in (raw as Json) ? (raw as Json).value : (raw as Json)?.query ?? raw;
    if (typeof value === "string" && placeholders.has(value)) {
      // DSS substitutes these from the request; in lenspack they become a board filter.
      out.placeholders.push({ field: bare(field), token: value });
      return [];
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
    return [{ field: bare(field), op: "eq", value }];
  };
  switch (kind) {
    case "match_all":
      return [];
    case "term":
    case "match":
    case "match_phrase": {
      const [field, raw] = Object.entries(body as Json)[0]!;
      return one(field, raw);
    }
    case "terms": {
      const [field, values] = Object.entries(body as Json)[0]!;
      return Array.isArray(values) ? [{ field: bare(field), op: "in", value: values }] : null;
    }
    case "exists":
      return [{ field: bare((body as Json).field), op: "exists" }];
    case "range": {
      const [field, bounds] = Object.entries(body as Json)[0]!;
      const ops = Object.entries(bounds as Json).filter(([k]) => ["gt", "gte", "lt", "lte"].includes(k));
      if (ops.length === 0 || ops.length !== Object.keys(bounds as Json).filter((k) => k !== "format" && k !== "time_zone").length) return null;
      if (ops.some(([, v]) => typeof v !== "number")) return null; // date math such as "now-1d" is the time window's job
      return ops.map(([op, value]) => ({ field: bare(field), op: op as Where["op"], value: value as number }));
    }
    case "bool": {
      const b = body as Json;
      if (b.should && (Array.isArray(b.should) ? b.should.length : 1)) return null;
      const where: Where[] = [];
      for (const clause of [...arr(b.must), ...arr(b.filter)]) {
        const w = toWhere(clause, placeholders, out);
        if (!w) return null;
        where.push(...w);
      }
      for (const clause of arr(b.must_not)) {
        const w = toWhere(clause, placeholders, out);
        if (!w || w.length !== 1) return null;
        const [x] = w as [Where];
        if (x.op === "eq") where.push({ field: x.field, op: "neq", value: x.value });
        // NOT IN (a, b) is a <> each of them.
        else if (x.op === "in") for (const v of x.value as (string | number | boolean)[]) where.push({ field: x.field, op: "neq", value: v });
        else if (x.op === "exists") where.push({ field: x.field, op: "missing" });
        else return null;
      }
      return where;
    }
    default:
      return null;
  }
}

const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : v ? [v as Json] : []);

const METRICS: Record<string, Agg> = { value_count: "count", sum: "sum", avg: "avg", min: "min", max: "max", cardinality: "count_distinct" };

// The one scripted_metric DSS repeats: a unique count done by hand.
const isUniqueCount = (s: Json) => typeof s?.reduce_script === "string" && /containsKey|HashSet|uniqueValue/i.test(s.reduce_script) && typeof s?.params?.fieldName === "string";

export function walk(aggrQuery: string, placeholders: Set<string>): Walked {
  const out: Walked = { leaves: [], placeholders: [], problems: [] };
  let root: Json;
  try {
    root = JSON.parse(aggrQuery);
  } catch {
    out.problems.push("aggrQuery is not valid JSON");
    return out;
  }
  const visit = (aggs: Json, path: string[], where: Where[], buckets: Bucket[]) => {
    const here: Record<string, Leaf> = {};
    const scripts: [string, Json][] = [];
    for (const [name, node] of Object.entries(aggs ?? {})) {
      const kind = Object.keys(node).find((k) => k !== "aggs" && k !== "aggregations" && k !== "meta");
      const children: Json = node.aggs ?? node.aggregations;
      const at = [...path, name];
      if (!kind) continue;
      const def = node[kind];
      if (kind === "filter") {
        const w = toWhere(def, placeholders, out);
        if (!w) out.problems.push(`${at.join(" > ")}: a filter lenspack cannot express (${JSON.stringify(def).slice(0, 80)})`);
        else if (children) visit(children, at, [...where, ...w], buckets);
        else here[name] = leafOf(at, "count", undefined, [...where, ...w], buckets);
      } else if (kind === "filters") {
        for (const [label, q] of Object.entries((def.filters ?? {}) as Json)) {
          const w = toWhere(q, placeholders, out);
          if (!w) out.problems.push(`${[...at, label].join(" > ")}: a filter lenspack cannot express`);
          else if (children) visit(children, [...at, label], [...where, ...w], buckets);
          else here[label] = leafOf([...at, label], "count", undefined, [...where, ...w], buckets);
        }
      } else if (kind === "terms") {
        if (!def.field) {
          out.problems.push(`${at.join(" > ")}: terms over a script`);
          continue;
        }
        const b: Bucket = { kind: "terms", field: bare(def.field), size: def.size };
        if (children) visit(children, at, where, [...buckets, b]);
        else here[name] = leafOf(at, "count", undefined, where, [...buckets, b]);
      } else if (kind === "date_histogram") {
        const b: Bucket = { kind: "date", field: bare(def.field), interval: String(def.calendar_interval ?? def.interval ?? "day") };
        if (children) visit(children, at, where, [...buckets, b]);
        else here[name] = leafOf(at, "count", undefined, where, [...buckets, b]);
      } else if (METRICS[kind]) {
        if (!def.field) out.problems.push(`${at.join(" > ")}: ${kind} over a script`);
        else here[name] = leafOf(at, METRICS[kind]!, bare(def.field), where, buckets);
      } else if (kind === "scripted_metric" && isUniqueCount(def)) {
        here[name] = leafOf(at, "count_distinct", bare(def.params.fieldName), where, buckets);
      } else if (kind === "bucket_script") {
        scripts.push([name, def]);
      } else {
        out.problems.push(`${at.join(" > ")}: ${kind} aggregation`);
      }
    }
    // Pipeline scripts refer to their siblings, so they resolve after them.
    for (const [name, def] of scripts) {
      const at = [...path, name];
      const vars = def.buckets_path as Record<string, string>;
      const script = String(typeof def.script === "string" ? def.script : def.script?.source ?? "").trim();
      const sibling = (v: string) => here[String(vars?.[v] ?? "").split(">")[0]!];
      const scaled = script.match(/^\(?\s*params\.(\w+)\s*\)?\s*\*\s*([0-9]*\.?[0-9]+)$/);
      const ratio = script.match(/^\(?\s*\(?\s*params\.(\w+)\s*\/\s*params\.(\w+)\s*\)?\s*(\*\s*100)?\s*\)?$/);
      if (scaled && sibling(scaled[1]!)) {
        const base = sibling(scaled[1]!)!;
        here[name] = { ...base, path: at, scale: (base.scale ?? 1) * Number(scaled[2]) };
      } else if (ratio && sibling(ratio[1]!) && sibling(ratio[2]!)) {
        here[name] = { ...leafOf(at, "count", undefined, where, buckets), ratio: { numerator: sibling(ratio[1]!)!, denominator: sibling(ratio[2]!)!, percent: !!ratio[3] } };
      } else {
        out.problems.push(`${at.join(" > ")}: bucket_script "${script.slice(0, 60)}"`);
      }
    }
    out.leaves.push(...Object.values(here));
  };
  visit(root.aggs ?? root.aggregations ?? {}, [], [], []);
  return out;
}

function leafOf(path: string[], agg: Agg, field: string | undefined, where: Where[], buckets: Bucket[]): Leaf {
  return { path, agg, ...(field ? { field } : {}), where, buckets };
}
