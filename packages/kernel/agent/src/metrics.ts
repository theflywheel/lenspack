import type { EventLine, TelemetryLine, TranscriptLine, TurnLine } from "./telemetry";

// The metrics on the Telemetry tab, worked out from the records when someone looks: nothing here is stored. Each
// reading takes the last days of records (the same lines the checklist counts) and uses only the records that carry
// the fields it needs, so a field switched off part of the week narrows the reading rather than skewing it. A
// reading never shows a user name or the words of a question: names are counted, questions are told apart by their
// hash.

/** A number and how to show it. unit names the word after it (the panel translates it); label names the thing a share is of. */
export type Figure = { kind: "count" | "usd" | "percent" | "ms" | "number"; value: number | null; unit?: string; label?: string };
/** One line of a breakdown: a fixed word (key, translated by the panel) or a value from the records (label, shown as it is). */
export type MetricPart = { key?: string; label?: string; figure: Figure };
export type MetricReading = { value: Figure; parts: MetricPart[]; /** How many records it read. */ records: number; /** A fixed note (translated by the panel), such as why there is no value yet. */ note?: string };

/** What a reading needs beyond the records: what features and Superset counted. */
export type MetricExtras = { now: Date; supersetLogs?: { count: number } | null; owned?: Record<string, { count: number; lastSeen: string | null }> };

const DAY = 86_400_000;
const turns = (lines: TelemetryLine[]) => lines.filter((l): l is TurnLine => l.type === "turn");
const events = (lines: TelemetryLine[], ...names: string[]) => lines.filter((l): l is EventLine => l.type === "event" && names.includes(l.event));
const has = <T extends object>(l: T, k: string) => k in l && (l as Record<string, unknown>)[k] !== undefined && (l as Record<string, unknown>)[k] !== null;
const count = (value: number, unit?: string): Figure => ({ kind: "count", value, ...(unit ? { unit } : {}) });
const pct = (part: number, whole: number, label?: string): Figure => ({ kind: "percent", value: whole ? part / whole : null, ...(label ? { label } : {}) });
const usd = (value: number | null): Figure => ({ kind: "usd", value });
const ms = (value: number | null): Figure => ({ kind: "ms", value });
const num = (value: number | null, unit?: string): Figure => ({ kind: "number", value, ...(unit ? { unit } : {}) });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
/** The nearest-rank percentile. */
function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}
/** Counts by a key, most first; at most n. */
function tally<T>(xs: T[], key: (x: T) => string | null | undefined, n = 5): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) {
    const k = key(x);
    if (k === null || k === undefined || k === "") continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}
/** Distinct users per key (a role, a country), most first. */
function usersBy(ts: TurnLine[], keys: (t: TurnLine) => string[], n = 5): [string, number][] {
  const m = new Map<string, Set<string>>();
  for (const t of ts) for (const k of keys(t)) if (k) (m.get(k) ?? m.set(k, new Set()).get(k)!).add(t.user!);
  return [...m.entries()].map(([k, s]) => [k, s.size] as [string, number]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}
const shares = (rows: [string, number][], whole: number): MetricPart[] => rows.map(([label, n]) => ({ label, figure: pct(n, whole) }));

/** Repeated questions: question hashes asked at least twice, among turns that match. */
function repeated(ts: TurnLine[]) {
  const by = tally(ts.filter((t) => has(t, "questionHash")), (t) => t.questionHash, Infinity).filter(([, n]) => n >= 2);
  return { questions: by.length, asks: sum(by.map(([, n]) => n)) };
}

type Reader = (lines: TelemetryLine[], x: MetricExtras) => MetricReading;

const READERS: Record<string, Reader> = {
  "users-active": (lines, x) => {
    const ts = turns(lines).filter((t) => has(t, "user"));
    const since = x.now.getTime() - DAY;
    const days = new Map<string, Set<string>>();
    for (const t of ts) (days.get(t.at.slice(0, 10)) ?? days.set(t.at.slice(0, 10), new Set()).get(t.at.slice(0, 10))!).add(t.user!);
    const daily = mean([...days.values()].map((s) => s.size));
    return { value: count(new Set(ts.map((t) => t.user)).size, "users"), parts: [{ key: "last24h", figure: count(new Set(ts.filter((t) => Date.parse(t.at) >= since).map((t) => t.user)).size, "users") }, { key: "dailyAvg", figure: num(daily, "users") }], records: ts.length };
  },
  "users-by-role": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "user") && has(t, "roles"));
    const all = usersBy(ts, (t) => [...new Set(t.roles ?? [])], Infinity);
    return { value: count(all.length, "roles"), parts: all.slice(0, 5).map(([label, n]) => ({ label, figure: count(n, "users") })), records: ts.length };
  },
  "users-by-country": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "user") && has(t, "country"));
    const all = usersBy(ts, (t) => [t.country!], Infinity);
    return { value: count(all.length, "countries"), parts: all.slice(0, 5).map(([label, n]) => ({ label, figure: count(n, "users") })), records: ts.length };
  },
  "users-return": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "user") && has(t, "campaign"));
    const campaigns = new Set(ts.map((t) => t.campaign));
    const per = new Map<string, Set<string>>();
    for (const t of ts) (per.get(t.user!) ?? per.set(t.user!, new Set()).get(t.user!)!).add(t.campaign!);
    const back = [...per.values()].filter((s) => s.size >= 2).length;
    if (campaigns.size < 2) return { value: pct(0, 0), parts: [{ key: "campaigns", figure: count(campaigns.size) }], records: ts.length, note: "oneCampaign" };
    return { value: pct(back, per.size), parts: [{ key: "campaigns", figure: count(campaigns.size) }, { key: "inBoth", figure: count(back, "users") }], records: ts.length };
  },
  "volume-per-user": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "user"));
    const users = new Set(ts.map((t) => t.user)).size;
    return { value: num(users ? ts.length / users : null, "questions"), parts: [{ key: "questions", figure: count(ts.length) }, { key: "users", figure: count(users) }], records: ts.length };
  },
  "cost-per-question": (lines) => {
    const ts = turns(lines).filter((t) => typeof t.costUsd === "number");
    const part = (k: "modelUsd" | "speechUsd" | "reviewUsd") => usd(mean(ts.filter((t) => typeof t[k] === "number").map((t) => t[k] as number)));
    return { value: usd(mean(ts.map((t) => t.costUsd!))), parts: [{ key: "total", figure: usd(sum(ts.map((t) => t.costUsd!))) }, { key: "model", figure: part("modelUsd") }, { key: "speech", figure: part("speechUsd") }, { key: "review", figure: part("reviewUsd") }], records: ts.length };
  },
  "cost-per-user": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "user") && typeof t.costUsd === "number");
    const users = new Set(ts.map((t) => t.user)).size;
    const total = sum(ts.map((t) => t.costUsd!));
    return { value: usd(users ? total / users : null), parts: [{ key: "total", figure: usd(total) }, { key: "users", figure: count(users) }], records: ts.length };
  },
  "cost-voice": (lines) => {
    const cs = lines.filter((l): l is TranscriptLine => l.type === "transcript" && typeof l.usd === "number");
    const total = sum(cs.map((c) => c.usd!));
    return { value: usd(total), parts: [{ key: "clips", figure: count(cs.length) }, { key: "perClip", figure: usd(cs.length ? total / cs.length : null) }, { key: "minutes", figure: num(sum(cs.map((c) => c.seconds ?? 0)) / 60) }], records: cs.length };
  },
  "quality-answer-rate": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "outcome"));
    const rate = (xs: TurnLine[]) => pct(xs.filter((t) => t.outcome === "answered").length, xs.length);
    const by = (k: "questionLanguage" | "campaignType") => tally(ts.filter((t) => has(t, k)), (t) => t[k] as string, 3).map(([label]) => ({ label, figure: rate(ts.filter((t) => t[k] === label)) }));
    return { value: rate(ts), parts: [...by("campaignType"), ...by("questionLanguage")], records: ts.length };
  },
  "quality-unanswered": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "outcome") && has(t, "questionHash") && t.outcome !== "answered");
    const top = tally(ts, (t) => t.questionHash, 1)[0];
    return { value: count(ts.length, "questions"), parts: [{ key: "distinct", figure: count(new Set(ts.map((t) => t.questionHash)).size) }, { key: "topRepeat", figure: count(top?.[1] ?? 0, "times") }], records: ts.length };
  },
  "quality-thumbs-down": (lines) => {
    const fb = events(lines, "feedback").filter((e) => has(e, "rating"));
    const down = fb.filter((e) => e.rating === "down");
    return { value: count(down.length, "thumbsDown"), parts: [{ key: "ofRatings", figure: pct(down.length, fb.length) }, ...tally(down, (e) => e.reason, 3).map(([label, n]) => ({ label, figure: count(n) }))], records: fb.length };
  },
  "quality-clarify": (lines) => {
    const asked = turns(lines).filter((t) => t.outcome === "clarify");
    const picked = events(lines, "quick-reply");
    return { value: count(asked.length, "askedBack"), parts: [{ key: "picked", figure: count(picked.length) }, { key: "answeredShare", figure: pct(Math.min(picked.length, asked.length), asked.length) }], records: asked.length + picked.length };
  },
  "asks-top-by-role": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "questionHash") && has(t, "roles"));
    const roles = tally(ts.flatMap((t) => [...new Set(t.roles ?? [])].map((r) => ({ r }))), (x) => x.r, 5);
    return { value: count(new Set(ts.map((t) => t.questionHash)).size, "distinctQuestions"), parts: roles.map(([label]) => ({ label, figure: count(tally(ts.filter((t) => t.roles?.includes(label)), (t) => t.questionHash, 1)[0]?.[1] ?? 0, "topAsked") })), records: ts.length };
  },
  "asks-repeated-direct": (lines) => {
    const ts = turns(lines).filter((t) => t.kind === "direct");
    const r = repeated(ts);
    return { value: count(r.questions, "questions"), parts: [{ key: "askedTimes", figure: count(r.asks) }], records: ts.length };
  },
  "asks-repeated-derived": (lines) => {
    const ts = turns(lines).filter((t) => t.kind === "derived");
    const r = repeated(ts);
    return { value: count(r.questions, "questions"), parts: [{ key: "askedTimes", figure: count(r.asks) }], records: ts.length };
  },
  "asks-mix": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "kind"));
    return { value: count(ts.length, "questions"), parts: shares(tally(ts, (t) => t.kind, 4), ts.length), records: ts.length };
  },
  "speed-p95": (lines) => {
    const ts = turns(lines).filter((t) => typeof t.totalMs === "number");
    const kinds = tally(ts.filter((t) => has(t, "kind")), (t) => t.kind, 4);
    return { value: ms(percentile(ts.map((t) => t.totalMs!), 0.95)), parts: [{ key: "median", figure: ms(percentile(ts.map((t) => t.totalMs!), 0.5)) }, ...kinds.map(([label]) => ({ label, figure: ms(percentile(ts.filter((t) => t.kind === label).map((t) => t.totalMs!), 0.95)) }))], records: ts.length };
  },
  "speed-abandoned": (lines) => {
    const ts = turns(lines).filter((t) => typeof t.abandoned === "boolean");
    const left = ts.filter((t) => t.abandoned).length;
    return { value: pct(left, ts.length), parts: [{ key: "count", figure: count(left, "answers") }], records: ts.length };
  },
  "speed-queue": (lines) => {
    const ts = turns(lines).filter((t) => typeof t.queueMs === "number");
    const waited = ts.filter((t) => t.queueMs! > 0).map((t) => t.queueMs!);
    return { value: ms(percentile(waited, 0.95)), parts: [{ key: "waitedShare", figure: pct(waited.length, ts.length) }, { key: "longest", figure: ms(waited.length ? Math.max(...waited) : null) }], records: ts.length };
  },
  "voice-share": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "input"));
    const spoken = ts.filter((t) => t.input === "spoken").length;
    return { value: pct(spoken, ts.length), parts: [{ key: "spoken", figure: count(spoken, "questions") }], records: ts.length };
  },
  "voice-edit-rate": (lines) => {
    const ts = turns(lines).filter((t) => typeof t.transcriptEditDistance === "number");
    const rate = (xs: TurnLine[]) => pct(xs.filter((t) => t.transcriptEditDistance! > 0).length, xs.length);
    return { value: rate(ts), parts: tally(ts.filter((t) => has(t, "questionLanguage")), (t) => t.questionLanguage, 3).map(([label]) => ({ label, figure: rate(ts.filter((t) => t.questionLanguage === label)) })), records: ts.length };
  },
  "voice-reask": (lines) => {
    const ts = turns(lines).filter((t) => "reAskAfterVoice" in t);
    const again = ts.filter((t) => typeof t.reAskAfterVoice === "string").length;
    const spoken = turns(lines).filter((t) => t.input === "spoken").length;
    return { value: count(again, "times"), parts: [{ key: "ofSpoken", figure: pct(again, spoken) }], records: ts.length };
  },
  "voice-not-sent": (lines) => {
    const es = events(lines, "abandoned").filter((e) => e.stage === "after-transcription");
    return { value: count(es.length, "transcripts"), parts: [], records: es.length };
  },
  "language-mix": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "questionLanguage"));
    const all = tally(ts, (t) => t.questionLanguage, Infinity);
    return { value: count(all.length, "languages"), parts: shares(all.slice(0, 5), ts.length), records: ts.length };
  },
  "voice-wer-proxy": (lines) => {
    const ts = turns(lines).filter((t) => typeof t.transcriptEditDistance === "number" && typeof t.questionWords === "number" && t.questionWords > 0);
    const words = sum(ts.map((t) => t.questionWords!));
    return { value: pct(sum(ts.map((t) => t.transcriptEditDistance!)), words), parts: [{ key: "spoken", figure: count(ts.length, "questions") }], records: ts.length };
  },
  "conv-rephrase": (lines) => {
    const ts = turns(lines).filter((t) => "rephraseOf" in t);
    const again = ts.filter((t) => typeof t.rephraseOf === "string").length;
    return { value: pct(again, ts.length), parts: [{ key: "count", figure: count(again, "questions") }], records: ts.length };
  },
  "conv-follow-ups": (lines) => {
    const ts = turns(lines).filter((t) => has(t, "sessionId"));
    const sessions = new Set(ts.map((t) => t.sessionId)).size;
    return { value: num(sessions ? ts.length / sessions : null, "questions"), parts: [{ key: "conversations", figure: count(sessions) }], records: ts.length };
  },
  "trust-explain": (lines) => {
    const es = events(lines, "explain-opened");
    return { value: count(es.length, "times"), parts: [], records: es.length };
  },
  "trust-export-share": (lines) => {
    const es = events(lines, "chart-exported", "board-shared");
    return { value: count(es.length, "times"), parts: [{ key: "exported", figure: count(es.filter((e) => e.event === "chart-exported").length) }, { key: "shared", figure: count(es.filter((e) => e.event === "board-shared").length) }], records: es.length };
  },
  "personal-dashboards": (lines) => {
    const es = events(lines, "personal-dashboard", "saved-layout");
    return { value: count(es.length, "actions"), parts: tally(es, (e) => (e.how ? `${e.event === "saved-layout" ? "layout" : "dashboard"}: ${e.how}` : null), 4).map(([label, n]) => ({ label, figure: count(n) })), records: es.length };
  },
  "trust-superset-actions": (_lines, x) => ({ value: count(x.supersetLogs?.count ?? 0, "actions"), parts: [], records: x.supersetLogs?.count ?? 0 }),
  "reuse-hit-rate": (lines) => {
    const ts = turns(lines).filter((t) => "reuse" in t);
    const reused = ts.filter((t) => typeof t.reuse === "string");
    return { value: pct(reused.length, ts.length), parts: tally(reused, (t) => t.reuse, 4).map(([label, n]) => ({ label, figure: count(n) })), records: ts.length };
  },
  "reuse-saved": (lines) => {
    const ts = turns(lines).filter((t) => typeof t.reuseSavedUsd === "number");
    return { value: usd(sum(ts.map((t) => t.reuseSavedUsd!))), parts: [{ key: "reused", figure: count(ts.length, "answers") }], records: ts.length };
  },
  "review-runs": (_l, x) => owned(x, "review-runs", "runs"),
  "review-proposals": (_l, x) => owned(x, "review-proposals", "proposals"),
  "review-open-questions": (_l, x) => owned(x, "review-open-questions", "questions"),
  "device-class": (lines) => spread(turns(lines).filter((t) => has(t, "device")), (t) => t.device),
  "device-network": (lines) => spread(turns(lines).filter((t) => has(t, "network")), (t) => t.network),
};

function owned(x: MetricExtras, id: string, unit: string): MetricReading {
  const n = x.owned?.[id]?.count ?? 0;
  return { value: count(n, unit), parts: [], records: n };
}
/** The most common value's share as the figure, and the rest as parts. */
function spread(ts: TurnLine[], key: (t: TurnLine) => string | null | undefined): MetricReading {
  const rows = tally(ts, key, 5);
  return { value: pct(rows[0]?.[1] ?? 0, ts.length, rows[0]?.[0]), parts: shares(rows.slice(1), ts.length), records: ts.length };
}

/** Whether a metric can be read from records here (the ones that cannot are not telemetry). */
export const readable = (id: string) => id in READERS;

/** A metric's value from these records. */
export function readMetric(id: string, lines: TelemetryLine[], x: MetricExtras): MetricReading | null {
  const r = READERS[id];
  return r ? r(lines, x) : null;
}
