// Rewriting a saved reply with fresh numbers, without a model. Every number in the reply must be a
// cell of the saved query results (the same idea as the evals' grounding check), and the fresh
// results must have the same shape: the same rows, named the same, in the same order. Then each
// number is swapped for its cell's new value, written the way the reply wrote it. Anything else (a
// number with no cell, a cell that is not unique, rows that moved, a count in words, a sign that
// flipped) is refused with the reason, and the caller asks a small model to rewrite the reply instead.

import { normalise, stripLatinAccents } from "./text";

export type Cell = { path: string; value: number };
export type Shape = { cells: Cell[]; labels: string[] };

// Fields of a tool result that are not data: the query as asked, the native statement, notes in words.
const NOT_DATA = new Set(["query", "sql", "request", "computed", "counts", "notes", "format", "didYouMean", "ok", "approximate", "error", "window"]);

/** A tool result's numbers (by where they sit) and its labels (group names, time buckets), in order. */
export function shapeOf(output: unknown): Shape {
  const cells: Cell[] = [];
  const labels: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "number" && Number.isFinite(v)) cells.push({ path, value: v });
    else if (typeof v === "string") labels.push(v);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!NOT_DATA.has(k)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(output, "");
  return { cells, labels };
}

type Style = { group: string; decimal: string; indian: boolean; decimals: number; minus: string };
type Token = { start: number; end: number; raw: string; value: number; pct: boolean; style: Style };

const COMMA_DECIMAL = new Set(["fr", "pt", "es", "de", "it"]);

/** The numbers written in a reply, with how each is written. Decimal commas for French and Portuguese, points otherwise. */
export function numbersIn(text: string, lang: string): Token[] {
  const commaDecimal = COMMA_DECIMAL.has(lang);
  const re = commaDecimal
    ? /(?<![\p{L}\p{N}.,])([-−]?)(\d{1,3}(?:[   .]\d{3})+(?:,\d+)?|\d+(?:,\d+)?)(?![\p{N}])(\s?%)?/gu
    : /(?<![\p{L}\p{N}.,])([-−]?)(\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\p{N}])(\s?%)?/gu;
  const out: Token[] = [];
  for (const m of text.matchAll(re)) {
    const body = m[2]!;
    const decimalSep = commaDecimal ? "," : ".";
    const [whole, frac = ""] = body.split(decimalSep);
    const groupChar = (whole!.match(/[^\d]/) ?? [""])[0]!;
    const digits = whole!.replace(/[^\d]/g, "");
    const value = Number(`${m[1] ? "-" : ""}${digits}${frac ? `.${frac}` : ""}`);
    const indian = !commaDecimal && /^\d{1,2}(?:,\d{2})+,\d{3}$/.test(whole!);
    out.push({ start: m.index!, end: m.index! + m[0].length, raw: m[0], value, pct: !!m[3], style: { group: groupChar, decimal: decimalSep, indian, decimals: frac.length, minus: m[1] || "-" } });
  }
  return out;
}

/** A number written in a token's style: its grouping, decimal mark, number of decimals and minus sign. */
export function writeLike(value: number, s: Style, pct: boolean, raw: string): string {
  const neg = value < 0;
  const fixed = Math.abs(value).toFixed(s.decimals);
  const [whole, frac] = fixed.split(".");
  let grouped = whole!;
  if (s.group) {
    if (s.indian && whole!.length > 3) {
      const last = whole!.slice(-3);
      const rest = whole!.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, s.group);
      grouped = `${rest}${s.group}${last}`;
    } else grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, s.group);
  }
  const pctPart = pct ? raw.slice(raw.search(/\s?%$/)) : "";
  return `${neg ? s.minus : ""}${grouped}${frac ? `${s.decimal}${frac}` : ""}${pctPart}`;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** The readings of a cell a reply may have written: as it is, its size, or as a percentage. */
function readings(c: number, pct: boolean): { v: number; scale: number; abs: boolean }[] {
  const out = [
    { v: c, scale: 1, abs: false },
    { v: Math.abs(c), scale: 1, abs: true },
  ];
  if (pct || Math.abs(c) <= 1) out.push({ v: c * 100, scale: 100, abs: false }, { v: Math.abs(c) * 100, scale: 100, abs: true });
  return out;
}

// Counts in words would not be swapped, so a reply with one cannot be rewritten by template.
const COUNT_WORDS = /(?<![\p{L}])(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|deux|trois|quatre|cinq|sept|huit|neuf|dix|vingt|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|vinte|दो|तीन|चार|पांच|पाँच|छह|सात|आठ|नौ|दस)(?![\p{L}])/iu;
const ISO_DATE = /\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g;

export type Templated = { ok: true; text: string; swapped: number } | { ok: false; why: string };

/**
 * The saved reply with the fresh results' numbers, or why it cannot be done by template.
 * `before` and `after` are the plan's data tool results, in the same order.
 */
export function retemplate(reply: string, before: unknown[], after: unknown[], o: { question: string; lang: string }): Templated {
  if (before.length !== after.length) return { ok: false, why: "the plan ran a different number of queries" };
  const was = before.map(shapeOf);
  const now = after.map(shapeOf);
  for (let i = 0; i < was.length; i++) {
    if (was[i]!.labels.join("\u0000") !== now[i]!.labels.join("\u0000")) return { ok: false, why: "the rows changed (a group or a time bucket was added, dropped or moved)" };
    if (was[i]!.cells.map((c) => c.path).join("|") !== now[i]!.cells.map((c) => c.path).join("|")) return { ok: false, why: "the results have a different shape" };
  }
  if (/[०-९]/.test(reply)) return { ok: false, why: "the reply writes numbers in Devanagari digits" };
  if (COUNT_WORDS.test(stripLatinAccents(reply))) return { ok: false, why: "the reply writes a count in words" };
  // Names of rows and dates are words, not numbers to swap: "Ward 12", "2026-11-26".
  let masked = reply.replace(ISO_DATE, (m) => " ".repeat(m.length));
  const labels = [...new Set(was.flatMap((s) => s.labels))].filter((l) => /\d/.test(l) && l.length >= 2).sort((a, b) => b.length - a.length);
  for (const l of labels) {
    const at = masked.toLowerCase().indexOf(l.toLowerCase());
    if (at >= 0) masked = masked.slice(0, at) + " ".repeat(l.length) + masked.slice(at + l.length);
  }
  // A number the person asked with ("the top 5") is theirs, not the data's.
  const asked = new Set(normalise(o.question).split(" ").filter((w) => /^\d+(\.\d+)?$/.test(w)).map(Number));
  const oldCells = was.flatMap((s, i) => s.cells.map((c) => ({ key: `${i}:${c.path}`, value: c.value })));
  const newCells = new Map<string, number>(now.flatMap((s, i) => s.cells.map((c) => [`${i}:${c.path}`, c.value] as const)));
  let text = "";
  let at = 0;
  let swapped = 0;
  for (const t of numbersIn(masked, o.lang)) {
    if (asked.has(t.value) && !t.pct) continue;
    // A number glued to letters ("12k", "3rd") is not read here; it would be left stale.
    if (/^[\p{L}]/u.test(masked.slice(t.end))) return { ok: false, why: `"${t.raw.trim()}" is not a plain number` };
    const d = t.style.decimals;
    const hits: { now: number; abs: boolean; scale: number }[] = [];
    for (const c of oldCells)
      for (const r of readings(c.value, t.pct))
        if (round(r.v, d) === round(r.abs ? Math.abs(t.value) : t.value, d)) {
          const n = newCells.get(c.key)!;
          hits.push({ now: (r.abs ? Math.abs(n) : n) * r.scale, abs: r.abs, scale: r.scale });
          if (r.abs && Math.sign(n) !== Math.sign(c.value) && n !== 0) return { ok: false, why: `"${t.raw.trim()}" changed sign, so the words around it may no longer hold` };
          break;
        }
    if (!hits.length) return { ok: false, why: `"${t.raw.trim()}" is not a number in the results` };
    const values = new Set(hits.map((h) => round(h.now, d)));
    if (values.size > 1) return { ok: false, why: `"${t.raw.trim()}" matches several results that now differ` };
    const next = [...values][0]!;
    if (next === round(t.value, d)) continue;
    // A small whole number is often a count of rows ("3 wards are behind") that only looks like a cell.
    if (d === 0 && Math.abs(t.value) < 10 && !t.pct) return { ok: false, why: `"${t.raw.trim()}" is a small count that changed` };
    text += reply.slice(at, t.start) + writeLike(t.value < 0 && hits[0]!.abs ? -next : next, t.style, t.pct, t.raw);
    at = t.end;
    swapped++;
  }
  return { ok: true, text: text + reply.slice(at), swapped };
}
