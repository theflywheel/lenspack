import type { FORMATS, Query } from "@lenspack/core";

// What a widget draws, whatever computed it. Connectors hand back raw rows in
// one agreed shape (group / series / bucket / value / n / previous) and
// shapeRows turns them into this, so every backend labels, sorts and
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
  /** What the answer leaves out on purpose: series past the top few, an operand no filter narrows. */
  notes?: string[];
  error?: string;
  hint?: string;
};

export const MAX_SERIES = 12;

/** A value against its previous period; delta is the relative change. */
export function compared(value: number | null, previous: number | null): { previous: number | null; delta: number | null } {
  return { previous, delta: value !== null && previous !== null && previous !== 0 ? (value - previous) / Math.abs(previous) : null };
}

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object" && v !== null && "toString" in v) {
    const n = Number(String(v));
    return Number.isFinite(n) ? n : null;
  }
  return null;
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

/** Raw connector rows → widget data. `columns` names the record keys for a rows query. */
export function shapeRows(raw: Row[], query: Query, format: Format, measureKey?: string): WidgetData {
  switch (query.kind) {
    case "breakdown": {
      const rows = raw.map((r): DataRow => {
        const value = toNumber(r.value);
        return { group: groupLabel(r.group), ...("series" in r ? { series: groupLabel(r.series) } : {}), value, count: toNumber(r.n) ?? 0, ...("previous" in r ? { compare: compared(value, toNumber(r.previous)) } : {}) };
      });
      return { rows, total: rows.reduce((s, r) => s + r.count, 0), format };
    }
    case "series": {
      let notes: string[] | undefined;
      let rows: DataRow[] = raw.map((r) => ({
        group: bucketLabel(r.bucket, query.grain),
        ...("series" in r ? { series: groupLabel(r.series) } : {}),
        value: toNumber(r.value),
        count: toNumber(r.n) ?? 0,
      }));
      if (query.by) {
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
