import type { DataCall } from "@lenspack/agent";
import { type Query, measured } from "@lenspack/core";
import { type SourceCall, type WidgetData, describeQuery } from "@lenspack/engine";
import type { Pack } from "@lenspack/pack";

// "How this was worked out", under every chat answer: for each data call the turn made, in order,
// the query in plain words (from the query itself, no model call), the statement the source ran,
// and the rows that came back. It is built from what the turn already did, as the tools ran: no
// query is run again to explain one. It goes to the person who asked, in their own turn's stream,
// and into the turn's audit line, bounded in size. A deployment can switch it off (`explain`),
// or keep the words and rows but not the SQL (`explain.sql: false`).

/** A deployment's choice, read per turn: on (the default) or off, and whether the statement is shown. */
export type ExplainSettings = { on?: boolean; sql?: boolean };

export type ExplainCell = string | number | boolean | null;
export type ExplainColumn = { key: string; label: string; format?: string };
export type ExplainStatement = { language: "sql" | "json"; text: string; params?: string[]; cachedAt?: string; note?: string };

export type ExplainedCall = {
  tool: "query" | "run_sql";
  /** The query in plain words: the approved measure, filters, dates, cut-offs, and each step computed after. */
  description: string;
  /** What the source ran, in the order it answered. Absent when the statement is not shown. */
  statements?: ExplainStatement[];
  /** Said when part of the answer was computed in Lenspack after the statement ran. */
  after?: string;
  columns: ExplainColumn[];
  /** The first rows behind the answer. */
  rows: ExplainCell[][];
  /** How many rows the answer had. */
  total: number;
  /** A saved answer, replayed from its stored plan: the data is as of this time. */
  saved?: { asOf: string };
};

export type Explanation = {
  calls: ExplainedCall[];
  /** Data calls left out to keep the record small. */
  more?: number;
  /** Whether statements were shown for this turn. */
  sql: boolean;
};

/** How large an explanation may grow: the turn's audit line carries it. */
export const EXPLAIN_LIMITS = { calls: 10, rows: 20, statements: 6, statementChars: 6000, params: 40, cellChars: 200, bytes: 32_000 };

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Anything in a statement that could carry a credential, masked: a URL's user and password, and a
 * `password=` style pair. Statements are compiled from the pack and never hold either, so this
 * is a second guard, not the first.
 */
export function maskCredentials(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, "$1***@")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(\s*[=:]\s*)('[^']*'|"[^"]*"|[^\s,;)]+)/gi, "$1$2***");
}

const cell = (v: unknown): ExplainCell => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  return cut(typeof v === "string" ? v : JSON.stringify(v), EXPLAIN_LIMITS.cellChars);
};

const param = (v: unknown) => cut(v instanceof Date ? v.toISOString() : typeof v === "string" ? `'${v}'` : JSON.stringify(v) ?? String(v), 200);

function statementOf(s: SourceCall): ExplainStatement {
  return {
    language: s.language,
    text: cut(maskCredentials(s.text), EXPLAIN_LIMITS.statementChars),
    ...(s.params?.length ? { params: s.params.slice(0, EXPLAIN_LIMITS.params).map((p) => maskCredentials(param(p))) } : {}),
    ...(s.cachedAt ? { cachedAt: s.cachedAt } : {}),
    ...(s.note ? { note: s.note } : {}),
  };
}

const labelOf = (pack: Pack, key: string) => pack.measures.find((m) => m.key === key)?.label ?? pack.dimensions.find((d) => d.key === key)?.label ?? key.replace(/_/g, " ");
const GRAIN_LABEL: Record<string, string> = { hour: "Hour", day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year" };

/** The rows behind a query's answer as a table: its own columns, named by the pack's labels. */
export function answerTable(query: Query, data: WidgetData, pack: Pack): { columns: ExplainColumn[]; rows: ExplainCell[][]; total: number } {
  if (query.kind === "rows" || query.kind === "points") {
    const records = data.records ?? [];
    const keys = query.kind === "rows" ? (data.columns ?? query.columns) : [...new Set(records.flatMap((r) => Object.keys(r)))];
    const named: Record<string, string> = query.kind === "points" ? { lat: "Latitude", lon: "Longitude", ...(query.color ? { color: labelOf(pack, query.color) } : {}), ...(query.label ? { label: labelOf(pack, query.label) } : {}), ...(query.size ? { size: labelOf(pack, query.size) } : {}) } : {};
    return {
      columns: keys.map((k) => ({ key: k, label: named[k] ?? labelOf(pack, k) })),
      rows: records.slice(0, EXPLAIN_LIMITS.rows).map((r) => keys.map((k) => cell(r[k]))),
      total: records.length,
    };
  }
  const rows = data.rows;
  const extra = query.measures ?? [];
  const has = (f: (r: WidgetData["rows"][number]) => unknown) => rows.some((r) => f(r) !== undefined);
  const columns: (ExplainColumn & { get: (r: WidgetData["rows"][number]) => unknown })[] = [];
  if (query.kind === "breakdown") columns.push({ key: "group", label: labelOf(pack, query.dimension), get: (r) => r.group });
  if (query.kind === "series") columns.push({ key: "group", label: GRAIN_LABEL[query.grain] ?? query.grain, get: (r) => r.group });
  if (query.kind !== "value" && has((r) => r.series) && query.by) columns.push({ key: "series", label: labelOf(pack, query.by), get: (r) => r.series });
  columns.push({ key: "value", label: data.label ? data.label.charAt(0).toUpperCase() + data.label.slice(1) : labelOf(pack, query.measure), format: data.format, get: (r) => r.value });
  for (const k of extra) columns.push({ key: k, label: labelOf(pack, k), format: data.measures?.find((m) => m.key === k)?.format, get: (r) => r.values?.[k] });
  if (has((r) => r.share)) columns.push({ key: "share", label: "Share", format: "percent", get: (r) => r.share });
  const compare = query.kind === "value" ? data.compare : undefined;
  if (compare || has((r) => r.compare)) {
    columns.push({ key: "previous", label: "Previous period", format: data.format, get: (r) => (r.compare ?? compare)?.previous });
    columns.push({ key: "change", label: "Change", format: "percent", get: (r) => (r.compare ?? compare)?.delta });
  }
  if (!(measured(query) && query.compute)) columns.push({ key: "count", label: "Records", get: (r) => r.count });
  return {
    columns: columns.map(({ get: _get, ...c }) => c),
    rows: rows.slice(0, EXPLAIN_LIMITS.rows).map((r) => columns.map((c) => cell(c.get(r)))),
    total: rows.length,
  };
}

export type ExplainContext = {
  pack: Pack;
  /** Statements are shown: the deployment allows it and the caller may see compiled statements. */
  sql: boolean;
  /** Measure definitions are named in the words: the caller may see what the pack file says. */
  definitions: boolean;
  /** The source's kind, for per-dialect definitions. */
  dialect?: string;
};

/** One data call, explained. */
export function explainCall(e: DataCall, o: ExplainContext): ExplainedCall {
  if (e.tool === "run_sql") {
    const keys = [...new Set(e.rows.flatMap((r) => Object.keys(r)))];
    return {
      tool: "run_sql",
      description: `A read-only SQL statement the assistant wrote itself, outside the pack's approved measures, so its numbers were not checked against the pack's definitions${e.truncated ? `; only the first ${e.rowCount} rows came back` : ""}.`,
      ...(o.sql ? { statements: [{ language: "sql" as const, text: cut(maskCredentials(e.sql), EXPLAIN_LIMITS.statementChars) }] } : {}),
      columns: keys.map((k) => ({ key: k, label: k })),
      rows: e.rows.slice(0, EXPLAIN_LIMITS.rows).map((r) => keys.map((k) => cell(r[k]))),
      total: e.rowCount,
    };
  }
  const { query, data } = e;
  const description = describeQuery(query, o.pack, { now: e.now, definitions: o.definitions, dialect: o.dialect, data });
  const computed = measured(query) && !!query.compute;
  const statements = e.sources.slice(0, EXPLAIN_LIMITS.statements).map(statementOf);
  const after = computed
    ? "The steps that start with “Then” ran in Lenspack, on the numbers the statement returned, not in the database."
    : e.sources.length > 1
      ? "Lenspack put these statements' answers together into the rows below."
      : undefined;
  return {
    tool: "query",
    description,
    ...(o.sql && statements.length ? { statements } : {}),
    ...(after ? { after } : {}),
    ...answerTable(query, data, o.pack),
  };
}

/** A call from a saved answer: its stored explanation, said to be as of when its data was read. */
export function savedCall(call: ExplainedCall, asOf: string | Date): ExplainedCall {
  return { ...call, saved: { asOf: asOf instanceof Date ? asOf.toISOString() : asOf } };
}

const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x), "utf8");

/**
 * The explanation within EXPLAIN_LIMITS.bytes: fewer rows first, then shorter statements, then
 * fewer calls (counted in `more`). What is left is never cut mid-row.
 */
export function boundExplanation(x: Explanation, maxBytes = EXPLAIN_LIMITS.bytes): Explanation {
  let out: Explanation = { ...x, calls: x.calls.slice(0, EXPLAIN_LIMITS.calls), ...(x.calls.length > EXPLAIN_LIMITS.calls || x.more ? { more: (x.more ?? 0) + Math.max(0, x.calls.length - EXPLAIN_LIMITS.calls) } : {}) };
  const shrink = [
    (c: ExplainedCall): ExplainedCall => ({ ...c, rows: c.rows.slice(0, 10) }),
    (c: ExplainedCall): ExplainedCall => ({ ...c, statements: c.statements?.map((s) => ({ ...s, text: cut(s.text, 2000), params: s.params?.slice(0, 10) })) }),
    (c: ExplainedCall): ExplainedCall => ({ ...c, rows: c.rows.slice(0, 5), statements: c.statements?.slice(0, 2) }),
  ];
  for (const f of shrink) {
    if (size(out) <= maxBytes) return out;
    out = { ...out, calls: out.calls.map(f) };
  }
  while (size(out) > maxBytes && out.calls.length > 1) out = { ...out, calls: out.calls.slice(0, -1), more: (out.more ?? 0) + 1 };
  return out;
}

/** A turn's explanation, gathered as its tools run: onData for boardTools, record() when the turn ends. */
export function turnExplainer(o: ExplainContext) {
  const calls: ExplainedCall[] = [];
  return {
    onData(e: DataCall) {
      calls.push(explainCall(e, o));
    },
    /** The bounded explanation, or null for a turn that read no data. */
    record(): Explanation | null {
      return calls.length ? boundExplanation({ calls, sql: o.sql }) : null;
    },
  };
}
