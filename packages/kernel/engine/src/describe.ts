import { type ComputeStep, type FilterClause, type Grain, type MeasuredQuery, type Query, type TimeRange, computeGrain, measured } from "@lenspack/core";
import { type Pack, type PackMeasure, type Where, maybeFragmentFor, natureOf } from "@lenspack/pack";

import { localDate } from "./calendar";
import type { WidgetData } from "./data";
import { type Ctx, nowOf, timeWindowOf } from "./resolve";

// A query in plain words, for the "how this was worked out" line under a chat answer. Built from
// the query itself and the pack's own labels and definitions, the same way every time: no model
// writes it, so it cannot claim what the query did not do. It names the approved measure each
// number came from, the filters, the dates (and the time zone, when it is not UTC), any cut-off,
// and each step Lenspack computed after the source answered.

export type DescribeOptions = {
  /** The clock the query ran on, so relative windows ("the last 30 days") are named as the dates they were. */
  now?: Date;
  /**
   * Show each measure's definition (`sum of total_cents / 100.0`). Off for a caller who is not
   * shown the compiled statement either: a definition reads like the pack file.
   */
  definitions?: boolean;
  /** The source's dialect, to pick a per-dialect fragment for a definition. */
  dialect?: string;
  /** The answer, for what only it knows: the buckets a step over time ran over, notes, estimates. */
  data?: Pick<WidgetData, "window" | "notes" | "approximate" | "truncated">;
  ctx?: Ctx;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const UNIT_WORDS: Record<string, [string, string]> = { h: ["hour", "hours"], d: ["day", "days"], w: ["week", "weeks"], m: ["month", "months"], y: ["year", "years"] };
const AGG_WORDS: Record<string, string> = { count: "count", count_distinct: "number of distinct", sum: "sum", avg: "average", min: "lowest", max: "highest", median: "median", p90: "90th percentile" };
const OP_WORDS: Record<string, string> = { eq: "=", neq: "is not", gt: ">", gte: "≥", lt: "<", lte: "≤" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quoted = (v: unknown) => (typeof v === "string" ? v : String(v));
const listOf = (items: string[], and = "and") => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "2025-09-01" and "2025-09-07" → "1 to 7 September 2025"; across months or years, each end says more. */
export function dateSpan(from: string, to: string): string {
  const parse = (d: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return from === to ? from : `${from} to ${to}`;
  const name = (x: { m: number }) => MONTHS[x.m - 1];
  if (from.slice(0, 10) === to.slice(0, 10)) return `${a.d} ${name(a)} ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d} to ${b.d} ${name(b)} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${name(a)} to ${b.d} ${name(b)} ${b.y}`;
  return `${a.d} ${name(a)} ${a.y} to ${b.d} ${name(b)} ${b.y}`;
}

/** A bucket label as the rows name it ("2026-03-01", "2026-03", "2026-W10") in words where it is a date. */
const bucketSpan = (from: string, to: string) => (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) ? dateSpan(from, to) : from === to ? from : `${from} to ${to}`);

const fragmentText = (f: Parameters<typeof maybeFragmentFor>[0] | undefined, dialect?: string) =>
  f === undefined ? undefined : (maybeFragmentFor(f, dialect ?? "default", true) ?? maybeFragmentFor(f, "default", true) ?? (typeof f === "object" ? Object.values(f).find(Boolean) : undefined));

const whereText = (w: Where) =>
  w.op === "exists" ? `${w.field} is present` : w.op === "missing" ? `${w.field} is missing` : w.op === "in" ? `${w.field} in (${(w.value as unknown[]).map(quoted).join(", ")})` : `${w.field} ${OP_WORDS[w.op] ?? w.op} ${quoted(w.value)}`;

const labelOf = (pack: Pack, key: string) => pack.measures.find((m) => m.key === key)?.label ?? pack.dimensions.find((d) => d.key === key)?.label ?? key.replace(/_/g, " ");
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** A measure's definition from the pack, in words: "sum of total_cents / 100.0, only where status = 'paid'". */
export function measureDefinition(pack: Pack, m: PackMeasure, dialect?: string): string {
  if (m.derived) return m.derived.trim().replace(/\s+/g, " ");
  if (m.levels) return `read at the level viewed (${Object.values(m.levels).join(", ")})`;
  const agg = m.agg ?? "count";
  const what = fragmentText(m.sql, dialect) ?? m.field;
  let text: string;
  if (m.per) {
    const key = typeof m.per.key === "string" ? m.per.key : (fragmentText(m.per.key.sql, dialect) ?? "a key");
    const inner = m.per.agg === "count" ? `records` : `${AGG_WORDS[m.per.agg] ?? m.per.agg} of ${fragmentText(m.per.sql, dialect) ?? m.per.field ?? "a value"}`;
    text = `${AGG_WORDS[agg] ?? agg}, over each ${key}, of its ${inner}`;
    if (m.per.having) text += `, counting a ${key} only when that is ${m.per.having.op === "between" ? `between ${m.per.having.value[0]} and ${m.per.having.value[1]}` : `${OP_WORDS[m.per.having.op] ?? m.per.having.op} ${m.per.having.value}`}`;
  } else if (agg === "count") {
    const grain = pack.entities[m.entity]?.grain;
    text = what ? `count of ${what} values` : `count of rows in ${m.entity}${grain ? ` (${grain})` : ""}`;
  }
  else text = `${AGG_WORDS[agg] ?? agg} of ${what ?? m.entity}`;
  const only = [fragmentText(m.filter, dialect), ...(m.where ?? []).map(whereText)].filter(Boolean);
  if (only.length) text += `, only where ${only.join(" and ")}`;
  if (m.scale !== undefined) text += `, times ${m.scale}`;
  return text;
}

/** "Amount (sum of amount_cents / 100.0, the pack's approved measure “amount”)". */
function measureWords(pack: Pack, key: string, o: DescribeOptions): string {
  const m = pack.measures.find((x) => x.key === key);
  if (!m) return key;
  const approved = m.verified === false ? `“${key}”, a proposed measure not yet approved` : `the pack's approved measure “${key}”`;
  return `${m.label ?? key} (${o.definitions ? `${measureDefinition(pack, m, o.dialect)}, ` : ""}${approved})`;
}

const VALUE_OPS: Record<string, string> = { eq: "=", neq: "is not", gte: "≥", lte: "≤", contains: "contains" };

function filterWords(pack: Pack, f: FilterClause): string {
  const name = labelOf(pack, f.dimension);
  const values = (Array.isArray(f.value) ? f.value : [f.value]).map(quoted);
  switch (f.op) {
    case "in":
      return values.length === 1 ? `${name} = ${values[0]}` : `${name} is one of ${listOf(values, "or")}`;
    case "between":
      return `${name} between ${values[0]} and ${values[1] ?? values[0]}`;
    case "subtree":
      return `${name} is ${listOf(values, "or")} or anything under it`;
    case "segment":
      return `${name} includes ${listOf(values, "or")}`;
    case "neq":
      return values.length > 1 ? `${name} is none of ${listOf(values, "or")}` : `${name} is not ${values[0]}`;
    default:
      return `${name} ${VALUE_OPS[f.op] ?? f.op} ${values.join(", ")}`;
  }
}

/** The dates a query's window covered, in the pack's zone, with how it was asked for. */
function timeWords(query: Query, pack: Pack, o: DescribeOptions): string | null {
  const t = query.time as TimeRange | undefined;
  if (!t) return null;
  const now = o.now ?? nowOf(o.ctx);
  const w = timeWindowOf(query, pack, { ...o.ctx, now });
  const zone = pack.timeZone ?? "UTC";
  const dates = w ? dateSpan(localDate(w.from, zone), localDate(new Date(Math.max(w.from.getTime(), w.to.getTime() - 1)), zone)) : null;
  if ("from" in t) return dates ? `from ${dates}` : null;
  if ("last" in t) {
    const n = Number(t.last.slice(0, -1));
    const [one, many] = UNIT_WORDS[t.last.slice(-1)] ?? ["period", "periods"];
    const words = n === 1 ? `the last ${one}` : `the last ${n} ${many}`;
    return dates ? `in ${words} (${dates})` : `in ${words}`;
  }
  const offset = t.offset ?? 0;
  const count = t.count ?? 1;
  const words =
    offset === 0 && count === 1
      ? `this ${t.period} so far`
      : offset === -1 && count === 1
        ? `last ${t.period}`
        : offset === -1
          ? `the ${count} whole ${t.period}s before this one`
          : offset === 0
            ? `the last ${count} ${t.period}s, this one so far included`
            : null;
  return words && dates ? `${words} (${dates})` : dates ? `from ${dates}` : words;
}

const SUMMARY: Record<string, [string, string]> = {
  mean: ["averaged", "average"],
  sum: ["added up", "total"],
  min: ["taking the lowest", "lowest"],
  max: ["taking the highest", "highest"],
  median: ["taking the median", "median"],
  last: ["taking the latest", "latest"],
};

/** Each compute step as a sentence, in order: what Lenspack did with the numbers after the source answered. */
export function computeWords(query: MeasuredQuery, pack: Pack, o: DescribeOptions = {}): string[] {
  const steps = query.compute?.steps ?? [];
  if (!steps.length) return [];
  const grain: Grain = computeGrain(query) ?? "day";
  const level = natureOf(pack, query.measure) === "level";
  const measureName = lower(labelOf(pack, query.measure));
  const window = o.data?.window;
  const over = window ? ` over ${plural(window.buckets, window.grain)} (${bucketSpan(window.from, window.to)})` : "";
  let gaps = level;
  return steps.map((s: ComputeStep, i) => {
    const then = i === 0 ? "Then" : "After that,";
    switch (s.op) {
      case "ratio":
        gaps = true;
        return `${then} divided by ${measureWords(pack, s.to, o)}${query.kind === "value" ? "" : ` for each ${query.kind === "series" ? grain : "group"}`}${s.percent ? ", as a percentage" : ""}; where ${lower(labelOf(pack, s.to))} is 0 or missing there is no ratio.`;
      case "change":
        gaps = true;
        return `${then} the ${s.percent ? "percentage " : ""}change from each ${grain} to the next${s.percent ? "; a change from 0 has no percentage" : ""}.`;
      case "rolling":
        return `${then} a rolling ${s.window}-${grain} ${s.fn === "mean" ? "average" : "sum"}; the first ${plural(s.window - 1, grain)} have no full window and are left out.`;
      case "running_total":
        return `${then} a running total from the first ${grain} shown.`;
      case "over_time": {
        const [verb] = SUMMARY[s.fn] ?? ["summarised", s.fn];
        const empty = i === 0 ? (level ? `${grain}s with no records skipped, as they have no value` : `${grain}s that had no ${measureName} counted as 0`) : gaps ? `${grain}s without a value skipped` : "";
        return `${then} ${verb} per ${grain}${over}${empty ? `, with ${empty}` : ""}.`;
      }
    }
  });
}

/** Which way a list is ordered, in the words its values call for. */
function orderWords(pack: Pack, key: string, dir: "asc" | "desc"): string {
  const type = pack.dimensions.find((d) => d.key === key)?.type;
  if (type === "number") return dir === "asc" ? "lowest first" : "highest first";
  if (type === "time") return dir === "asc" ? "oldest first" : "newest first";
  return dir === "asc" ? "A to Z" : "Z to A";
}

/**
 * The whole query in plain words: what was measured (and the approved measure behind it), for
 * which rows, over which dates, grouped how, cut where, and what was computed after. Deterministic.
 */
export function describeQuery(query: Query, pack: Pack, o: DescribeOptions = {}): string {
  const parts: string[] = [];
  const zone = pack.timeZone && pack.timeZone !== "UTC" ? pack.timeZone : null;
  const filters = (query.filters ?? []).map((f) => filterWords(pack, f));
  const when = timeWords(query, pack, o);
  const scope = [filters.length ? `for ${listOf(filters)}` : "", when ?? (query.kind === "rows" || query.kind === "points" ? "" : "over all dates")].filter(Boolean).join(", ");

  if (query.kind === "rows") {
    const entity = pack.entities[query.entity];
    const cols = query.columns.map((c) => labelOf(pack, c));
    parts.push(`Records of ${query.entity}${entity?.grain ? ` (${entity.grain})` : ""}, showing ${listOf(cols)}`);
    if (scope) parts.push(scope);
    const order = query.orderBy ? `, ordered by ${labelOf(pack, query.orderBy.key)}, ${orderWords(pack, query.orderBy.key, query.orderBy.dir)}` : "";
    parts.push(`first ${plural(query.limit, "row")}${query.offset ? ` after skipping ${query.offset}` : ""}${order}`);
  } else if (query.kind === "points") {
    const extra = [query.color ? `coloured by ${labelOf(pack, query.color)}` : "", query.size ? `sized by ${measureWords(pack, query.size, o)}` : "", query.label ? `named by ${labelOf(pack, query.label)}` : ""].filter(Boolean);
    parts.push(`Locations of ${query.entity}, one point per location${extra.length ? `, ${listOf(extra)}` : ""}`);
    if (scope) parts.push(scope);
    parts.push(`at most ${plural(query.limit, "point")}${query.size ? ", the largest kept" : ""}; records without coordinates are left out`);
  } else {
    const further = query.measures?.length ? `, beside ${listOf(query.measures.map((k) => measureWords(pack, k, o)))}` : "";
    parts.push(`${capital(measureWords(pack, query.measure, o))}${further}`);
    if (scope) parts.push(scope);
    if (query.kind === "breakdown") {
      const split = query.by ? `, split by ${labelOf(pack, query.by)}` : "";
      const sortBy = query.sortBy ?? "value";
      const cut =
        sortBy === "group"
          ? `first ${query.limit} by ${lower(labelOf(pack, query.dimension))}, ${query.sort === "asc" ? "A to Z" : "Z to A"}`
          : sortBy === "none"
            ? `first ${query.limit} in the source's order`
            : `${query.sort === "asc" ? "bottom" : "top"} ${query.limit} by value`;
      parts.push(`grouped by ${lower(labelOf(pack, query.dimension))}${split}, ${cut}`);
      if (query.share) parts.push("with each group's share of the whole");
      if (query.other) parts.push(`the rest added up as one "(other)" row`);
      if (query.compare) parts.push("each group beside its value in the period just before");
    } else if (query.kind === "series") {
      parts.push(`per ${query.grain}${query.by ? `, one line per ${lower(labelOf(pack, query.by))} (the top 12 by total)` : ""}`);
    } else if (query.compare) parts.push("beside its value in the period just before");
  }

  let text = parts.join(", ");
  if (zone && (query.time || query.kind === "series" || (measured(query) && query.compute))) text += `, with days in ${zone} time`;
  text += ".";
  if (measured(query)) for (const s of computeWords(query, pack, o)) text += ` ${s}`;
  const notes = [...(o.data?.notes ?? []), ...(o.data?.truncated ? ["the source stopped at its row limit, so some rows are missing"] : []), ...(o.data?.approximate ? ["some numbers are the source's estimates"] : [])];
  if (notes.length) text += ` Note: ${notes.join("; ")}.`;
  return text;
}
