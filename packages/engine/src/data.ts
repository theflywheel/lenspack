import type { Query } from "@lenspack/core";

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
};

export type Format = "number" | "percent" | "currency" | "compact" | "duration";

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
  error?: string;
  hint?: string;
};

export const MAX_SERIES = 12;

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
      const rows = raw.map((r) => ({ group: groupLabel(r.group), ...("series" in r ? { series: groupLabel(r.series) } : {}), value: toNumber(r.value), count: toNumber(r.n) ?? 0 }));
      return { rows, total: rows.reduce((s, r) => s + r.count, 0), format };
    }
    case "series": {
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
      }
      return { rows, total: rows.reduce((s, r) => s + r.count, 0), format };
    }
    case "value": {
      const r = raw[0] ?? {};
      const value = toNumber(r.value);
      const count = toNumber(r.n) ?? 0;
      const data: WidgetData = { rows: [{ group: measureKey ?? "value", value, count }], total: count, format };
      if ("previous" in r) {
        const previous = toNumber(r.previous);
        data.compare = { previous, delta: value !== null && previous !== null && previous !== 0 ? (value - previous) / Math.abs(previous) : null };
      }
      return data;
    }
    case "rows": {
      const columns = query.columns;
      const records = raw.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] instanceof Date ? (r[c] as Date).toISOString() : typeof r[c] === "bigint" ? Number(r[c]) : r[c]])));
      return { rows: [], records, columns, total: records.length, format: "number" };
    }
  }
}
