import { z } from "zod";

import type { Pricing } from "../metering";
import { type DigestTurn, turnText } from "./digest";
import { normalPattern } from "./questions";
import { parseTime, validZone } from "./schedule";

// The daily review: once a day (or when an admin presses Run now), a strong model reads the
// period's turns and writes a report: where answers went wrong or were unsure and why, concrete
// edits to the definitions overlay that would fix them, new open questions with their readings,
// questions asked often enough to deserve a dashboard chart, and a short summary. Nothing in it is
// applied: an admin accepts, edits or rejects each proposal. The run never spends more than its cap:
// the input is trimmed until the worst case (all of it, plus the longest answer allowed) fits.

export type ReviewSettings = {
  /** Local time of day, "HH:MM". */
  time: string;
  timeZone: string;
  /** A provider name. */
  model: string;
  /** The most one run may cost, in US$. */
  maxUsd: number;
  lookbackHours: number;
  /** A scheduled run with fewer turns than this is skipped (Run now always runs). */
  minTurns: number;
};

export const DEFAULT_REVIEW_MODEL = "claude-opus-5-5";

export const reviewDefaults = (timeZone = "UTC"): ReviewSettings => ({ time: "06:00", timeZone, model: DEFAULT_REVIEW_MODEL, maxUsd: 1, lookbackHours: 24, minTurns: 5 });

/** A settings change checked field by field; null resets a field. The fields left out are kept. */
export function updateSettings(current: Partial<ReviewSettings>, body: Record<string, unknown>, models: string[]): { ok: true; next: Partial<ReviewSettings> } | { ok: false; error: string } {
  const next: Partial<ReviewSettings> = { ...current };
  const checks: Record<keyof ReviewSettings, (v: unknown) => string | null> = {
    time: (v) => (typeof v === "string" && parseTime(v) ? null : 'time is "HH:MM", 24-hour'),
    timeZone: (v) => (typeof v === "string" && validZone(v) ? null : "timeZone is an IANA zone, such as Africa/Lagos"),
    model: (v) => (typeof v === "string" && models.includes(v) ? null : `model is one of ${models.join(", ") || "(no models configured)"}`),
    maxUsd: (v) => (typeof v === "number" && v > 0 && v <= 50 ? null : "maxUsd is a number of US$ above 0, at most 50"),
    lookbackHours: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 24 * 14 ? null : "lookbackHours is a whole number from 1 to 336"),
    minTurns: (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000 ? null : "minTurns is a whole number, 0 or more"),
  };
  for (const [k, v] of Object.entries(body)) {
    if (!(k in checks)) return { ok: false, error: `unknown review setting "${k}"` };
    const key = k as keyof ReviewSettings;
    if (v === null) {
      delete next[key];
      continue;
    }
    const bad = checks[key](v);
    if (bad) return { ok: false, error: bad };
    (next as Record<string, unknown>)[key] = v;
  }
  return { ok: true, next };
}

// ---- The report ---------------------------------------------------------------------------------

const turnsField = z.array(z.coerce.number().int()).catch([]).default([]);
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const queryField = z.record(scalar).optional().catch(undefined);

export const findingSchema = z.object({ title: z.string().min(1).max(200), why: z.string().max(1500).default(""), severity: z.enum(["bad", "uncertain"]).catch("uncertain").default("uncertain"), turns: turnsField });
export const proposalSchema = z.object({
  kind: z.enum(["instruction", "hint", "synonym", "definition"]),
  key: z.string().max(80).optional(),
  text: z.string().max(600).default(""),
  words: z.array(z.string().max(40)).max(20).optional(),
  when: z.string().max(200).optional(),
  rationale: z.string().max(1500).default(""),
  turns: turnsField,
});
export const questionSchema = z.object({
  pattern: z.string().min(1).max(200),
  readings: z.array(z.object({ label: z.string().min(1).max(120), explanation: z.string().max(600).default(""), query: queryField })).min(2).max(6),
  examples: z.array(z.string().max(300)).max(8).catch([]).default([]),
  turns: turnsField,
});
export const chartSchema = z.object({ question: z.string().min(1).max(300), count: z.coerce.number().int().min(1).catch(1).default(1), why: z.string().max(600).default(""), query: queryField });

export type ReviewFinding = z.infer<typeof findingSchema>;
export type ReviewProposal = z.infer<typeof proposalSchema>;
export type ReviewQuestion = z.infer<typeof questionSchema>;
export type ChartCandidate = z.infer<typeof chartSchema>;
export type ReviewReport = { summary: string; findings: ReviewFinding[]; proposals: ReviewProposal[]; questions: ReviewQuestion[]; chartCandidates: ChartCandidate[] };

/**
 * The model's reply → a report. Each item is checked on its own: a malformed one is left out and
 * counted in problems, so one bad proposal never costs the rest of the run.
 */
export function parseReport(raw: string): { report: ReviewReport; problems: string[] } | { error: string } {
  const m = /\{[\s\S]*\}/.exec(raw);
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m ? m[0] : raw) as Record<string, unknown>;
  } catch {
    return { error: raw.trim() ? "the review's reply was not JSON" : "the review returned nothing" };
  }
  if (!o || typeof o !== "object") return { error: "the review's reply was not a JSON object" };
  const problems: string[] = [];
  const items = <T>(name: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, max: number): T[] => {
    const list = Array.isArray(o[name]) ? (o[name] as unknown[]) : [];
    if (o[name] !== undefined && !Array.isArray(o[name])) problems.push(`${name} was not a list`);
    return list.slice(0, max).flatMap((x, i) => {
      const r = schema.safeParse(x);
      if (r.success) return [r.data];
      problems.push(`${name}[${i}] left out: ${r.error.issues.map((is) => `${is.path.join(".") || "item"} ${is.message}`).join("; ").slice(0, 200)}`);
      return [];
    });
  };
  const report: ReviewReport = {
    summary: typeof o.summary === "string" ? o.summary.trim().slice(0, 2000) : "",
    findings: items("findings", findingSchema, 30),
    proposals: items("proposals", proposalSchema, 30),
    questions: items("questions", questionSchema, 20),
    chartCandidates: items("chartCandidates", chartSchema, 20),
  };
  if (!report.summary) problems.push("no summary");
  return { report, problems };
}

/** The review's instructions. Fixed, so a provider's prompt cache can keep them. */
export const DAILY_PROMPT = `You review how people used a data assistant over the last period, for the admin who maintains its definitions.
The assistant answers questions about a data pack (measures, dimensions, compute steps) and edits dashboards. You get the pack, the definitions an admin already set, the open questions already logged, and the period's turns: each with the question, the tool calls and what they returned, refusals, the reviewer's findings, and the reply.

Your job is to find where answers went wrong or were unsure, and why, and to propose the smallest edits to the definitions that would make the next answer right. Definitions are where answers go wrong: two ways of counting the same words ("burn rate", "returns", "current balance", "last 30 days") give different numbers, and the pack does not say which is meant.

Write JSON only, in this shape:
{
 "summary": "three to five plain sentences for the admin: how the period went, the main problems, what you propose",
 "findings": [{"title": "short name of a cluster of bad or uncertain answers", "why": "what went wrong and why, citing what the turns did", "severity": "bad" | "uncertain", "turns": [turn numbers]}],
 "proposals": [{"kind": "instruction" | "hint" | "synonym" | "definition", "key": "measure or dimension key (hint, synonym)", "text": "the line to add (instruction, hint), or the reading to use (definition)", "words": ["synonyms"], "when": "definition only: the kind of question it settles, in general words", "rationale": "why, and what it fixes", "turns": [turn numbers it would fix]}],
 "questions": [{"pattern": "a definitional question with more than one reasonable reading and no sane default, in general words", "readings": [{"label": "short", "explanation": "what this reading counts and why someone would mean it", "query": {"query_kind": "breakdown" | "series" | "value", "measure": "key", "dimension": "key", "grain": "day", "compute": "mean", "time_last": "30d", "time_period": "last_month", "filters": "dim = value", "limit": 10, "sort": "desc"}}], "examples": ["questions people asked"], "turns": [turn numbers]}],
 "chartCandidates": [{"question": "a question asked often enough to deserve a dashboard chart", "count": times asked, "why": "", "query": {same fields as a reading's query}}]
}

Rules:
- Use only keys from the pack. A query uses the assistant's own arguments: query_kind, measure, dimension, grain, compute ("mean", "pct_change, mean", "rolling_mean 7", "ratio <measure>"), time_last, time_period, filters, limit, sort. Leave out fields you do not need.
- Propose a definition only when one reading is clearly right for this deployment; when it is not clear, log an open question with its readings instead, and let the admin decide. Give every reading a query when the pack can compute it, so the readings can be compared on the data.
- Do not repeat a definition or open question that is already set or logged; you may propose sharpening one, citing it.
- Keep each line short: the definitions are sent with every question and have a size budget.
- A finding cites the turns it is about by number. Do not quote personal names.
- Prefer few, high-value proposals over many small ones. Empty lists are fine.`;

/** Questions asked more than once in the period, by their words: the review's chart candidates start here. */
export function repeats(turns: DigestTurn[], min = 2): { question: string; count: number; turns: number[] }[] {
  const by = new Map<string, { question: string; count: number; turns: number[] }>();
  for (const t of turns) {
    const k = normalPattern(t.question);
    if (!k) continue;
    const x = by.get(k) ?? { question: t.question, count: 0, turns: [] };
    x.count += 1;
    x.turns.push(t.n);
    by.set(k, x);
  }
  return [...by.values()].filter((x) => x.count >= min).sort((a, b) => b.count - a.count).slice(0, 20);
}

// ---- The cap -----------------------------------------------------------------------------------

/** Characters per token, counted low on purpose: the estimate errs toward spending less. */
const CHARS_PER_TOKEN = 3;
const tokensOf = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

export type ReviewPlan = {
  /** The turns as the model reads them. */
  text: string;
  included: number[];
  shortened: number;
  dropped: number;
  inputTokens: number;
  maxOutputTokens: number;
  /** All of the input and the longest answer allowed (thinking included): the most the run can cost. */
  worstUsd: number;
  /** A usual run: all of the input and a quarter of the allowed answer. */
  expectedUsd: number;
};

/**
 * What the run sends, trimmed to the cap. Flagged turns (errors, refusals, findings, clarifications) go first,
 * then the rest, newest first; when they do not fit, the rest are shortened, then left out, then flagged
 * ones are shortened and left out. The answer's room shrinks before the turns do, down to 3,000 tokens.
 */
export function planReview(o: { turns: DigestTurn[]; fixed: string; pricing: Pricing; maxUsd: number; thinkingAllowance?: number; maxOutputTokens?: number }): ReviewPlan | { error: string } {
  const perIn = o.pricing.input / 1e6;
  const perOut = o.pricing.output / 1e6;
  const allowance = o.thinkingAllowance ?? 0;
  let maxOut = o.maxOutputTokens ?? 12_000;
  const fixedTokens = tokensOf(o.fixed.length);
  const budgetFor = (out: number) => (o.maxUsd - (out + allowance) * perOut) / perIn - fixedTokens;
  while (budgetFor(maxOut) < 2000 && maxOut > 3000) maxOut = Math.max(3000, maxOut - 1000);
  const room = budgetFor(maxOut);
  if (room < 500) return { error: `the cap of $${o.maxUsd} does not cover even the review's instructions and a short answer on this model: raise it` };
  const flagged = o.turns.filter((t) => t.flagged).reverse();
  const rest = o.turns.filter((t) => !t.flagged).reverse();
  const picked = new Map<number, string>();
  let used = 0;
  let shortened = 0;
  const tryAdd = (t: DigestTurn) => {
    const full = turnText(t);
    if (used + tokensOf(full.length + 1) <= room) {
      picked.set(t.n, full);
      used += tokensOf(full.length + 1);
      return;
    }
    const short = turnText(t, true);
    if (used + tokensOf(short.length + 1) <= room) {
      picked.set(t.n, short);
      used += tokensOf(short.length + 1);
      shortened += 1;
    }
  };
  for (const t of flagged) tryAdd(t);
  for (const t of rest) tryAdd(t);
  const included = [...picked.keys()].sort((a, b) => a - b);
  const text = included.map((n) => picked.get(n)!).join("\n");
  const inputTokens = fixedTokens + tokensOf(text.length);
  const worstUsd = inputTokens * perIn + (maxOut + allowance) * perOut;
  return { text, included, shortened, dropped: o.turns.length - included.length, inputTokens, maxOutputTokens: maxOut, worstUsd, expectedUsd: inputTokens * perIn + ((maxOut + allowance) / 4) * perOut };
}
