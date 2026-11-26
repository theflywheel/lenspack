// Questions that differ only in a place or a time. "Doses today in Ward A" and "doses yesterday in
// Ward B" have the same plan: the same queries, with another filter value and another time window.
// When an answer is kept, the parts of its question that are a filter value of its queries, or a
// time phrase its queries' time window says, become slots; a later question that fills them with
// another known value (looked up in the data, as the chat's own value lookup does) or another time
// phrase runs the same plan with them swapped in, without the model.

import { normalise } from "./text";

/** A tool call as the store keeps it. */
export type Call = { tool: string; input: Record<string, unknown>; output?: unknown };

/** A time window in the query tool's own arguments. */
export type TimeArgs = { time_period?: string; time_count?: number; time_last?: string };

export type Slot =
  | { kind: "value"; dimension: string; text: string; value: string }
  | { kind: "time"; text: string; time: TimeArgs };

// Time phrases in the chat's languages, normalised (lower case, no accents, no punctuation). Longest first when matching.
const PHRASES: [string, TimeArgs][] = [
  ["today", { time_period: "today" }], ["yesterday", { time_period: "yesterday" }],
  ["this week", { time_period: "this_week" }], ["last week", { time_period: "last_week" }],
  ["this month", { time_period: "this_month" }], ["last month", { time_period: "last_month" }],
  ["this quarter", { time_period: "this_quarter" }], ["last quarter", { time_period: "last_quarter" }],
  ["this year", { time_period: "this_year" }], ["last year", { time_period: "last_year" }],
  ["aujourd hui", { time_period: "today" }], ["hier", { time_period: "yesterday" }],
  ["cette semaine", { time_period: "this_week" }], ["la semaine derniere", { time_period: "last_week" }], ["semaine derniere", { time_period: "last_week" }],
  ["ce mois ci", { time_period: "this_month" }], ["ce mois", { time_period: "this_month" }], ["le mois dernier", { time_period: "last_month" }], ["mois dernier", { time_period: "last_month" }],
  ["cette annee", { time_period: "this_year" }], ["l annee derniere", { time_period: "last_year" }],
  ["hoje", { time_period: "today" }], ["ontem", { time_period: "yesterday" }],
  ["esta semana", { time_period: "this_week" }], ["semana passada", { time_period: "last_week" }], ["na semana passada", { time_period: "last_week" }],
  ["este mes", { time_period: "this_month" }], ["mes passado", { time_period: "last_month" }], ["no mes passado", { time_period: "last_month" }],
  ["este ano", { time_period: "this_year" }], ["ano passado", { time_period: "last_year" }],
  ["आज", { time_period: "today" }], ["कल", { time_period: "yesterday" }],
  ["इस हफ्ते", { time_period: "this_week" }], ["पिछले हफ्ते", { time_period: "last_week" }], ["इस सप्ताह", { time_period: "this_week" }], ["पिछले सप्ताह", { time_period: "last_week" }],
  ["इस महीने", { time_period: "this_month" }], ["पिछले महीने", { time_period: "last_month" }],
];
const UNITS: Record<string, string> = { day: "d", days: "d", jours: "d", jour: "d", dias: "d", dia: "d", दिन: "d", week: "w", weeks: "w", semaines: "w", semanas: "w", हफ्ते: "w", month: "m", months: "m", mois: "m", meses: "m", महीने: "m" };
// "last 7 days", "past 30 days", "7 derniers jours", "ultimos 7 dias", "पिछले 7 दिन".
const ROLLING = /(?:^| )((?:last|past|ultimos|os ultimos|पिछले) (\d+) (\S+)|(?:les )?(\d+) (?:derniers|dernieres) (\S+))(?= |$)/;

/** The time phrase in a normalised question, if any: its text there and the window it means. */
export function timePhrase(norm: string): { text: string; time: TimeArgs } | null {
  const r = ROLLING.exec(norm);
  if (r) {
    const n = r[2] ?? r[4];
    const unit = UNITS[(r[3] ?? r[5])!];
    if (unit) return { text: r[1]!, time: { time_last: `${n}${unit}` } };
  }
  const hits = PHRASES.filter(([p]) => ` ${norm} `.includes(` ${p} `)).sort((a, b) => b[0].length - a[0].length);
  return hits[0] ? { text: hits[0][0], time: hits[0][1] } : null;
}

const sameTime = (input: Record<string, unknown>, t: TimeArgs) => {
  const period = String(input.time_period ?? "").trim().toLowerCase();
  const last = String(input.time_last ?? "").trim().toLowerCase();
  const count = Number(input.time_count ?? 1) || 1;
  if (t.time_period) return period === t.time_period && count === 1 && !last && !input.time_from;
  return last === t.time_last && !period && !input.time_from;
};

const CLAUSE = /^\s*([a-z][a-z0-9_]*)\s*(?:(=)|\s(in)\s)\s*(.+?)\s*$/i;
const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

/** The values a query call's filters set by equality: from `filters` ("ward = A; lga in B, C") and filter_dimension/filter_value. */
export function filterValues(input: Record<string, unknown>): { dimension: string; value: string }[] {
  const out: { dimension: string; value: string }[] = [];
  for (const clause of String(input.filters ?? "").split(";")) {
    const m = CLAUSE.exec(clause);
    if (!m) continue;
    for (const v of m[3] ? m[4]!.split(",") : [m[4]!]) if (unquote(v)) out.push({ dimension: m[1]!, value: unquote(v) });
  }
  if (input.filter_dimension && input.filter_value) out.push({ dimension: String(input.filter_dimension), value: String(input.filter_value) });
  return out;
}

const DATA_TOOLS = new Set(["query", "list_values"]);
const contains = (norm: string, part: string) => !!part && ` ${norm} `.includes(` ${part} `);

/** The slots of a kept question, and its pattern with each slot as {0}, {1}…; null when nothing in it is a slot. */
export function slotsOf(question: string, calls: Call[]): { pattern: string; slots: Slot[] } | null {
  let norm = normalise(question);
  const slots: Slot[] = [];
  const queries = calls.filter((c) => DATA_TOOLS.has(c.tool));
  const t = timePhrase(norm);
  if (t && queries.some((c) => c.tool === "query" && sameTime(c.input, t.time))) slots.push({ kind: "time", text: t.text, time: t.time });
  for (const c of queries)
    for (const f of filterValues(c.input)) {
      const text = normalise(f.value);
      if (text.length >= 2 && contains(norm, text) && !slots.some((s) => s.text === text)) slots.push({ kind: "value", dimension: f.dimension, text, value: f.value });
    }
  if (!slots.length) return null;
  // Longer slots first, so "ward 12" is taken before "12".
  slots.sort((a, b) => b.text.length - a.text.length);
  slots.forEach((s, i) => (norm = ` ${norm} `.replace(` ${s.text} `, ` {${i}} `).trim()));
  // A slot that did not survive (one inside another) is dropped.
  const kept = slots.filter((_, i) => norm.includes(`{${i}}`));
  if (kept.length !== slots.length) return null;
  return { pattern: norm, slots };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text each slot has in a new normalised question, if the question fits the pattern. */
export function fill(pattern: string, norm: string): string[] | null {
  const parts = pattern.split(/\{(\d+)\}/);
  const order: number[] = [];
  let re = "^";
  parts.forEach((p, i) => {
    if (i % 2) {
      order.push(Number(p));
      re += "(.+?)";
    } else re += escape(p);
  });
  const m = new RegExp(`${re}$`).exec(norm);
  if (!m) return null;
  const out: string[] = [];
  order.forEach((slot, i) => (out[slot] = m[i + 1]!.trim()));
  return out;
}

/** A filters string with one value swapped for another (exact, as written). */
function swapValue(filters: string, from: string, to: string): string {
  return filters
    .split(";")
    .map((clause) => {
      const m = CLAUSE.exec(clause);
      if (!m) return clause;
      const vals = (m[3] ? m[4]!.split(",") : [m[4]!]).map((v) => (unquote(v) === from ? to : unquote(v)));
      return ` ${m[1]} ${m[3] ? "in" : "="} ${vals.join(", ")}`;
    })
    .join(";")
    .trim();
}

/** The plan with new slot values: each value slot's filter value swapped, each time slot's window replaced. */
export function slotInto(calls: Call[], slots: Slot[], next: Slot[]): Call[] {
  return calls.map((c) => {
    if (!DATA_TOOLS.has(c.tool)) return c;
    const input = { ...c.input };
    slots.forEach((s, i) => {
      const n = next[i]!;
      if (s.kind === "value" && n.kind === "value") {
        if (typeof input.filters === "string") input.filters = swapValue(input.filters, s.value, n.value);
        if (input.filter_dimension === s.dimension && input.filter_value === s.value) input.filter_value = n.value;
      }
      if (s.kind === "time" && n.kind === "time" && c.tool === "query" && sameTime(c.input, s.time)) {
        delete input.time_period;
        delete input.time_count;
        delete input.time_last;
        Object.assign(input, n.time);
      }
    });
    return { tool: c.tool, input };
  });
}
