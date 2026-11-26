// Usage telemetry without a host: how a turn is classified, repeats and sessions, the transcript a spoken question
// came from, client events and who may send them, transcripts never sent, and question text kept as a hash. The
// store here is a few lines in memory, which is all a TelemetryStore asks for.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { type EventRecord, type TelemetryLine, type TelemetryStore, type ToolFact, type TranscriptRecord, type TurnRecord, type TurnStart, TELEMETRY_ITEMS, classifyKind, classifyOutcome, factsFromSteps, scriptLanguage, switchable, textSimilarity, turnTelemetry, wordEditDistance } from "../src";

function memoryStore(clock: () => number): TelemetryStore & { lines: TelemetryLine[] } {
  const lines: TelemetryLine[] = [];
  const state = new Map<string, { value: unknown; until: number }>();
  const live = (k: string) => {
    const e = state.get(k);
    if (e && e.until <= clock()) state.delete(k);
    return e && e.until > clock() ? e : undefined;
  };
  return {
    lines,
    append: async (l) => void lines.push(l),
    find: async (q) => lines.filter((l) => l.at >= q.from.toISOString() && (!q.to || l.at <= q.to.toISOString()) && (!q.type || l.type === q.type) && (!q.user || l.user === q.user) && (!q.turnId || ("turnId" in l && l.turnId === q.turnId))).reverse(),
    state: {
      get: async <T>(k: string) => (live(k)?.value as T | undefined) ?? null,
      put: async (k, value, ttl) => void state.set(k, { value, until: clock() + ttl }),
      take: async <T>(k: string) => {
        const e = live(k);
        state.delete(k);
        return (e?.value as T | undefined) ?? null;
      },
      list: async <T>(p: string) => [...state.keys()].filter((k) => k.startsWith(p) && live(k)).map((key) => ({ key, value: state.get(key)!.value as T })),
    },
  };
}

const hash = (t: string) => createHash("sha256").update(`test-key:${t}`).digest("hex").slice(0, 24);
const ana = { user: "ana", roles: ["Gamma"] };
// Every item on, so each test sees every field; the switches have their own tests (switchboard.test.ts).
const ALL: ReadonlySet<string> = new Set(TELEMETRY_ITEMS.filter(switchable).map((s) => s.id));
const NO_TEXT: ReadonlySet<string> = new Set([...ALL].filter((id) => id !== "question-text" && id !== "transcript-text"));

function recorder(opts: { items?: () => ReadonlySet<string>; transcriptWaitMs?: number } = {}) {
  let t = Date.parse("2026-11-20T10:00:00Z");
  const store = memoryStore(() => t);
  const tel = turnTelemetry({ store, hash, now: () => new Date(t), context: () => ({ b1: { campaign: "Round 1" }, "role:Gamma": { country: "A" } }), items: () => ALL, ...opts });
  let n = 0;
  const start = (question: string, o: Partial<TurnStart> = {}): TurnStart => ({ turnId: `t${++n}`, who: ana, board: "b1", pack: "p", question, transcriptIds: [], newConversation: false, languagePicked: "auto", client: { device: "mobile", network: "3g", viewport: "narrow", userAgent: "Mozilla/5.0 (should not be kept)" }, builder: "m", effort: null, readOnly: false, datasetOf: () => undefined, ...o });
  const ask = async (question: string, o: Partial<TurnStart> = {}) => {
    const cap = (await tel.begin(start(question, o)))!;
    cap.ended({});
    await cap.record();
    return cap;
  };
  const heard = (id: string, text: string, user = "ana", language: string | null = "en") => tel.transcribed({ id, who: { user, roles: [] }, pack: "p", model: "stt", languageRequested: null, languageDetected: language, seconds: 2, usd: 0.0001, ms: 300, retried: false, text });
  return { tel, store, ask, start, heard, move: (ms: number) => (t += ms), turns: () => store.lines.filter((l): l is TurnRecord => l.type === "turn"), events: () => store.lines.filter((l): l is EventRecord => l.type === "event") };
}

describe("what kind of question a turn was", () => {
  const q = (input: unknown, output: unknown = { ok: true, rows: [] }): ToolFact => ({ tool: "query", input, output });
  it("reads it from the tool calls alone", () => {
    expect(classifyKind([])).toBe("meta");
    expect(classifyKind([{ tool: "list_metrics", output: {} }, { tool: "get_board", output: {} }])).toBe("meta");
    expect(classifyKind([q({ measure: "a" })])).toBe("direct");
    // A failed query retried once is still one question.
    expect(classifyKind([q({ measure: "x" }, { ok: false, error: "no such measure" }), q({ measure: "a" })])).toBe("direct");
    expect(classifyKind([q({ measure: "a" }), q({ measure: "b" })])).toBe("derived");
    expect(classifyKind([q({ measure: "a", compute: [{ op: "share" }] })])).toBe("derived");
    expect(classifyKind([q({ measure: "a" }), { tool: "add_widget", input: {}, output: { applied: true } }])).toBe("chart");
  });

  it("reads how it ended from structured results, never from its words", () => {
    const answered = [q({ measure: "a" })];
    expect(classifyOutcome({ facts: answered })).toEqual({ outcome: "answered", reason: null });
    expect(classifyOutcome({ facts: answered, error: "provider overloaded" })).toEqual({ outcome: "failed", reason: "error" });
    expect(classifyOutcome({ facts: answered, error: "The operation timed out" })).toEqual({ outcome: "failed", reason: "timeout" });
    expect(classifyOutcome({ facts: [], stepCap: true })).toEqual({ outcome: "failed", reason: "step-cap" });
    expect(classifyOutcome({ facts: [], rolledBack: true })).toEqual({ outcome: "failed", reason: "rolled-back" });
    expect(classifyOutcome({ facts: [], saveFailed: true })).toEqual({ outcome: "failed", reason: "not-saved" });
    expect(classifyOutcome({ facts: [], clarify: true })).toEqual({ outcome: "clarify", reason: null });
    expect(classifyOutcome({ facts: [], finish: "content-filter" })).toEqual({ outcome: "declined", reason: "content-filter" });
    expect(classifyOutcome({ facts: [q({ measure: "a" }, { ok: false, error: "refused" })] })).toEqual({ outcome: "declined", reason: "no-data" });
    expect(classifyOutcome({ facts: [{ tool: "query", input: {}, error: "bad input" }] })).toEqual({ outcome: "declined", reason: "no-data" });
    expect(classifyOutcome({ facts: [{ tool: "add_widget", input: {}, output: { applied: false, error: "no" } }] })).toEqual({ outcome: "declined", reason: "refused" });
    expect(classifyOutcome({ facts: [{ tool: "add_widget", input: {}, output: { applied: false, error: "read only" } }], readOnly: true })).toEqual({ outcome: "declined", reason: "read-only" });
    expect(classifyOutcome({ facts: [{ tool: "add_widget", input: {}, output: { applied: true } }] })).toEqual({ outcome: "answered", reason: null });
  });

  it("takes the tool calls from a model run's steps by their shape", () => {
    const steps = [{ content: [{ type: "text", text: "x" }, { type: "tool-result", toolName: "query", input: { measure: "a" }, output: { ok: true } }] }, { content: [{ type: "tool-error", toolName: "add_widget", input: {}, error: new Error("nope") }] }];
    expect(factsFromSteps(steps)).toEqual([
      { tool: "query", input: { measure: "a" }, output: { ok: true } },
      { tool: "add_widget", input: {}, error: "nope" },
    ]);
  });
});

describe("text measures", () => {
  it("counts word edits between a transcript and what was sent", () => {
    expect(wordEditDistance("How many cases in March", "how many cases in march?")).toBe(0);
    expect(wordEditDistance("how many cases in marsh", "how many cases in March")).toBe(1);
    expect(wordEditDistance("cases by region", "show cases by region please")).toBe(2);
    expect(wordEditDistance("", "two words")).toBe(2);
  });
  it("finds the same question asked again, and guesses the language", () => {
    expect(textSimilarity("How many visits last week?", "how many visits last week")).toBe(1);
    expect(textSimilarity("how many visits last week", "how many visits in the last week")).toBeGreaterThanOrEqual(0.6);
    expect(textSimilarity("how many visits last week", "add a map of the regions")).toBeLessThan(0.6);
    expect(scriptLanguage("combien de visites par mois")).toBe("fr");
    expect(scriptLanguage("quantos casos por mês")).toBe("pt");
    expect(scriptLanguage("how many cases by month")).toBe("en");
    expect(scriptLanguage("पिछले सप्ताह कितने मामले")).toBe("hi");
    expect(scriptLanguage("ok")).toBe(null);
  });
});

describe("repeats and sessions", () => {
  it("links a similar question from the same user within two minutes, and a re-ask after a spoken one", async () => {
    const { ask, heard, move, turns } = recorder();
    await ask("how many visits last week");
    move(60_000);
    await ask("how many visits in the last week");
    move(30_000);
    await ask("add a map of the regions");
    move(3 * 60_000);
    await ask("add a map of the regions");
    // Another user's question is never theirs to repeat.
    await ask("add a map of the regions", { who: { user: "ben", roles: [] } });
    expect(turns().map((x) => x.rephraseOf)).toEqual([null, "t1", null, null, null]);
    // Spoken, then typed again within two minutes: a re-ask after voice.
    await heard("clip-1", "how many visits today");
    await ask("how many visits today", { transcriptIds: ["clip-1"] });
    move(20_000);
    await ask("how many visits today?");
    const [spoken, again] = turns().slice(-2);
    expect(spoken).toMatchObject({ input: "spoken", reAskAfterVoice: null });
    expect(again).toMatchObject({ input: "typed", rephraseOf: spoken!.turnId, reAskAfterVoice: spoken!.turnId });
  });

  it("starts a new session after 30 idle minutes, on another board, or on a new chat", async () => {
    const { ask, move, turns } = recorder();
    await ask("a");
    move(29 * 60_000);
    await ask("b");
    move(31 * 60_000);
    await ask("c");
    await ask("d", { board: "b2" });
    await ask("e", { board: "b2", newConversation: true });
    await ask("f", { board: "b2" });
    const ids = turns().map((x) => x.sessionId);
    expect(ids[0]).toBe(ids[1]);
    expect(new Set([ids[1], ids[2], ids[3], ids[4]]).size).toBe(4);
    expect(ids[5]).toBe(ids[4]);
  });

  it("keeps the viewer's dashboard selections as the turn's context, hashed when question text is off", async () => {
    let keep = true;
    const { ask, turns } = recorder({ items: () => (keep ? ALL : NO_TEXT) });
    await ask("visits here", { selections: { Region: "North" } });
    keep = false;
    await ask("visits here", { selections: { Region: "North" } });
    await ask("visits everywhere");
    const [a, b, c] = turns();
    expect(a!.selections).toEqual({ Region: "North" });
    expect(b!.selections).toEqual({ Region: hash("north") });
    expect(c!.selections).toBe(null);
  });

  it("keeps the client's classes, never a raw user agent, and the deployment's context", async () => {
    const { ask, store } = recorder();
    await ask("a");
    expect(store.lines[0]).toMatchObject({ device: "mobile", network: "3g", viewport: "narrow", saveData: null, campaign: "Round 1", country: "A", campaignType: null });
    expect(JSON.stringify(store.lines)).not.toContain("Mozilla");
  });
});

describe("a spoken question", () => {
  it("is linked to its transcript: distance 0 when sent as heard, the word edits when changed, and nothing from someone else's", async () => {
    const { ask, heard, turns } = recorder();
    await heard("c1", "how many visits in march");
    await ask("how many visits in March?", { transcriptIds: ["c1"] });
    await heard("c2", "combien de visite", "ana", "fr");
    await ask("combien de visites par mois", { transcriptIds: ["c2"], languagePicked: "auto" });
    await heard("c3", "how many visits", "ben");
    await ask("how many visits", { transcriptIds: ["c3"] });
    // A transcript is claimed once.
    await ask("how many visits in march", { transcriptIds: ["c1"] });
    expect(turns().map((r) => [r.input, r.transcript, r.transcriptEditDistance])).toEqual([
      ["spoken", "how many visits in march", 0],
      ["spoken", "combien de visite", 3],
      ["spoken", null, null],
      ["spoken", null, null],
    ]);
    expect(turns()[1]).toMatchObject({ questionLanguage: "fr", replyLanguage: "fr" });
  });

  it("never sent is recorded as abandoned after transcription, once", async () => {
    const { tel, heard, move, events } = recorder({ transcriptWaitMs: 10 * 60_000 });
    await heard("clip-x", "combien de visites", "ana", "fr");
    // An empty transcript is a miss, not something to send.
    await heard("clip-e", "");
    move(5 * 60_000);
    await tel.sweep();
    expect(events()).toEqual([]);
    move(6 * 60_000);
    await Promise.all([tel.sweep(), tel.sweep()]);
    expect(events()).toEqual([expect.objectContaining({ event: "abandoned", stage: "after-transcription", how: "not-sent", transcriptId: "clip-x", user: "ana" })]);
  });
});

describe("question text off", () => {
  it("keeps a keyed hash of questions and transcripts instead of their words, and still counts edits and repeats", async () => {
    let keep = true;
    const { ask, heard, move, store, turns } = recorder({ items: () => (keep ? ALL : NO_TEXT) });
    await ask("How many visits?");
    keep = false;
    await heard("clip-h", "how many visit");
    move(10_000);
    await ask("how many visits", { transcriptIds: ["clip-h"] });
    const [shown, hidden] = turns();
    expect(shown!.question).toBe("How many visits?");
    // Left out of the record, not filled with nulls.
    expect(hidden).toMatchObject({ transcriptEditDistance: 1 });
    expect("question" in hidden!).toBe(false);
    expect("transcript" in hidden!).toBe(false);
    // Equal questions share a hash, whatever the case and punctuation, so repeats can still be counted.
    expect(hidden!.questionHash).toBe(shown!.questionHash);
    expect(hidden!.rephraseOf).toBe(shown!.turnId);
    const t = store.lines.find((l): l is TranscriptRecord => l.type === "transcript")!;
    expect("transcript" in t).toBe(false);
    expect(t.transcriptHash).toBe(hidden!.transcriptHash);
    expect(JSON.stringify(store.lines).match(/how many visit/gi)?.length).toBe(1);
  });
});

describe("events", () => {
  it("are taken from a user on their own turns only, in their own tenant, and checked", async () => {
    const { tel, ask, events, turns } = recorder();
    await ask("how many visits");
    expect(await tel.event(ana, { type: "feedback", turnId: "t1", rating: "down", reason: "wrong-number", comment: "the total is off" })).toEqual({ ok: true, recorded: true });
    expect(await tel.event({ user: "ben", roles: [] }, { type: "feedback", turnId: "t1", rating: "up" })).toEqual({ ok: false, status: 403, error: "that turn is not yours" });
    expect(await tel.event({ ...ana, tenant: "other" }, { type: "feedback", turnId: "t1", rating: "up" })).toMatchObject({ ok: false, status: 403 });
    expect(await tel.event(ana, { type: "feedback", turnId: "t99", rating: "up" })).toMatchObject({ ok: false, status: 404 });
    expect(await tel.event(ana, { type: "feedback", turnId: "t1", rating: "meh" })).toMatchObject({ ok: false, status: 400 });
    expect(await tel.event(ana, { type: "feedback", turnId: "t1", rating: "down", reason: "bad vibes" })).toMatchObject({ ok: false, status: 400 });
    expect(await tel.event(ana, { type: "feedback", rating: "up" })).toMatchObject({ ok: false, status: 400 });
    expect(await tel.event(ana, { type: "Not A Type" })).toMatchObject({ ok: false, status: 400 });
    expect(await tel.event(ana, { type: "explain-opened", turnId: "t1", data: { nested: { no: 1 } } })).toMatchObject({ ok: false, status: 400 });
    // Another part of the panel reports its own event; a field that looks like a secret is dropped.
    expect(await tel.event(ana, { type: "explain-opened", turnId: "t1", data: { step: 2, apiKey: "sk-should-not-be-kept" } })).toEqual({ ok: true, recorded: true });
    expect(await tel.event(ana, { type: "transcript", turnId: "t1", transcript: "how many visit", sent: "how many visits today" })).toEqual({ ok: true, recorded: true });
    const [fb, ex, tr] = events();
    expect(fb).toMatchObject({ event: "feedback", rating: "down", reason: "wrong-number", comment: "the total is off", sessionId: turns()[0]!.sessionId, board: "b1" });
    expect(ex).toMatchObject({ event: "explain-opened", data: { step: 2 } });
    expect(tr).toMatchObject({ event: "transcript", transcriptEditDistance: 2, transcriptWords: 4 });
    expect(JSON.stringify(events())).not.toContain("sk-should-not-be-kept");
  });

  it("can be about a turn still running: its owner is known before its record is written", async () => {
    const { tel, start } = recorder();
    const cap = (await tel.begin(start("how many visits")))!;
    expect(await tel.event(ana, { type: "explain-opened", turnId: cap.turnId })).toEqual({ ok: true, recorded: true });
    expect(await tel.event({ user: "ben", roles: [] }, { type: "explain-opened", turnId: cap.turnId })).toMatchObject({ status: 403 });
  });
});

describe("a turn's hooks", () => {
  const chunks = <T>(list: T[]) => new ReadableStream<T>({ start: (c) => (list.forEach((x) => c.enqueue(x)), c.close()) });
  const drain = async <T>(s: ReadableStream<T>) => {
    const r = s.getReader();
    while (!(await r.read()).done);
  };

  it("gather the record from the run, the reply stream and the cost", async () => {
    const { tel, start, store, move } = recorder();
    const cap = (await tel.begin(start("count the visits", { datasetOf: (k) => (k === "visits" ? "visits_table" : undefined) })))!;
    expect(cap.part()).toEqual({ type: "data-turn", data: { turnId: "t1", sessionId: cap.sessionId } });
    move(400);
    await drain(cap.watch(chunks([{ type: "start" }, { type: "text-delta", delta: "There" }, { type: "data-reuse", data: { tier: "exact" } }, { type: "finish" }])));
    cap.round({ steps: [{ content: [{ type: "tool-result", toolName: "query", input: { measure: "visits" }, output: { ok: true } }] }], finish: "stop", answered: true, maxSteps: 12, fix: false });
    cap.reviewed({ material: 1, fix: false });
    cap.round({ steps: [], finish: "stop", answered: true, maxSteps: 12, fix: true });
    cap.left();
    cap.ended({ cost: { total: { usd: 0.01, unpriced: 0, inputTokens: 900, outputTokens: 80 }, models: [{ role: "builder", model: "small", usd: 0.006 }, { role: "review", model: "big", usd: 0.003 }, { role: "speech", model: "stt", usd: 0.001 }] } });
    await cap.record();
    expect(store.lines[0]).toMatchObject({ kind: "direct", outcome: "answered", datasets: ["visits_table"], firstTokenMs: 400, abandoned: false, reuse: "exact", reviewRan: true, reviewMaterial: 1, fixRound: true, modelUsd: 0.006, reviewUsd: 0.003, speechUsd: 0.001, models: ["small", "big", "stt"], tokensIn: 900 });
  });

  it("note a reader who left before the answer finished, and a step cap", async () => {
    const { tel, start, store, move } = recorder();
    const cap = (await tel.begin(start("a slow one")))!;
    move(250);
    cap.left();
    cap.round({ steps: Array.from({ length: 12 }, () => ({ content: [] })), finish: "tool-calls", answered: false, maxSteps: 12, fix: false });
    cap.ended({});
    await cap.record();
    expect(store.lines[0]).toMatchObject({ abandoned: true, abandonedMs: 250, outcome: "failed", outcomeReason: "step-cap" });
  });

  it("record nothing while telemetry is off", async () => {
    let t = 0;
    const store = memoryStore(() => t);
    const tel = turnTelemetry({ store, hash, on: () => false });
    expect(await tel.begin({ turnId: "x", who: ana, board: null, pack: "p", question: "q", transcriptIds: [], newConversation: true, languagePicked: null, client: null, builder: "m", effort: null, readOnly: false, datasetOf: () => undefined })).toBe(null);
    await tel.transcribed({ id: "c", who: ana, pack: null, model: "m", languageRequested: null, languageDetected: null, seconds: null, usd: null, ms: 0, retried: false, text: "q" });
    expect(await tel.event(ana, { type: "feedback", turnId: "x", rating: "up" })).toMatchObject({ status: 404 });
    expect(store.lines).toEqual([]);
    t++;
  });
});
