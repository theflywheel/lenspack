import type { BoardConfig, Query, Widget } from "@lenspack/core";
import type { Pack } from "@lenspack/spec";

import { type Compiled, compile } from "./compile";
import type { Dialect } from "./print/base";
import { type Ctx, ResolveError } from "./resolve";

// The executor is the only thing that touches a database. Read-only and a
// statement timeout are its responsibility, never the SQL's.

export type Row = Record<string, unknown>;

export interface Executor {
  readonly dialect: Dialect;
  query(sql: string, params: unknown[], opts?: { timeoutMs?: number }): Promise<Row[]>;
}

/** Writes, for seeding examples and for the SQL board store. Never handed to the model. */
export interface Writer {
  exec(sql: string, params?: unknown[]): Promise<Row[]>;
}

export type DataRow = { group: string; series?: string; value: number | null; count: number };

export type WidgetData = {
  rows: DataRow[];
  records?: Row[];
  columns?: string[];
  total: number;
  format: "number" | "percent" | "currency" | "compact" | "duration";
  compare?: { previous: number | null; delta: number | null };
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

/** Runs one compiled query and shapes the rows for a widget. */
export async function execute(compiled: Compiled, executor: Executor, pack: Pack, opts: { timeoutMs?: number } = {}): Promise<WidgetData> {
  const raw = await executor.query(compiled.sql, compiled.params, opts);
  const measureDef = compiled.bound.measure?.def;
  const format = measureDef?.format ?? "number";
  const q = compiled.bound.query;

  switch (compiled.shape) {
    case "breakdown": {
      const rows = raw.map((r) => ({ group: groupLabel(r.group), value: toNumber(r.value), count: toNumber(r.n) ?? 0 }));
      return { rows, total: rows.reduce((s, r) => s + r.count, 0), format };
    }
    case "series": {
      const grain = q.kind === "series" ? q.grain : "day";
      let rows: DataRow[] = raw.map((r) => ({
        group: bucketLabel(r.bucket, grain),
        ...("series" in r ? { series: groupLabel(r.series) } : {}),
        value: toNumber(r.value),
        count: toNumber(r.n) ?? 0,
      }));
      if (q.kind === "series" && q.by) {
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
      const data: WidgetData = { rows: [{ group: measureDef?.key ?? "value", value, count }], total: count, format };
      if ("previous" in r) {
        const previous = toNumber(r.previous);
        data.compare = { previous, delta: value !== null && previous !== null && previous !== 0 ? (value - previous) / Math.abs(previous) : null };
      }
      return data;
    }
    case "rows": {
      const columns = q.kind === "rows" ? q.columns : Object.keys(raw[0] ?? {});
      const records = raw.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] instanceof Date ? (r[c] as Date).toISOString() : typeof r[c] === "bigint" ? Number(r[c]) : r[c]])));
      return { rows: [], records, columns, total: records.length, format: "number" };
    }
  }
}

export type RunOptions = { pack: Pack; executor: Executor; ctx?: Ctx; timeoutMs?: number };

/** Compile and run one query. Resolution errors come back as data, not throws. */
export async function run(query: Query, opts: RunOptions): Promise<WidgetData> {
  let compiled: Compiled;
  try {
    compiled = compile(query, opts.pack, { dialect: opts.executor.dialect, ctx: opts.ctx });
  } catch (e) {
    if (e instanceof ResolveError) return { rows: [], total: 0, format: "number", error: e.message, hint: e.nearest };
    throw e;
  }
  return execute(compiled, opts.executor, opts.pack, { timeoutMs: opts.timeoutMs });
}

// Merges a board's filter selections into a widget's own filter clauses. A
// filter narrows only the widgets it says it applies to.
export function widgetQuery(config: BoardConfig, id: string, widget: Widget, selections: Record<string, string> = {}): Query | null {
  if (widget.kind === "text") return null;
  const extra = config.filters
    .filter((f) => selections[f.field] && (f.applies.includes("*") || f.applies.includes(id)))
    .map((f) => ({ dimension: f.field, op: "eq" as const, value: selections[f.field]! }));
  if (extra.length === 0) return widget.query;
  return { ...widget.query, filters: [...(widget.query.filters ?? []), ...extra] } as Query;
}

/**
 * One pass over a board, resolving each widget. Identical queries run once:
 * three widgets drawing the same breakdown differently should cost one scan.
 */
export async function resolveBoard(config: BoardConfig, opts: RunOptions, selections: Record<string, string> = {}): Promise<Record<string, WidgetData>> {
  const byKey = new Map<string, Promise<WidgetData>>();
  const data: Record<string, WidgetData> = {};
  await Promise.all(
    Object.entries(config.widgets).map(async ([id, widget]) => {
      const query = widgetQuery(config, id, widget, selections);
      if (!query) return;
      const key = JSON.stringify(query);
      if (!byKey.has(key)) byKey.set(key, run(query, opts));
      try {
        data[id] = await byKey.get(key)!;
      } catch (error) {
        // One widget that cannot load must not take the board down with it.
        data[id] = { rows: [], total: 0, format: "number", error: String(error instanceof Error ? error.message : error).slice(0, 200) };
      }
    }),
  );
  return data;
}

/** Distinct values of a dimension, for filter controls. */
export async function dimensionValues(dimension: string, opts: RunOptions, limit = 50) {
  const measure = opts.pack.measures.find((m) => m.agg === "count" && m.entity === opts.pack.dimensions.find((d) => d.key === dimension)?.entity)
    ?? opts.pack.measures.find((m) => m.agg === "count");
  if (!measure) return [];
  const data = await run({ kind: "breakdown", dimension, measure: measure.key, limit: Math.min(50, limit), sort: "desc" }, opts);
  return data.rows.map((r) => ({ value: r.group, count: r.count }));
}
