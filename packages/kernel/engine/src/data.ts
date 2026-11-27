import { type FORMATS, type Grain, type Query, grainWords } from "@lenspack/core";

import type { BoundPlan } from "./resolve";

// What a widget draws, whatever computed it. Connectors hand back raw rows in
// one agreed shape (group / series / bucket / value / n / previous) and
// shapeBound turns them into this, so every backend labels, sorts and
// truncates the same way.

export type Row = Record<string, unknown>;

export type DataRow = {
  group: string;
  series?: string;
  value: number | null;
  count: number;
  /** A query's further measures for this group, by key. */
  values?: Record<string, number | null>;
  /** The same group in the previous period (a breakdown with compare). */
  compare?: { previous: number | null; delta: number | null };
  /** value over the whole population's value (a breakdown with share). */
  share?: number | null;
  /** The "(other)" row: the population outside the groups shown. */
  other?: true;
};

export type Format = (typeof FORMATS)[number];

export type WidgetData = {
  rows: DataRow[];
  records?: Row[];
  columns?: string[];
  total: number;
  format: Format;
  compare?: { previous: number | null; delta: number | null };
  /** An estimate (a search engine's distinct count or percentile), drawn with ≈. */
  approximate?: boolean;
  /** For a query with further measures: every measure drawn, the primary first. */
  measures?: { key: string; format: Format }[];
  /** What the answer leaves out on purpose: series past the top few, an operand no filter narrows, a cut. */
  notes?: string[];
  /** The source stopped at its row limit, so rows are missing (the notes say which); compute refuses such a base. */
  truncated?: true;
  /** A computed answer's name for its numbers ("average daily units dispatched"), drawn as the value's label. */
  label?: string;
  /** What was computed after the source answered, and how zeros and gaps were treated, in plain words. */
  computed?: string;
  /** For steps over time: the buckets they ran over, the first and the last (named as the rows name them) and how many. */
  window?: { from: string; to: string; buckets: number; grain: Grain };
  error?: string;
  hint?: string;
  /** Why the widget has no answer right now (a key it reads is unavailable), and where to fix it: drawn instead of an error. */
  notice?: { text: string; action?: { label: string; href: string } };
};

export const MAX_SERIES = 12;

/** A value against its previous period; delta is the relative change. */
export function compared(value: number | null, previous: number | null): { previous: number | null; delta: number | null } {
  return { previous, delta: value !== null && previous !== null && previous !== 0 ? (value - previous) / Math.abs(previous) : null };
}

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  // A driver's decimal or big-number object reads through its text.
  const n = typeof v === "number" ? v : typeof v === "string" || (typeof v === "object" && "toString" in v) ? Number(String(v)) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  // Epoch milliseconds, as a search engine keys its date buckets.
  if (typeof v === "number") return Number.isFinite(v) ? new Date(v) : null;
  if (typeof v === "string") {
    // Naive timestamps are UTC by convention throughout lenspack.
    const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(" ", "T")}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "object" && v !== null && "micros" in v) return new Date(Number((v as { micros: bigint }).micros / 1000n));
  if (typeof v === "object" && v !== null && "days" in v) return new Date(Number((v as { days: number }).days) * 86400e3);
  return null;
}

export function bucketLabel(v: unknown, grain: string): string {
  const d = toDate(v);
  if (!d) return String(v ?? "");
  const iso = d.toISOString();
  return grain === "hour" ? iso.slice(0, 13) + ":00" : iso.slice(0, 10);
}

export function groupLabel(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(none)";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

type Breakdown = Extract<Query, { kind: "breakdown" }>;

/**
 * A breakdown's rows in the order it asks for: by value, ties by group then
 * series (the default); by value alone, tied rows left as given ("measure");
 * by group then series ("group"); or as given ("none"). No value sorts last.
 */
export function sortGroups<R extends { group?: unknown; series?: unknown; value?: unknown }>(rows: R[], query: Pick<Breakdown, "sort" | "sortBy">): R[] {
  if (query.sortBy === "none") return rows;
  const dir = query.sort === "asc" ? 1 : -1;
  const text = (v: unknown) => String(v ?? "");
  const byValue = (a: R, b: R) => {
    const [x, y] = [toNumber(a.value), toNumber(b.value)];
    return x === null ? (y === null ? 0 : 1) : y === null ? -1 : (x - y) * dir;
  };
  const byName = (a: R, b: R) => text(a.group).localeCompare(text(b.group)) * (query.sortBy === "group" ? dir : 1) || text(a.series).localeCompare(text(b.series));
  return rows.sort(query.sortBy === "group" ? byName : query.sortBy === "measure" ? byValue : (a, b) => byValue(a, b) || byName(a, b));
}

/** Rows a source returns for a breakdown split by a second dimension, which limitGroups then cuts to its top groups. */
export const SPLIT_ROWS = 10_000;

/**
 * A breakdown's first `limit` groups, rows in the order given. Split by a
 * second dimension, the limit counts groups, not rows: every row of the top
 * groups, ranked by their total value in the sort's direction (ties by name,
 * or as given under "measure"), or taken in the order given when the
 * breakdown is sorted by group or not at all.
 */
export function limitGroups(rows: DataRow[], query: Pick<Breakdown, "by" | "limit" | "sort" | "sortBy">): DataRow[] {
  if (!query.by) return rows.slice(0, query.limit);
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.group, (totals.get(r.group) ?? 0) + (r.value ?? 0));
  const ranked = [...totals.keys()];
  if (query.sortBy !== "group" && query.sortBy !== "none") {
    const dir = query.sort === "asc" ? 1 : -1;
    ranked.sort((a, b) => (totals.get(a)! - totals.get(b)!) * dir || (query.sortBy === "measure" ? 0 : a.localeCompare(b)));
  }
  const keep = new Set(ranked.slice(0, query.limit));
  return rows.filter((r) => keep.has(r.group));
}

/** Rows a source returns for a series, computed or not: its buckets, times its series when split. */
export const SERIES_ROWS = 20_000;

/**
 * The most rows a source returns for a bound plan, where more would be a cut
 * rather than the answer: a series (latest buckets first), a split breakdown
 * (largest rows first). A source asks for one row more, so shapeBound can tell.
 * An unsplit breakdown's limit is its top N, not a cut, so it has none.
 */
export function rowCap(bound: BoundPlan): number | undefined {
  const cap = bound.query.kind === "series" ? (bound.base?.rows ?? SERIES_ROWS) : bound.query.kind === "breakdown" && bound.split ? SPLIT_ROWS : undefined;
  // A deployment's row limit (query safety) cuts it further.
  return cap !== undefined && bound.rowLimit !== undefined ? Math.min(cap, bound.rowLimit) : cap;
}

/**
 * A connector's raw rows for a bound plan → widget data, in its measure's
 * format. Past the plan's rowCap, or when the source says it left rows out
 * (`cut`), the answer is marked truncated and says what it shows: a series its
 * latest whole buckets, a split breakdown the groups ranked on the rows returned.
 */
export function shapeBound(raw: Row[], bound: BoundPlan, cut = false): WidgetData {
  const def = bound.measure?.def;
  const q = bound.query;
  const cap = rowCap(bound);
  const over = cap !== undefined && raw.length > cap;
  const shape = (rows: Row[]) => shapeRows(rows, q, def?.format ?? "number", def?.key, !!bound.base);
  if (!over && !cut) return shape(raw);
  const limit = over ? `has more than ${cap.toLocaleString("en")} rows` : "stops at its row limit";
  let note: string;
  let kept = raw;
  if (q.kind === "series") {
    if (over) kept = latestBuckets(raw, cap, q.grain);
    const n = new Set(kept.map((r) => bucketLabel(r.bucket, q.grain))).size;
    note = over
      ? `only the latest ${n.toLocaleString("en")} ${n === 1 ? q.grain : grainWords(q.grain).plural} are shown${q.by ? `, and series are ranked on those ${grainWords(q.grain).plural}` : ""}; the source ${limit} for this series`
      : `some series are left out; the source ${limit} for this series`;
  } else {
    if (over) kept = raw.slice(0, cap);
    note = `groups are ranked on part of the data; the source ${limit} for this breakdown`;
  }
  const data = shape(kept);
  return { ...data, truncated: true, notes: [...(data.notes ?? []), note] };
}

// A series cut at `cap` rows: its latest buckets, whichever order the source
// answered in, without the earliest one if the cut went through it (some of its
// series missing), unless that bucket is all there is.
function latestBuckets(raw: Row[], cap: number, grain: Grain): Row[] {
  const label = (r: Row) => bucketLabel(r.bucket, grain);
  const sorted = raw.map((r) => [label(r), r] as const).sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  const kept = sorted.slice(0, cap);
  const through = sorted[cap]?.[0];
  const whole = through !== undefined && kept.at(-1)?.[0] === through ? kept.filter(([l]) => l !== through) : kept;
  return (whole.length ? whole : kept).map(([, r]) => r);
}

/** A series' rows by bucket, then series A to Z: one order, whatever order the source answered in. */
export function sortSeries(rows: DataRow[]): DataRow[] {
  return rows.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : (a.series ?? "").localeCompare(b.series ?? "")));
}

/** Raw connector rows → widget data. `columns` names the record keys for a rows query. */
export function shapeRows(raw: Row[], query: Query, format: Format, measureKey?: string, allSeries = false): WidgetData {
  switch (query.kind) {
    case "breakdown": {
      const all = raw.map((r): DataRow => {
        const value = toNumber(r.value);
        return { group: groupLabel(r.group), ...("series" in r ? { series: groupLabel(r.series) } : {}), value, count: toNumber(r.n) ?? 0, ...("previous" in r ? { compare: compared(value, toNumber(r.previous)) } : {}) };
      });
      const rows = limitGroups(all, query);
      return { rows, total: rows.reduce((s, r) => s + r.count, 0), format };
    }
    case "series": {
      let notes: string[] | undefined;
      let rows: DataRow[] = sortSeries(
        raw.map((r) => ({
          group: bucketLabel(r.bucket, query.grain),
          ...("series" in r ? { series: groupLabel(r.series) } : {}),
          value: toNumber(r.value),
          count: toNumber(r.n) ?? 0,
        })),
      );
      if (query.by && !allSeries) {
        // Keep the top series by total value; the rest are dropped, never
        // bucketed as "other", so every number stays attributable.
        const totals = new Map<string, number>();
        for (const r of rows) totals.set(r.series!, (totals.get(r.series!) ?? 0) + (r.value ?? 0));
        const keep = new Set([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SERIES).map(([k]) => k));
        rows = rows.filter((r) => keep.has(r.series!));
        if (totals.size > keep.size) notes = [`top ${keep.size} of ${totals.size} series by total; ${totals.size - keep.size} left out`];
      }
      return { rows, total: rows.reduce((s, r) => s + r.count, 0), format, ...(notes ? { notes } : {}) };
    }
    case "value": {
      const r = raw[0] ?? {};
      const value = toNumber(r.value);
      const count = toNumber(r.n) ?? 0;
      const data: WidgetData = { rows: [{ group: measureKey ?? "value", value, count }], total: count, format };
      if ("previous" in r) data.compare = compared(value, toNumber(r.previous));
      return data;
    }
    case "rows": {
      const columns = query.columns;
      const records = raw.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] instanceof Date ? (r[c] as Date).toISOString() : typeof r[c] === "bigint" ? Number(r[c]) : r[c]])));
      return { rows: [], records, columns, total: records.length, format: "number" };
    }
    case "points": {
      // Connectors answer with lat, lon, color, label and size, and one row past the limit
      // so a cut list can say so. Records are keyed by the query's own keys.
      const columns = pointColumns(query);
      const cut = raw.length > query.limit;
      const records: Row[] = [];
      for (const r of raw.slice(0, query.limit)) {
        const lat = toNumber(r.lat);
        const lon = toNumber(r.lon);
        if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        const rec: Row = { lat, lon };
        if (query.label) rec[query.label] = r.label === null || r.label === undefined ? null : String(r.label);
        if (query.color) rec[query.color] = groupLabel(r.color);
        if (query.size) rec[query.size] = toNumber(r.size);
        records.push(rec);
      }
      const notes = cut ? [`the first ${query.limit} points only${query.size ? `, largest ${query.size} first` : ""}; there are more`] : undefined;
      return { rows: [], records, columns, total: records.length, format, ...(notes ? { notes } : {}) };
    }
  }
}

/** The record keys of a points answer, in reading order. */
export function pointColumns(query: Extract<Query, { kind: "points" }>): string[] {
  return ["lat", "lon", ...[query.label, query.color, query.size].filter((k): k is string => !!k)];
}
