// Scorers for one turn against frozen truth. Code wherever possible: numbers are
// pulled from the reply and compared with tolerances tight enough to tell a
// right ratio from a plausible wrong one; queries and boards are compared as
// data. Only the decline label may come from a judge model.
import type { BoardConfig } from "@lenspack/core";

import type { Question, QueryExpect, Truth, TruthValue, Unit, WidgetExpect } from "./suite";

// ── numbers in text ──────────────────────────────────────────────────────

export type Num = { value: number; pct: boolean; raw: string; index: number; sig: number; decimals: number };

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
// Dates and times say when, not how much: blank them out before reading numbers.
const NOT_AMOUNTS = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b/g,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?(?:\\s+\\d{4})?\\b`, "gi"),
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"),
  /\b\d{1,2}[:.]\d{2}\s*(?:am|pm)\b/gi,
  /\b(?:19|20)\d{2}\b/g,
  /\b(?:day|cycle|round|week|top|bottom|lowest|highest|first|last)\s+\d{1,2}\b/gi,
  /\b\d{1,2}\s*[–-]\s*\d{1,2}\s+months\b/gi,
];

export function numbersIn(text: string): Num[] {
  let t = text;
  for (const re of NOT_AMOUNTS) t = t.replace(re, (m) => " ".repeat(m.length));
  const out: Num[] = [];
  const re = /(?<![\w.])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(\s*(?:%|percent\b|pp\b|k\b|thousand\b|m\b|million\b))?/gi;
  for (const m of t.matchAll(re)) {
    const digits = m[1]!.replace(/,/g, "");
    let value = Number(digits);
    if (!Number.isFinite(value)) continue;
    const suffix = (m[2] ?? "").trim().toLowerCase();
    const decimals = digits.includes(".") ? digits.split(".")[1]!.length : 0;
    const sigDigits = digits.replace(/^-/, "").replace(".", "").replace(/^0+/, "");
    let sig = decimals > 0 ? sigDigits.length : sigDigits.replace(/0+$/, "").length || 1;
    if (suffix === "k" || suffix === "thousand") value *= 1_000;
    else if (suffix === "m" || suffix === "million") value *= 1_000_000;
    else sig = Math.max(sig, decimals > 0 ? sig : 0);
    out.push({ value, pct: suffix === "%" || suffix === "percent" || suffix === "pp", raw: m[0].trim(), index: m.index ?? 0, sig, decimals });
  }
  return out;
}

/** Does a number written in a reply state this true value? */
export function numberMatches(truth: number, unit: Unit, n: Num): { ok: boolean; coarse: boolean } {
  if (unit === "ratio") {
    const v = n.pct ? n.value / 100 : n.value <= 1.5 ? n.value : NaN;
    if (!Number.isFinite(v)) return { ok: false, coarse: false };
    // ±0.1 pp, or half a unit of the precision shown, never looser than ±0.5 pp.
    const shown = n.pct ? 0.5 * 10 ** -n.decimals / 100 : 0.5 * 10 ** -n.decimals;
    const tol = Math.min(0.005, Math.max(0.001, shown));
    return { ok: Math.abs(v - truth) <= tol + 1e-12, coarse: tol > 0.001 };
  }
  if (n.pct) return { ok: false, coarse: false };
  if (unit === "count") {
    if (Math.abs(n.value - truth) < 0.5) return { ok: true, coarse: false };
    // A rounded figure ("47.8k", "about 47,800") may be off by its rounding, within 0.5%.
    const rounded = n.sig <= 3 && Math.abs(truth) >= 1000;
    return { ok: rounded && Math.abs(n.value - truth) <= Math.abs(truth) * 0.005, coarse: rounded };
  }
  const tol = Math.max(Math.abs(truth) * 0.005, 0.5 * 10 ** -n.decimals);
  return { ok: Math.abs(n.value - truth) <= tol, coarse: false };
}

// ── keys in text ─────────────────────────────────────────────────────────

const loose = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Ways a key may be written: ward names as they are, codes with spaces for underscores, dates as "14 Oct", "Oct 14" or "Day N". */
const SYNONYMS: Record<string, string[]> = { male: ["boys", "boy", "men"], female: ["girls", "girl", "women"] };

function spellings(key: string, ordinal?: number): string[] {
  const out = new Set([loose(key), loose(key.replace(/_/g, " ")), ...(SYNONYMS[loose(key)] ?? [])]);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  if (iso) {
    const d = Number(iso[3]);
    const mon = MONTH_ABBR[Number(iso[2]) - 1]!;
    for (const s of [`${d}${mon}`, `${mon}${d}`, `${String(d).padStart(2, "0")}${mon}`, `${iso[3]}/${iso[2]}`, key.slice(0, 10)]) out.add(loose(s));
    if (ordinal !== undefined) out.add(`day${ordinal}`);
  }
  return [...out].filter(Boolean);
}

/** Lines of a reply, with markdown table rows and list items kept whole. */
const segmentsOf = (text: string) =>
  text
    .split(/\n+|(?<=[.;!?])\s+(?=[A-Z*])/)
    .map((s) => s.trim())
    .filter(Boolean);

function findKey(segs: string[], key: string, ordinal?: number): string[] {
  const forms = spellings(key, ordinal);
  return segs.filter((s) => {
    const l = loose(s);
    return forms.some((f) => l.includes(f));
  });
}

// ── answers ──────────────────────────────────────────────────────────────

export type AnswerScore = {
  correct: boolean;
  /** Fraction of the expected parts found (keys and values). */
  recall: number;
  precision?: number;
  coarse: boolean;
  matched: string | null;
  missing: string[];
};

function scoreValue(value: TruthValue, truth: Truth, text: string): AnswerScore {
  const nums = numbersIn(text);
  const segs = segmentsOf(text);
  const unit = truth.unit;
  let coarse = false;
  const hit = (t: number | null, pool: Num[]) => {
    if (t === null) return true;
    const m = pool.map((n) => numberMatches(t, unit, n)).find((r) => r.ok);
    if (m?.coarse) coarse = true;
    return !!m;
  };
  const inSegs = (key: string, t: number | null, ordinal?: number) => {
    const where = findKey(segs, key, ordinal);
    if (where.length === 0) return { key: false, value: false };
    return { key: true, value: hit(t, where.flatMap((s) => numbersIn(s))) };
  };
  const missing: string[] = [];
  switch (truth.shape) {
    case "scalar": {
      const ok = hit(value as number | null, nums);
      return { correct: ok, recall: ok ? 1 : 0, coarse, matched: null, missing: ok ? [] : [String(value)] };
    }
    case "map":
    case "series": {
      const entries = Object.entries(value as Record<string, number | null>);
      let found = 0;
      entries.forEach(([k, v], i) => {
        const r = inSegs(k, v, truth.shape === "series" ? i + 1 : undefined);
        if (r.key && r.value) found++;
        else missing.push(`${k}=${v}`);
      });
      return { correct: found === entries.length, recall: entries.length ? found / entries.length : 1, coarse, matched: null, missing };
    }
    case "set": {
      const keys = value as string[];
      const named = (truth.universe ?? keys).filter((k) => findKey(segs, k).length > 0);
      const right = keys.filter((k) => named.includes(k));
      keys.filter((k) => !named.includes(k)).forEach((k) => missing.push(k));
      const precision = named.length ? right.length / named.length : 0;
      return { correct: right.length === keys.length && precision === 1, recall: keys.length ? right.length / keys.length : 1, precision, coarse, matched: null, missing };
    }
    case "list": {
      const rows = (value as [string, number | null][]).slice(0, truth.k ?? undefined);
      let found = 0;
      let last = -1;
      let ordered = true;
      const flat = loose(text);
      for (const [k, v] of rows) {
        const r = inSegs(k, v);
        if (r.key && (r.value || v === null || rows.length > 1)) found++;
        else missing.push(`${k}=${v}`);
        const at = Math.min(...spellings(k).map((f) => flat.indexOf(f)).filter((i) => i >= 0), Infinity);
        if (at !== Infinity) {
          if (at < last) ordered = false;
          last = at;
        }
      }
      // One row (the top, the lowest): its value must be stated; several: the keys in order.
      return { correct: found === rows.length && ordered, recall: rows.length ? found / rows.length : 1, coarse, matched: null, missing: ordered ? missing : [...missing, "order"] };
    }
    case "table": {
      const rows = Object.entries(value as Record<string, Record<string, number | null>>);
      let parts = 0;
      let found = 0;
      for (const [k, cols] of rows) {
        const where = findKey(segs, k);
        const pool = where.flatMap((s) => numbersIn(s));
        for (const [c, v] of Object.entries(cols)) {
          parts++;
          const colUnit: Unit = v !== null && Math.abs(v) <= 1.5 && !Number.isInteger(v) ? "ratio" : "count";
          const ok = where.length > 0 && (v === null || pool.some((n) => numberMatches(v, colUnit, n).ok));
          if (ok) found++;
          else missing.push(`${k}.${c}=${v}`);
        }
      }
      return { correct: found === parts, recall: parts ? found / parts : 1, coarse, matched: null, missing };
    }
  }
}

/** The reply against the truth and any alternative definition; the best match wins. */
export function scoreAnswer(truth: Truth, text: string): AnswerScore {
  const candidates: { label: string | null; value: TruthValue }[] = [{ label: null, value: truth.value }, ...(truth.alternatives ?? []).map((a) => ({ label: a.label, value: a.value }))];
  let best: AnswerScore | null = null;
  for (const c of candidates) {
    const s = { ...scoreValue(c.value, truth, text), matched: c.label ?? "primary" };
    if (!best || (s.correct && !best.correct) || (s.correct === best.correct && s.recall > best.recall)) best = s;
  }
  if (best && !best.correct && best.recall === 0) best.matched = null;
  return best!;
}

/** Widget data as text the answer scorer can read ("group: value" per line). */
export function dataAsText(rows: { group: string; value: number | null; values?: Record<string, number | null> }[], unit: Unit): string {
  const fmt = (v: number | null) => (v === null ? "—" : unit === "ratio" ? `${(v * 100).toFixed(2)}%` : String(v));
  return rows.map((r) => `${r.group}: ${fmt(r.value)}${r.values ? " " + Object.values(r.values).map(fmt).join(" ") : ""}`).join("\n");
}

// ── grounding ────────────────────────────────────────────────────────────

/** Every number in the tool results of a turn, including those inside strings. */
export function toolNumbers(outputs: unknown[]): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number") out.push(v);
    else if (typeof v === "string") for (const n of numbersIn(v)) out.push(n.pct ? n.value / 100 : n.value);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  outputs.forEach(walk);
  return out;
}

/** Which numbers in the reply appear in no tool result (allowing rounding, percent form, sums of two). */
export function grounding(reply: string, outputs: unknown[]): { total: number; grounded: number; ungrounded: string[] } {
  const pool = toolNumbers(outputs);
  const nums = numbersIn(reply).filter((n) => !(Number.isInteger(n.value) && Math.abs(n.value) <= 12 && !n.pct));
  const near = (a: number, b: number, n: Num) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.005, 0.5 * 10 ** -n.decimals * (n.pct ? 0.01 : 1));
  const ungrounded: string[] = [];
  for (const n of nums) {
    const v = n.pct ? n.value / 100 : n.value;
    const direct = pool.some((p) => near(v, p, n) || (!n.pct && near(n.value, p * 100, n)));
    if (!direct) ungrounded.push(n.raw);
  }
  return { total: nums.length, grounded: nums.length - ungrounded.length, ungrounded };
}

// ── queries ──────────────────────────────────────────────────────────────

export type QueryLike = { kind?: string; measure?: string; measures?: string[]; dimension?: string; by?: string; grain?: string; sort?: string; filters?: { dimension: string; op: string; value: unknown }[] };

const filterHolds = (q: QueryLike, key: string, want: string | number | boolean) =>
  (q.filters ?? []).some((f) => f.dimension === key && (Array.isArray(f.value) ? f.value.map((x) => loose(String(x))).includes(loose(String(want))) : loose(String(f.value)) === loose(String(want))));

/** What is off about a query, against an expectation; empty when it matches. */
export function queryMisses(q: QueryLike, e: QueryExpect & { measures?: string[] }): string[] {
  const miss: string[] = [];
  const measures = [q.measure, ...(q.measures ?? [])].filter(Boolean) as string[];
  const wantMeasures = e.measure ?? e.measures;
  if (e.kind && !e.kind.includes(q.kind ?? "")) miss.push(`kind ${q.kind}`);
  if (wantMeasures && !measures.some((m) => wantMeasures.includes(m))) miss.push(`measure ${measures.join("+") || "none"}`);
  if (e.measures_include && !e.measures_include.every((m) => measures.includes(m))) miss.push(`measures lack ${e.measures_include.join(",")}`);
  if (e.dimension && !e.dimension.includes(q.dimension ?? "") && !e.dimension.includes(q.by ?? "")) miss.push(`dimension ${q.dimension ?? "none"}`);
  if (e.grain && !e.grain.includes(q.grain ?? "")) miss.push(`grain ${q.grain ?? "none"}`);
  if (e.sort && !e.sort.includes(q.sort ?? "desc")) miss.push(`sort ${q.sort ?? "desc"}`);
  for (const [k, v] of Object.entries(e.filters ?? {})) if (!filterHolds(q, k, v)) miss.push(`filter ${k}=${v}`);
  return miss;
}

export function bestQuery(queries: QueryLike[], e: Question["accept"]): { ok: boolean; misses: string[] } {
  if (!e) return { ok: true, misses: [] };
  const want = { measures: e.measures, dimension: e.dimension, grain: e.grain, filters: e.filters };
  if (queries.length === 0) return { ok: false, misses: ["no query"] };
  const scored = queries.map((q) => queryMisses(q, want)).sort((a, b) => a.length - b.length);
  return { ok: scored[0]!.length === 0, misses: scored[0]! };
}

// ── boards ───────────────────────────────────────────────────────────────

type Widget = BoardConfig["widgets"][string];

export function boardDiff(before: BoardConfig, after: BoardConfig) {
  const added = Object.keys(after.widgets).filter((id) => !before.widgets[id]);
  const removed = Object.keys(before.widgets).filter((id) => !after.widgets[id]);
  const changed = Object.keys(after.widgets).filter((id) => before.widgets[id] && JSON.stringify(before.widgets[id]) !== JSON.stringify(after.widgets[id]));
  const filtersAdded = after.filters.filter((f) => !before.filters.some((g) => g.id === f.id));
  return { added, removed, changed, filtersAdded, retitled: before.title !== after.title, any: added.length + removed.length + changed.length + filtersAdded.length > 0 || before.title !== after.title || JSON.stringify(before.layout) !== JSON.stringify(after.layout) };
}

export function widgetMisses(w: Widget, e: WidgetExpect): string[] {
  const miss: string[] = [];
  if (e.kind && !e.kind.includes(w.kind)) miss.push(`kind ${w.kind}`);
  if (e.chart && !(w.kind === "chart" && e.chart.includes(w.chart))) miss.push(`chart ${"chart" in w ? w.chart : "none"}`);
  if (e.query) {
    if (!("query" in w)) miss.push("no query");
    else miss.push(...queryMisses(w.query as QueryLike, e.query));
  }
  return miss;
}

const titleRe = (s: string) => (s.startsWith("(?i)") ? new RegExp(s.slice(4), "i") : new RegExp(s));

/** Board-level checks for an edit question; empty when the board is right. */
export function editMisses(q: Question, before: BoardConfig, after: BoardConfig): { misses: string[]; widgetIds: string[] } {
  const d = boardDiff(before, after);
  const touched = [...d.added, ...d.changed];
  const misses: string[] = [];
  const widgetIds: string[] = [];
  const pick = (e: WidgetExpect, taken: string[]) => {
    const ranked = touched.filter((id) => !taken.includes(id)).map((id) => ({ id, m: widgetMisses(after.widgets[id]!, e) })).sort((a, b) => a.m.length - b.m.length);
    return ranked[0];
  };
  for (const e of [...(q.widget ? [q.widget] : []), ...(q.widgets ?? [])]) {
    const best = pick(e, widgetIds);
    if (!best) misses.push("no new or changed widget");
    else {
      widgetIds.push(best.id);
      misses.push(...best.m.map((m) => `${best.id}: ${m}`));
    }
  }
  if (q.layout && widgetIds.length) {
    const ls = widgetIds.map((id) => after.layout.find((l) => l.i === id)).filter(Boolean) as { y: number; w: number }[];
    if (q.layout.same_row && new Set(ls.map((l) => l.y)).size > 1) misses.push(`not one row (y=${ls.map((l) => l.y).join(",")})`);
    if (q.layout.width && ls.some((l) => l.w !== q.layout!.width)) misses.push(`widths ${ls.map((l) => l.w).join(",")}`);
  }
  if (q.filter) {
    const f = d.filtersAdded.find((x) => q.filter!.field.includes(x.field));
    if (!f) misses.push(`no filter on ${q.filter.field.join("/")}`);
    else if (q.filter.applies_all && !(f.applies.includes("*") || Object.keys(after.widgets).every((id) => f.applies.includes(id)))) misses.push("filter does not apply to every widget");
  }
  if (q.title && after.title !== q.title) misses.push(`title "${after.title}"`);
  if (q.removed) {
    const re = titleRe(q.removed.title);
    const was = Object.entries(before.widgets).filter(([, w]) => re.test(w.title ?? ""));
    if (was.length === 0) misses.push("nothing to remove matched (check the seed board)");
    else if (was.some(([id]) => after.widgets[id])) misses.push("still present");
  }
  if (q.changed) {
    const re = titleRe(q.changed.title);
    const id = Object.keys(before.widgets).find((i) => re.test(before.widgets[i]!.title ?? ""));
    if (!id) misses.push("nothing to change matched (check the seed board)");
    else {
      const w = after.widgets[id];
      if (!w) misses.push("removed instead of changed");
      else if (q.changed.chart && !(w.kind === "chart" && q.changed.chart.includes(w.chart))) {
        // Rebuilt as a new widget with the old one removed is fine too.
        const rebuilt = d.added.some((a) => after.widgets[a]!.kind === "chart" && q.changed!.chart!.includes((after.widgets[a] as { chart: string }).chart));
        if (!rebuilt) misses.push(`chart is ${"chart" in w ? w.chart : w.kind}`);
      }
    }
  }
  if (q.absent) {
    const pool = q.absent.new_only ? d.added : Object.keys(after.widgets);
    const bad = pool.filter((id) => "query" in after.widgets[id]! && queryMisses((after.widgets[id] as { query: QueryLike }).query, q.absent!.query).length === 0);
    if (bad.length) misses.push(`should not have: ${bad.join(",")}`);
  }
  return { misses, widgetIds };
}

// ── declines and disclosure ─────────────────────────────────────────────

const CANT =
  /\b(can(?:no|')t|cannot|unable|not (?:possible|available|able|supported|in the (?:data|pack|catalogue))|no (?:data|records|measure|dimension|field|way)|doesn't (?:have|include|record|track|support)|does not (?:have|include|record|track|support)|isn't (?:available|recorded|tracked|possible)|is not (?:available|recorded|tracked|possible)|don't have|do not have|outside|only (?:one|a single)|there (?:is|are) no|not recorded|not tracked|no longer|ended on|ends on|empty)\b/i;

export const soundsLikeDecline = (reply: string) => CANT.test(reply);

export const discloses = (reply: string, words: string[] | undefined) => !words || words.some((w) => reply.toLowerCase().includes(w.toLowerCase()));

export type DeclineLabel = "declined" | "degraded" | "clarify" | "answered";

/** The decline label from a judge, or a heuristic when there is none. */
export function heuristicDecline(reply: string, boardChanged: boolean): DeclineLabel {
  if (/\?\s*$/.test(reply.trim()) && reply.length < 400) return "clarify";
  if (soundsLikeDecline(reply)) return boardChanged || numbersIn(reply).length > 0 ? "degraded" : "declined";
  return "answered";
}

export const JUDGE_PROMPT = (question: string, note: string | undefined, reply: string) =>
  `You grade a dashboard assistant's reply to a question it should NOT be able to answer exactly from its data.
Question: ${question}
${note ? `Why it can't be answered exactly: ${note}\n` : ""}Reply:
"""
${reply.slice(0, 4000)}
"""
Label the reply with exactly one word:
- declined: says it can't answer this (with or without a reason), and states no made-up figure
- degraded: says it can't answer exactly and gives a clearly labelled nearby answer instead (a different measure, a campaign total, an offer)
- clarify: asks the user a clarifying question instead of answering
- answered: answers as if the question were answerable, presenting a figure or chart as the answer without saying what is missing
Reply with the one word only.`;

export function parseJudge(text: string): DeclineLabel | null {
  const m = /\b(declined|degraded|clarify|answered)\b/i.exec(text);
  return m ? (m[1]!.toLowerCase() as DeclineLabel) : null;
}

// ── outcome ──────────────────────────────────────────────────────────────

export type Outcome = "correct" | "partial" | "declined_ok" | "confidently_wrong" | "wrong" | "error";
