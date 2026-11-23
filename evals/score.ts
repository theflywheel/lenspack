// Scorers for one turn against frozen truth. Code wherever possible: numbers are
// pulled from the reply and compared with tolerances tight enough to tell a
// right ratio from a plausible wrong one; queries and boards are compared as
// data. Only the decline label may come from a judge model.
import type { BoardConfig } from "@lenspack/core";

import type { Question, QueryExpect, Truth, TruthValue, Unit, WidgetExpect } from "./suite";

// ── numbers in text ──────────────────────────────────────────────────────

export type Num = { value: number; pct: boolean; raw: string; index: number; sig: number; decimals: number; word?: boolean };

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

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
  // Counts written as words ("Eight wards are above 95%"); "one" is too common to mean a count.
  for (const m of t.matchAll(new RegExp(`\\b(${WORDS.slice(2).join("|")})\\b`, "gi"))) {
    out.push({ value: WORDS.indexOf(m[1]!.toLowerCase()), pct: false, raw: m[0], index: m.index ?? 0, sig: 2, decimals: 0, word: true });
  }
  return out.sort((a, b) => a.index - b.index);
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
    .split(/\n+/)
    .flatMap((line) => (/^\s*(?:[-*•]|\d+[.)]|\|)\s/.test(line) ? [line] : line.split(/(?<=[.;!?])\s+(?=[A-Z*])/)))
    .map((s) => s.trim())
    .filter(Boolean);

function findKey(segs: string[], key: string, ordinal?: number): string[] {
  const forms = spellings(key, ordinal);
  // A key with sentence punctuation inside it is split across two segments: look at joined pairs too.
  const breaks = (key.match(/[.;!?]\s/g) ?? []).length;
  if (breaks) segs = [...segs, ...segs.slice(breaks).map((_, i) => segs.slice(i, i + breaks + 1).join(" "))];
  const words = key.includes("_") ? key.toLowerCase().split("_").filter((w) => w.length >= 3) : [];
  return segs.filter((s) => {
    const l = loose(s);
    if (forms.some((f) => l.includes(f))) return true;
    const low = s.toLowerCase();
    return words.length > 0 && words.every((w) => new RegExp(`\\b${w}`).test(low));
  });
}

const CONTRAST = /\b(next|just above|just below|closest|nearest|narrowly|except|excluding|other than|followed by|by contrast|not below|not above|misses|outside the|the other|others|range from|ranging from|up to|or higher|or above|and above|or lower|or below)\b/i;

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
      // A key named only as context ("the next lowest, X, is at 91%") is not part of the answer.
      const clauses = text.split(/(?<=[.;!?])\s+|\n+/).filter(Boolean);
      const answerClauses = clauses.filter((c) => !CONTRAST.test(c));
      const named = (truth.universe ?? keys).filter((k) => findKey(keys.includes(k) ? segs : answerClauses, k).length > 0);
      const right = keys.filter((k) => named.includes(k));
      keys.filter((k) => !named.includes(k)).forEach((k) => missing.push(k));
      const precision = named.length ? right.length / named.length : 0;
      return { correct: right.length === keys.length && precision === 1, recall: keys.length ? right.length / keys.length : 1, precision, coarse, matched: null, missing };
    }
    case "list": {
      const rows = (value as [string, number | null][]).slice(0, truth.k ?? undefined);
      const dayOf = (k: string) => (truth.dayOne && /^\d{4}-\d{2}-\d{2}/.test(k) ? Math.round((Date.parse(k.slice(0, 10)) - Date.parse(truth.dayOne)) / 86_400_000) + 1 : undefined);
      let found = 0;
      let last = -1;
      let ordered = true;
      const flat = loose(text);
      for (const [k, v] of rows) {
        const r = inSegs(k, v, dayOf(k));
        if (r.key && (r.value || v === null || rows.length > 1)) found++;
        else missing.push(`${k}=${v}`);
        const at = Math.min(...spellings(k, dayOf(k)).map((f) => flat.indexOf(f)).filter((i) => i >= 0), Infinity);
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
  const nums = numbersIn(reply).filter((n) => !n.word && !(Number.isInteger(n.value) && Math.abs(n.value) <= 12 && !n.pct));
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

export const titleRe = (s: string) => (s.startsWith("(?i)") ? new RegExp(s.slice(4), "i") : new RegExp(s));

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
  if (q.moved) {
    const find = (t: string) => Object.keys(after.widgets).find((id) => titleRe(t).test(after.widgets[id]!.title ?? ""));
    const [x, y] = [find(q.moved.title), find(q.moved.beside)];
    const lx = after.layout.find((l) => l.i === x);
    const ly = after.layout.find((l) => l.i === y);
    if (!lx || !ly) misses.push(`no widget titled ${!lx ? q.moved.title : q.moved.beside}`);
    else if (lx.y !== ly.y) misses.push(`${x} not beside ${y} (rows y=${lx.y} and y=${ly.y})`);
    const over = overlaps(after.layout);
    if (over.length) misses.push(`overlapping: ${over.join(", ")}`);
  }
  return { misses, widgetIds };
}

/**
 * Changes an edit made that nobody asked for: the board's fill or density toggled, or a widget the edit had no
 * business with resized or shifted. Widgets the edit touched (added, removed, changed, the moved one and its
 * target) are exempt. Their row-mates are exempt from what the board's own packing does to them, but not from
 * the model's own moves and resizes (since 2026-11-23): a row-mate the model itself moved or resized with a
 * layout tool, and that left the edited row or got wider, is collateral. Narrowing one to make room is what the
 * packing does anyway, so it is not.
 */
export const LAYOUT_TOOLS = new Set(["move_widget", "resize_widget"]);
export const RESTORE_TOOLS = new Set(["restore_version"]);
export function collateral(q: Question, before: BoardConfig, after: BoardConfig, calls: { tool: string; input: unknown; ok?: boolean }[] = []): string[] {
  const d = boardDiff(before, after);
  const out: string[] = [];
  const g0 = before.grid as { fill?: boolean; density?: string };
  const g1 = after.grid as { fill?: boolean; density?: string };
  if ((g0.fill ?? false) !== (g1.fill ?? false)) out.push(`board fill ${g1.fill ? "on" : "off"}`);
  if ((g0.density ?? "comfortable") !== (g1.density ?? "comfortable")) out.push(`board density ${g1.density}`);
  const titled = (t: string) => Object.keys(before.widgets).find((id) => titleRe(t).test(before.widgets[id]!.title ?? ""));
  const touched = new Set([...d.added, ...d.removed, ...d.changed, ...(q.moved ? [titled(q.moved.title), titled(q.moved.beside)].filter((x): x is string => !!x) : [])]);
  const rowMates = (layout: BoardConfig["layout"]) => {
    const ys = new Set(layout.filter((l) => touched.has(l.i)).map((l) => l.y));
    return layout.filter((l) => ys.has(l.y)).map((l) => l.i);
  };
  const exempt = new Set([...touched, ...rowMates(before.layout), ...rowMates(after.layout)]);
  const was = new Map(before.layout.map((l) => [l.i, l]));
  const now = new Map(after.layout.map((l) => [l.i, l]));
  const kept = before.layout.map((l) => l.i).filter((id) => now.has(id) && !exempt.has(id));
  for (const id of kept) {
    const [a, b] = [was.get(id)!, now.get(id)!];
    if (a.w !== b.w) out.push(`${id} width ${a.w}→${b.w}`);
    else if (a.x !== b.x) out.push(`${id} slid x ${a.x}→${b.x}`);
  }
  // Row-mates: the packing may narrow or slide them to make room, but sending one out of the row or widening it,
  // with a call of the model's own, goes beyond that.
  const movedId = q.moved ? titled(q.moved.title) : undefined;
  // A restore puts the board back, so only the layout calls after the last one still stand.
  const lastRestore = calls.reduce((last, c, i) => (c.ok !== false && RESTORE_TOOLS.has(c.tool) ? i : last), -1);
  const standing = calls.slice(lastRestore + 1).filter((c) => c.ok !== false && LAYOUT_TOOLS.has(c.tool));
  const byModel = new Set(standing.map((c) => (c.input as { id?: string } | null)?.id).filter((x): x is string => !!x));
  for (const id of [...exempt].filter((i) => !touched.has(i) && byModel.has(i) && was.has(i) && now.has(i))) {
    const [a, b] = [was.get(id)!, now.get(id)!];
    // The row it shared with the edit: its companions there, less the moved widget, which leaves on purpose.
    const companions = before.layout.filter((l) => l.y === a.y && l.i !== id && l.i !== movedId && now.has(l.i)).map((l) => now.get(l.i)!.y);
    const left = companions.length > 0 && !companions.includes(b.y);
    const what = [left ? "moved out of its row" : "", b.w > a.w ? `widened ${a.w}→${b.w}` : ""].filter(Boolean).join(", ");
    if (what) out.push(`${id} ${what} (the model's own ${standing.filter((c) => (c.input as { id?: string } | null)?.id === id).map((c) => c.tool).join("+")})`);
  }
  const order = (m: Map<string, { x: number; y: number }>) => [...kept].sort((p, r) => m.get(p)!.y - m.get(r)!.y || m.get(p)!.x - m.get(r)!.x);
  const [o0, o1] = [order(was), order(now)];
  const moved = o0.filter((id, i) => o1[i] !== id);
  if (moved.length) out.push(`order changed: ${o1.filter((id, i) => o0[i] !== id).join(", ")}`);
  return out;
}

/** Pairs of layout items that cover the same cell. */
export function overlaps(layout: BoardConfig["layout"]): string[] {
  const out: string[] = [];
  for (const [i, a] of layout.entries())
    for (const b of layout.slice(i + 1)) if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.i}/${b.i}`);
  return out;
}

/** A reply saying a widget was moved (English or Hindi). */
export const MOVE_CLAIM = /\b(?:I(?:'ve| have)? (?:moved|placed|put)|(?:moved|placed|put) (?:it|the)\b|(?:is|sits) now|now (?:sits|is) (?:next to|beside|alongside|on|in|at))|रख दिया|खिसका दिया|शिफ्ट कर दिया|मूव कर दिया/i;
/** A reply saying it now sits beside the other one. */
export const BESIDE_CLAIM = /\b(?:next to|beside|alongside|same row)\b|के साथ|बगल में/i;
/** A reply saying there is no room for the move. */
export const NO_ROOM = /\b(?:no|not enough) (?:room|space)\b|\b(?:row|it) is (?:already )?full\b|\b(?:doesn't|does not|won't|will not) fit\b|जगह नहीं/i;

// ── declines and disclosure ─────────────────────────────────────────────

const CANT =
  /\b(can(?:no|')t|cannot|unable|not (?:possible|available|able|supported|in the (?:data|pack|catalogue))|no (?:data|records|measure|dimension|field|way)|doesn't (?:have|include|record|track|support)|does not (?:have|include|record|track|support)|isn't (?:available|recorded|tracked|possible)|is not (?:available|recorded|tracked|possible)|don't have|do not have|outside|only (?:one|a single)|there (?:is|are) no|not recorded|not tracked|no longer|ended on|ends on|empty)\b/i;

export const soundsLikeDecline = (reply: string) => CANT.test(reply);

/** Plain statements that the question can't be answered as asked; strict enough to overrule a judge. */
export const SAYS_CANT = /\b(?:I )?(?:can(?:no|')t|cannot|couldn't|could not) (?:answer|tell|give|work out|compute|calculate|follow)|\b(?:has|have) no (?:records|data|rows) (?:in|for)|\bno (?:records|data) (?:in|for) (?:that|this|the) (?:window|period|week|range)|\bnone of them fall/i;

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
- declined: says it can't answer this (with or without a reason), and states no made-up figure. "There are no records in that window, so the count is 0" is declined, not answered
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
