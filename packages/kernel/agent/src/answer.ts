import { type Query, measured } from "@lenspack/core";
import { type SourceCall, type WidgetData, describeQuery } from "@lenspack/engine";
import type { Pack } from "@lenspack/pack";
import type { AnswerView } from "@lenspack/policy";

import type { DataCall } from "./tools";

// The answer card: "How this was worked out", under every chat answer. For each data call the turn
// made, in order: the query in plain words (from the query itself, no model call), the statement
// the source ran, and the rows that came back; and the dashboard filters the viewer had picked
// when they asked. It is built from what the turn already did, as the tools ran: no query is run
// again to explain one.
//
// This is turn logic, so it knows nothing of HTTP or of any host: a host (or runTurn) makes one
// card per turn, hands its onData to boardTools, and sends record() to the person who asked. What
// the card may show (the SQL, the definitions) is decided by @lenspack/policy's answerView. Checks
// on the reply (a grounding check: every number in the reply is in a tool result) attach to the
// same card with check(), reading the full results from calls().

export type AnswerCell = string | number | boolean | null;
export type AnswerColumn = { key: string; label: string; format?: string };
export type AnswerStatement = { language: "sql" | "json"; text: string; params?: string[]; cachedAt?: string; note?: string };

export type AnswerCall = {
  tool: "query" | "run_sql";
  /** The query in plain words: the approved measure, filters, dates, cut-offs, and each step computed after. */
  description: string;
  /** What the source ran, in the order it answered. Absent when the statement is not shown. */
  statements?: AnswerStatement[];
  /** Said when part of the answer was computed in Lenspack after the statement ran. */
  after?: string;
  columns: AnswerColumn[];
  /** The first rows behind the answer. */
  rows: AnswerCell[][];
  /** How many rows the answer had. */
  total: number;
  /** A saved answer, replayed from its stored plan: the data is as of this time. */
  saved?: { asOf: string };
};

/** One dashboard filter the viewer had picked when they asked. */
export type AnswerSelection = {
  field: string;
  /** The pack's label for the field. */
  label: string;
  value: string;
  /** Every data call in the turn was filtered on this field: the answer is for this selection. */
  applied: boolean;
};

/**
 * A check on the reply, attached to its card: a grounding check (every number in the reply is in
 * a tool result), or any other check made in code. `items` names what failed, in words.
 */
export type AnswerCheck = { kind: string; ok: boolean; summary: string; items?: string[] };

export type AnswerCard = {
  calls: AnswerCall[];
  /** Data calls left out to keep the record small. */
  more?: number;
  /** Whether statements were shown for this turn. */
  sql: boolean;
  /** The viewer's dashboard filters when they asked: part of the turn's context. */
  selections?: AnswerSelection[];
  checks?: AnswerCheck[];
};

/** How large an answer card may grow: the turn's audit line carries it. */
export const ANSWER_LIMITS = { calls: 10, rows: 20, statements: 6, statementChars: 6000, params: 40, cellChars: 200, bytes: 32_000 };

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

const cell = (v: unknown): AnswerCell => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  return cut(typeof v === "string" ? v : JSON.stringify(v), ANSWER_LIMITS.cellChars);
};

const param = (v: unknown) => cut(v instanceof Date ? v.toISOString() : typeof v === "string" ? `'${v}'` : JSON.stringify(v) ?? String(v), 200);

function statementOf(s: SourceCall): AnswerStatement {
  return {
    language: s.language,
    text: cut(maskCredentials(s.text), ANSWER_LIMITS.statementChars),
    ...(s.params?.length ? { params: s.params.slice(0, ANSWER_LIMITS.params).map((p) => maskCredentials(param(p))) } : {}),
    ...(s.cachedAt ? { cachedAt: s.cachedAt } : {}),
    ...(s.note ? { note: s.note } : {}),
  };
}

const labelOf = (pack: Pack, key: string) => pack.measures.find((m) => m.key === key)?.label ?? pack.dimensions.find((d) => d.key === key)?.label ?? key.replace(/_/g, " ");
const GRAIN_LABEL: Record<string, string> = { hour: "Hour", day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year" };

/** The rows behind a query's answer as a table: its own columns, named by the pack's labels. */
export function answerTable(query: Query, data: WidgetData, pack: Pack): { columns: AnswerColumn[]; rows: AnswerCell[][]; total: number } {
  if (query.kind === "rows" || query.kind === "points") {
    const records = data.records ?? [];
    const keys = query.kind === "rows" ? (data.columns ?? query.columns) : [...new Set(records.flatMap((r) => Object.keys(r)))];
    const named: Record<string, string> = query.kind === "points" ? { lat: "Latitude", lon: "Longitude", ...(query.color ? { color: labelOf(pack, query.color) } : {}), ...(query.label ? { label: labelOf(pack, query.label) } : {}), ...(query.size ? { size: labelOf(pack, query.size) } : {}) } : {};
    return {
      columns: keys.map((k) => ({ key: k, label: named[k] ?? labelOf(pack, k) })),
      rows: records.slice(0, ANSWER_LIMITS.rows).map((r) => keys.map((k) => cell(r[k]))),
      total: records.length,
    };
  }
  const rows = data.rows;
  const extra = query.measures ?? [];
  const has = (f: (r: WidgetData["rows"][number]) => unknown) => rows.some((r) => f(r) !== undefined);
  const columns: (AnswerColumn & { get: (r: WidgetData["rows"][number]) => unknown })[] = [];
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
    rows: rows.slice(0, ANSWER_LIMITS.rows).map((r) => columns.map((c) => cell(c.get(r)))),
    total: rows.length,
  };
}

export type AnswerContext = AnswerView & {
  pack: Pack;
  /** The source's kind, for per-dialect definitions. */
  dialect?: string;
};

/** One data call, explained. */
export function answerCall(e: DataCall, o: AnswerContext): AnswerCall {
  if (e.tool === "run_sql") {
    const keys = [...new Set(e.rows.flatMap((r) => Object.keys(r)))];
    return {
      tool: "run_sql",
      description: `A read-only SQL statement the assistant wrote itself, outside the pack's approved measures, so its numbers were not checked against the pack's definitions${e.truncated ? `; only the first ${e.rowCount} rows came back` : ""}.`,
      ...(o.sql ? { statements: [{ language: "sql" as const, text: cut(maskCredentials(e.sql), ANSWER_LIMITS.statementChars) }] } : {}),
      columns: keys.map((k) => ({ key: k, label: k })),
      rows: e.rows.slice(0, ANSWER_LIMITS.rows).map((r) => keys.map((k) => cell(r[k]))),
      total: e.rowCount,
    };
  }
  const { query, data } = e;
  const description = describeQuery(query, o.pack, { now: e.now, definitions: o.definitions, dialect: o.dialect, data });
  const computed = measured(query) && !!query.compute;
  const statements = e.sources.slice(0, ANSWER_LIMITS.statements).map(statementOf);
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

/** A call from a saved answer: its stored card entry, said to be as of when its data was read. */
export function savedCall(call: AnswerCall, asOf: string | Date): AnswerCall {
  return { ...call, saved: { asOf: asOf instanceof Date ? asOf.toISOString() : asOf } };
}

const encoder = new TextEncoder();
const size = (x: unknown) => encoder.encode(JSON.stringify(x)).length;

/**
 * The card within ANSWER_LIMITS.bytes: fewer rows first, then shorter statements, then
 * fewer calls (counted in `more`). What is left is never cut mid-row.
 */
export function boundCard(x: AnswerCard, maxBytes = ANSWER_LIMITS.bytes): AnswerCard {
  let out: AnswerCard = { ...x, calls: x.calls.slice(0, ANSWER_LIMITS.calls), ...(x.calls.length > ANSWER_LIMITS.calls || x.more ? { more: (x.more ?? 0) + Math.max(0, x.calls.length - ANSWER_LIMITS.calls) } : {}) };
  const shrink = [
    (c: AnswerCall): AnswerCall => ({ ...c, rows: c.rows.slice(0, 10) }),
    (c: AnswerCall): AnswerCall => ({ ...c, statements: c.statements?.map((s) => ({ ...s, text: cut(s.text, 2000), params: s.params?.slice(0, 10) })) }),
    (c: AnswerCall): AnswerCall => ({ ...c, rows: c.rows.slice(0, 5), statements: c.statements?.slice(0, 2) }),
  ];
  for (const f of shrink) {
    if (size(out) <= maxBytes) return out;
    out = { ...out, calls: out.calls.map(f) };
  }
  while (size(out) > maxBytes && out.calls.length > 1) out = { ...out, calls: out.calls.slice(0, -1), more: (out.more ?? 0) + 1 };
  return out;
}

const MAX_SELECTIONS = 20;

/** The viewer's selections, named by the pack's labels; applied when every data call filtered on the field. */
export function selectionsOf(selections: Record<string, string> | undefined, pack: Pack, calls: readonly DataCall[]): AnswerSelection[] {
  const queries = calls.flatMap((c) => (c.tool === "query" ? [c.query] : []));
  return Object.entries(selections ?? {})
    .filter(([, v]) => typeof v === "string" && v !== "")
    .slice(0, MAX_SELECTIONS)
    .map(([field, value]) => ({
      field: cut(field, 100),
      label: cut(labelOf(pack, field), 100),
      value: cut(value, 200),
      applied: queries.length > 0 && queries.length === calls.length && queries.every((q) => (q.filters ?? []).some((f) => f.dimension === field)),
    }));
}

/**
 * One turn's answer card, gathered as its tools run: onData for boardTools; check() for a check
 * on the reply, which reads the full results from calls(); record() when the turn ends.
 */
export function answerCard(o: AnswerContext & { selections?: Record<string, string> }) {
  const seen: DataCall[] = [];
  const calls: AnswerCall[] = [];
  const checks: AnswerCheck[] = [];
  return {
    onData(e: DataCall) {
      seen.push(e);
      calls.push(answerCall(e, o));
    },
    /** Every data call as it came back, unbounded: what a check on the reply reads. */
    calls: (): readonly DataCall[] => seen,
    check(c: AnswerCheck) {
      checks.push({ ...c, summary: cut(c.summary, 500), ...(c.items ? { items: c.items.slice(0, 20).map((i) => cut(i, 200)) } : {}) });
    },
    /** The bounded card, or null for a turn that read no data. */
    record(): AnswerCard | null {
      if (!calls.length) return null;
      const selections = selectionsOf(o.selections, o.pack, seen);
      return boundCard({ calls, sql: o.sql, ...(selections.length ? { selections } : {}), ...(checks.length ? { checks } : {}) });
    },
  };
}

/** A host's request field for the viewer's dashboard selections, kept only as field → text pairs. */
export function selectionsFrom(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, x]) => typeof x === "string" && x !== "" && k !== "" && k.length <= 100).slice(0, MAX_SELECTIONS)) as Record<string, string>;
  return Object.keys(out).length ? out : undefined;
}
