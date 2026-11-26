// Usage telemetry on one machine: the files it is kept in (by month, with retention, and working state that
// survives a restart), and through the server: the turn record, the transcript a spoken question came from, client
// events, a reader who leaves early, and kept recordings with their consent notice, retention and admin routes.
// What a record says and how a turn is classified is tested without a host, in packages/kernel/agent.
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { type Server, createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type EventRecord, type TelemetryLine, type TranscriptRecord, type TurnRecord, TELEMETRY_ITEMS, switchable } from "@lenspack/agent";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AudioSettings, type Host, type Provider, DEFAULT_SPEECH_MODEL, adminRoutes, adminSettings, audioManifest, buildProvider, configSchema, createApp, fileAudioStore, fileTelemetry, fileTelemetryStore, openConfig, registerLlmAdapter, rotatingLog } from "../src";

const tmp = () => mkdtempSync(join(tmpdir(), "lp-telemetry-"));
const lines = (dir: string): TelemetryLine[] =>
  existsSync(join(dir, "telemetry.jsonl"))
    ? readFileSync(join(dir, "telemetry.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const turns = (dir: string) => lines(dir).filter((l): l is TurnRecord => l.type === "turn");
const events = (dir: string) => lines(dir).filter((l): l is EventRecord => l.type === "event");
const asker = { user: "ana", roles: ["Gamma"] };
// Every item on, so these tests see every field; the defaults and the switches are tested below and in the kernel.
const ALL: ReadonlySet<string> = new Set(TELEMETRY_ITEMS.filter(switchable).map((s) => s.id));

describe("retention", () => {
  it("moves the month to its own file and deletes months past the retention", () => {
    const dir = tmp();
    let now = new Date("2026-08-15T00:00:00Z");
    writeFileSync(join(dir, "telemetry-2026-04.jsonl"), `${JSON.stringify({ at: "2026-04-02T00:00:00Z" })}\n`);
    const log = rotatingLog<{ at: string; n: number }>(dir, "telemetry", { retentionDays: () => 60, now: () => now });
    // April's last day is more than 60 days back: gone at start.
    expect(readdirSync(dir)).not.toContain("telemetry-2026-04.jsonl");
    log.append({ at: now.toISOString(), n: 1 });
    now = new Date("2026-09-02T00:00:00Z");
    log.append({ at: now.toISOString(), n: 2 });
    expect(readdirSync(dir).sort()).toEqual(["telemetry-2026-08.jsonl", "telemetry.jsonl"]);
    now = new Date("2026-11-05T00:00:00Z");
    log.append({ at: now.toISOString(), n: 3 });
    // August ended more than 60 days ago; September has not.
    expect(readdirSync(dir).sort()).toEqual(["telemetry-2026-09.jsonl", "telemetry.jsonl"]);
    expect(log.since(new Date("2026-01-01")).map((l) => l.n)).toEqual([3, 2]);
  });
});


describe("the file store", () => {
  it("keeps sessions, transcripts waiting for a question, and turns in flight across a restart", async () => {
    const dir = tmp();
    const t = new Date("2026-11-20T10:00:00Z");
    const start = (turnId: string, question: string, transcriptIds: string[] = []) => ({ turnId, who: asker, board: "b1", pack: "p", question, transcriptIds, newConversation: false, languagePicked: null, client: null, builder: "m", effort: null, readOnly: false, datasetOf: () => undefined });
    const first = fileTelemetry(dir, { now: () => t, items: () => ALL }).telemetry;
    const a = (await first.begin(start("t1", "how many visits")))!;
    a.ended({});
    await a.record();
    await first.transcribed({ id: "clip-1", who: asker, pack: "p", model: "stt", languageRequested: null, languageDetected: "en", seconds: 1, usd: null, ms: 1, retried: false, text: "how many visit today" });
    const open = (await first.begin(start("t2", "what is on the board")))!;
    // The process restarts here: a new store over the same directory.
    const second = fileTelemetry(dir, { now: () => new Date(t.getTime() + 60_000), items: () => ALL }).telemetry;
    expect(await second.event(asker, { type: "explain-opened", turnId: open.turnId })).toEqual({ ok: true, recorded: true });
    const b = (await second.begin(start("t3", "how many visits today", ["clip-1"])))!;
    b.ended({});
    await b.record();
    const [r1, r3] = turns(dir);
    expect(r3).toMatchObject({ sessionId: r1!.sessionId, transcript: "how many visit today", transcriptEditDistance: 1 });
    // The hashing key stays beside the log, never in it, and readable by its owner only.
    const key = readFileSync(join(dir, "telemetry.key"), "utf8").trim();
    expect(readFileSync(join(dir, "telemetry.jsonl"), "utf8")).not.toContain(key);
    expect((await import("node:fs")).statSync(join(dir, "telemetry.key")).mode & 0o077).toBe(0);
  });

  it("answers recent reads from memory and older ones from the monthly files", async () => {
    const dir = tmp();
    let now = new Date("2026-10-01T00:00:00Z");
    const store = fileTelemetryStore({ dir, now: () => now });
    await store.append({ type: "event", at: now.toISOString(), user: "ana" } as TelemetryLine);
    now = new Date("2026-11-20T00:00:00Z");
    await store.append({ type: "event", at: now.toISOString(), user: "ben" } as TelemetryLine);
    expect((await store.find({ from: new Date("2026-11-19T00:00:00Z") })).map((l) => l.user)).toEqual(["ben"]);
    expect((await store.find({ from: new Date("2026-09-01T00:00:00Z"), user: "ana" })).map((l) => l.user)).toEqual(["ana"]);
    expect(store.months()).toContain("2026-10");
  });
});

// --- through the server ---------------------------------------------------------

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const finishPart = (reason: "stop" | "tool-calls") => ({ type: "finish" as const, finishReason: { unified: reason, raw: reason }, usage });
const text = (t: string) => [{ type: "text-start" as const, id: "t" }, { type: "text-delta" as const, id: "t", delta: t }, { type: "text-end" as const, id: "t" }];

function model(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const last = JSON.stringify(prompt.at(-1));
      const asked = JSON.stringify([...prompt].reverse().find((m) => m.role === "user") ?? "");
      // "count" asks for one query, then answers once the tool result is in.
      if (asked.includes("count") && !last.includes("tool-result"))
        return { stream: new ReadableStream({ start: (c) => (c.enqueue({ type: "tool-call", toolCallId: "q1", toolName: "query", input: JSON.stringify({ measure: "tickets" }) }), c.enqueue(finishPart("tool-calls")), c.close()) }) };
      // "slow" waits before it says anything, so a reader can leave first.
      if (asked.includes("slow")) await new Promise((r) => setTimeout(r, 600));
      return { stream: new ReadableStream({ start: (c) => (text("Here it is.").forEach((p) => c.enqueue(p)), c.enqueue(finishPart("stop")), c.close()) }) };
    },
  });
}

describe("telemetry through the server", () => {
  const ticketsPack = fileURLToPath(new URL("../../../../examples/tickets/pack.yaml", import.meta.url));
  let host: Host;
  let close: () => Promise<void>;
  let server: Server;
  let base: string;
  let state: string;
  let keep: AudioSettings;

  beforeAll(async () => {
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack: ticketsPack, source: "data" }] }), tmpdir());
    host = opened.hosts[0]!;
    close = opened.close;
    await host.store.create({ id: "tel-board", pack: host.pack, title: "Overview" });
    registerLlmAdapter({ kind: "tel-mock", defaultBaseUrl: "mock:", build: () => model() });
    const mock: Provider = { ...buildProvider({ name: "mock", kind: "tel-mock", model: "m", pricing: { input: 1, output: 2 } }), available: true };
    state = tmp();
    keep = { keepAudio: false, audioRetentionDays: 30, maxStoredMb: 100, consentNotice: null };
    const { telemetry } = fileTelemetry(state, { items: () => ALL, context: () => ({ "tel-board": { campaign: "Round 1", country: "A" } }) });
    const audio = fileAudioStore({ dir: state, settings: () => keep });
    const stt = (async (_u: unknown, init?: RequestInit) => {
      const lang = JSON.parse(String(init?.body)).language;
      return new Response(JSON.stringify({ text: lang === "fr" ? "combien de tickets" : "how many tickets are open", usage: { seconds: 2, cost: 0.0002 } }));
    }) as typeof fetch;
    server = createServer(
      createApp([host], {
        providers: [mock],
        review: () => false,
        // Who is asking: the x-user header (none: not signed in).
        access: (req) => (req.headers["x-user"] ? { user: String(req.headers["x-user"]), edit: true, maintain: true, roles: ["Gamma"] } : null),
        telemetry,
        audio,
        speech: { apiKey: "k", model: () => DEFAULT_SPEECH_MODEL, fetch: stt },
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(async () => {
    server.close();
    await close();
  });

  const ask = async (q: string, o: { user?: string; speech?: string[] } = {}) => {
    const res = await fetch(`${base}/${host.name}/tel-board/chat`, {
      method: "POST",
      headers: { "x-user": o.user ?? "ana" },
      body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: q }] }], language: "auto", client: { device: "desktop", network: "4g", viewport: "wide" }, ...(o.speech ? { speech: o.speech } : {}) }),
    });
    const turnId = res.headers.get("x-lenspack-turn")!;
    const body = await res.text();
    // The record is written once the turn has ended, just after the stream.
    for (let i = 0; i < 50 && !turns(state).some((t) => t.turnId === turnId); i++) await new Promise((r) => setTimeout(r, 20));
    return { turnId, body, record: turns(state).find((t) => t.turnId === turnId)! };
  };
  const speak = async (lang: string, user = "ana") => (await fetch(`${base}/_stt?language=${lang}`, { method: "POST", headers: { "content-type": "audio/webm", "x-user": user }, body: new Uint8Array([26, 69, 223, 163, 1, 2, 3, 4]) })).json() as Promise<{ text: string; clip: string; transcriptId: string }>;
  const post = (body: unknown, user?: string) => fetch(`${base}/_telemetry`, { method: "POST", headers: user ? { "x-user": user } : {}, body: JSON.stringify(body) });

  it("writes one record per turn, with its id in the header and the stream", async () => {
    const { turnId, body, record } = await ask("what is on this board?");
    expect(turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toContain(`"type":"data-turn","data":{"turnId":"${turnId}"`);
    expect(record).toMatchObject({ v: 2, user: "ana", roles: ["Gamma"], board: "tel-board", pack: host.name, campaign: "Round 1", country: "A", kind: "meta", outcome: "answered", input: "typed", question: "what is on this board?", device: "desktop", network: "4g", builder: "mock", abandoned: false, reuse: null, queueMs: expect.any(Number) });
    expect(record.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(record.totalMs).toBeGreaterThanOrEqual(record.firstTokenMs!);
    expect(record.costUsd).toBeCloseTo((100 + 20) / 1e6, 9);
    expect(record.modelUsd).toBeCloseTo(record.costUsd, 9);
  });

  it("classifies a turn from its tool calls and names the datasets it touched", async () => {
    const { record } = await ask("count the tickets");
    expect(record).toMatchObject({ kind: "direct", queries: 1, datasets: ["tickets"] });
    // The in-memory source has no table, so the query found no data: an honest decline, not an answer.
    expect(record.outcome).toBe("declined");
    expect(record.outcomeReason).toBe("no-data");
  });

  it("links a spoken question to its transcript: distance 0 when sent as heard, more when edited", async () => {
    const heard = await speak("en");
    expect(heard.transcriptId).toBe(heard.clip);
    const asIs = await ask("how many tickets are open", { speech: [heard.transcriptId] });
    expect(asIs.record).toMatchObject({ input: "spoken", transcriptId: heard.transcriptId, transcript: "how many tickets are open", transcriptEditDistance: 0, questionLanguage: "en" });
    const again = await speak("fr");
    const edited = await ask("combien de tickets ouverts", { speech: [again.transcriptId] });
    expect(edited.record).toMatchObject({ input: "spoken", transcript: "combien de tickets", question: "combien de tickets ouverts", transcriptEditDistance: 1, questionLanguage: "fr", replyLanguage: "fr" });
    // The transcript record carries what was heard, and no audio unless keepAudio is on.
    const t = lines(state).find((l): l is TranscriptRecord => l.type === "transcript" && l.transcriptId === heard.transcriptId)!;
    expect(t).toMatchObject({ user: "ana", model: DEFAULT_SPEECH_MODEL, languageRequested: "en", seconds: 2, usd: 0.0002, transcript: "how many tickets are open", audio: null });
    // Someone else's transcript id links nothing.
    const bens = await speak("en", "ben");
    expect((await ask("how many tickets are open", { speech: [bens.transcriptId] })).record).toMatchObject({ input: "spoken", transcript: null });
  });

  it("takes events from a signed-in user on their own turns", async () => {
    const { turnId } = await ask("what is on this board?");
    expect((await post({ type: "feedback", turnId, rating: "up" })).status).toBe(401);
    expect((await post({ type: "feedback", turnId, rating: "up" }, "ben")).status).toBe(403);
    expect((await post({ type: "feedback", turnId: "nope", rating: "up" }, "ana")).status).toBe(404);
    expect((await post({ type: "feedback", turnId, rating: "down", reason: "too-slow" }, "ana")).status).toBe(202);
    // Too large: refused, or the connection dropped before it was read (as every capped body is).
    expect([413, "closed"]).toContain(await fetch(`${base}/_telemetry`, { method: "POST", headers: { "x-user": "ana" }, body: "x".repeat(9000) }).then((r) => r.status, () => "closed"));
    expect(events(state).at(-1)).toMatchObject({ event: "feedback", turnId, rating: "down", reason: "too-slow", user: "ana" });
  });

  it("records an answer the reader left before it finished", async () => {
    const port = (server.address() as { port: number }).port;
    const turnId = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: `/api/${host.name}/tel-board/chat`, headers: { "x-user": "ana", "content-type": "application/json" } }, (res) => {
        const id = String(res.headers["x-lenspack-turn"]);
        // The headers are in; the model has not said a word yet. Leave.
        req.destroy();
        resolve(id);
      });
      req.on("error", () => {});
      req.end(JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "a slow one" }] }] }));
      setTimeout(() => reject(new Error("no response")), 5000);
    });
    for (let i = 0; i < 100 && !turns(state).some((t) => t.turnId === turnId); i++) await new Promise((r) => setTimeout(r, 20));
    const record = turns(state).find((t) => t.turnId === turnId)!;
    expect(record).toMatchObject({ abandoned: true, firstTokenMs: expect.any(Number) });
    expect(record.abandonedMs).toBeLessThan(600);
  });

  it("keeps no recording while keepAudio is off, and keeps and links one when it is on", async () => {
    await speak("en");
    expect(existsSync(join(state, "audio"))).toBe(false);
    keep = { ...keep, keepAudio: true };
    const heard = await speak("en");
    const t = lines(state).find((l): l is TranscriptRecord => l.type === "transcript" && l.transcriptId === heard.transcriptId)!;
    expect(t.audio).toEqual({ stored: true, bytes: 8, format: "webm" });
    const month = new Date().toISOString().slice(0, 7);
    expect(readFileSync(join(state, "audio", month, `${heard.transcriptId}.webm`))).toEqual(Buffer.from([26, 69, 223, 163, 1, 2, 3, 4]));
  });

  it("refuses to record until the consent notice is acknowledged, while recordings are kept", async () => {
    keep = { ...keep, keepAudio: true, consentNotice: "Recordings are kept for 30 days to check transcription." };
    const refused = await fetch(`${base}/_stt?language=en`, { method: "POST", headers: { "content-type": "audio/webm", "x-user": "cleo" }, body: new Uint8Array([1, 2, 3]) });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "consent_required", notice: keep.consentNotice });
    expect(await (await fetch(`${base}/_stt/consent`, { headers: { "x-user": "cleo" } })).json()).toEqual({ notice: keep.consentNotice });
    expect(await (await fetch(`${base}/_stt/consent`, { method: "POST", headers: { "x-user": "cleo" } })).json()).toEqual({ notice: null });
    expect((await speak("en", "cleo")).text).toBe("how many tickets are open");
    // A changed notice is asked again.
    keep = { ...keep, consentNotice: "A new notice." };
    expect((await fetch(`${base}/_stt?language=en`, { method: "POST", headers: { "content-type": "audio/webm", "x-user": "cleo" }, body: new Uint8Array([1, 2, 3]) })).status).toBe(403);
    keep = { ...keep, keepAudio: false };
    // With recordings not kept, no notice gates the mic.
    expect((await fetch(`${base}/_stt?language=en`, { method: "POST", headers: { "content-type": "audio/webm", "x-user": "cleo" }, body: new Uint8Array([1, 2, 3]) })).status).toBe(200);
  });
});

describe("kept recordings", () => {
  it("deletes by age and, oldest first, by size", async () => {
    const dir = tmp();
    let now = new Date("2026-11-01T00:00:00Z");
    let s: AudioSettings = { keepAudio: true, audioRetentionDays: 10, maxStoredMb: 1, consentNotice: null };
    const a = fileAudioStore({ dir, settings: () => s, now: () => now });
    const ids = async () => (await a.list()).map((e) => e.id);
    const half = new Uint8Array(400 * 1024);
    await a.keep("old", "ana", half, "webm");
    now = new Date("2026-11-08T00:00:00Z");
    await a.keep("mid", "ana", half, "ogg");
    expect(await ids()).toEqual(["old", "mid"]);
    // A third clip goes over 1 MB: the oldest goes.
    now = new Date("2026-11-10T00:00:00Z");
    await a.keep("new", "ben", half, "mp3");
    expect(await ids()).toEqual(["mid", "new"]);
    expect(existsSync(join(dir, "audio", "2026-11", "old.webm"))).toBe(false);
    // Later, "mid" is past the 10 days and "new" is not.
    now = new Date("2026-11-19T12:00:00Z");
    await a.sweep();
    expect(await ids()).toEqual(["new"]);
    // Turned off: nothing new is written, and what is kept stays until deleted.
    s = { ...s, keepAudio: false };
    expect(await a.keep("off", "ana", half, "webm")).toBe(null);
    expect(await ids()).toEqual(["new"]);
    expect(await a.deleteUser("ben")).toBe(1);
    expect(await a.stats()).toEqual({ files: 0, bytes: 0, oldest: null });
  });

  it("builds a benchmark manifest from what users sent, flagging what is unclear", () => {
    const clips = ["a", "b", "c", "d", "e"].map((id) => ({ id, user: "ana", at: "2026-11-01T00:00:00Z", file: `2026-11/${id}.webm`, bytes: 1, format: "webm" }));
    const facts: Record<string, Parameters<Parameters<typeof audioManifest>[1]>[0] extends string ? ReturnType<Parameters<typeof audioManifest>[1]> : never> = {
      a: { transcript: "how many visits", sent: "how many visits", lang: "en", seconds: 2, edits: 0 },
      b: { transcript: "combien de visite", sent: "combien de visites", lang: "fr", seconds: 2, edits: 1 },
      c: { transcript: "how many visits", sent: "show me a completely different chart of regions", lang: "en", seconds: 2, edits: 8 },
      d: { transcript: "quantos casos", sent: null, lang: "pt", seconds: 1, edits: null },
      e: { transcript: null, sent: null, lang: "en", seconds: 1, edits: null },
    };
    const { lines: ok, flagged } = audioManifest(clips, (id) => facts[id] ?? null, (u) => `spk-${u.length}`);
    expect(ok).toEqual([
      { id: "field/a", set: "field-en", lang: "en", speaker: "spk-3", audio: "2026-11/a.webm", ref: "how many visits", seconds: 2, refSource: "accepted" },
      { id: "field/b", set: "field-fr", lang: "fr", speaker: "spk-3", audio: "2026-11/b.webm", ref: "combien de visites", seconds: 2, refSource: "edited" },
    ]);
    expect(flagged.map((f) => [f.id, f.flag])).toEqual([
      ["field/c", "edited-unclear"],
      ["field/d", "not-sent"],
      ["field/e", "no-text"],
    ]);
  });
});

describe("the admin routes", () => {
  it("serve telemetry and recordings to admins only, auditing each play and deletion", async () => {
    const dir = tmp();
    const settings = adminSettings(dir, { speech: { keepAudio: true }, context: { "*": { country: "Z" } } }, { LENSPACK_STT_API_KEY: "test-not-a-key" });
    const audited: { action: string; outcome: string; detail?: string }[] = [];
    const audit = { audit: (e: { action: string; outcome: string; detail?: string }) => audited.push(e), file: "", retentionDays: 90, months: () => [], read: () => [], since: () => [] };
    const routes = adminRoutes({ prefix: "/_x", settings, providers: [], audit, log: () => {}, adminName: "admin", writable: () => true });
    await settings.audio.keep("clip-1", "ana", new Uint8Array([1, 2, 3]), "ogg");
    await settings.telemetry.transcribed({ id: "clip-1", who: { user: "ana", roles: [] }, pack: "p", model: "stt", languageRequested: "en", languageDetected: "en", seconds: 1, usd: null, ms: 1, retried: false, text: "hello" });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://x");
      const who = { user: String(req.headers["x-user"]), roles: req.headers["x-admin"] ? ["admin"] : [], edit: true, usage: false };
      await routes(req, res, url, who);
      if (!res.headersSent) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}/_x`;
    const as = (adminUser: boolean, init: RequestInit = {}) => ({ ...init, headers: { "x-user": adminUser ? "root" : "ana", ...(adminUser ? { "x-admin": "1" } : {}) } });
    try {
      expect((await fetch(`${at}/telemetry`, as(false))).status).toBe(403);
      expect((await fetch(`${at}/telemetry/checklist`, as(false))).status).toBe(403);
      const checklist = await (await fetch(`${at}/telemetry/checklist`, as(true))).json();
      expect(checklist.telemetry).toEqual({ on: true, changed: null });
      expect(checklist.settings).toEqual({ retentionDays: 90, audioRetentionDays: 30, consentNotice: null });
      const items = checklist.groups.flatMap((g: { items: { id: string; status: string }[] }) => g.items);
      expect(items.find((i: { id: string }) => i.id === "voice-audio")).toMatchObject({ status: "recording", count7d: 1 });
      expect(items.find((i: { id: string }) => i.id === "users-by-country")).toMatchObject({ status: "enabled-no-data" });
      expect(items.find((i: { id: string }) => i.id === "users-return")).toMatchObject({ status: "needs-config" });
      expect((await fetch(`${at}/audio/clip-1`, as(false))).status).toBe(403);
      const page = await (await fetch(`${at}/telemetry?from=2000-01-01&type=transcript&limit=1`, as(true))).json();
      // This admin lacks the usage right: each user name is a stable stand-in.
      expect(page).toMatchObject({ enabled: true, usernames: false, total: 1, offset: 0, limit: 1, next: null, records: [{ type: "transcript", user: expect.stringMatching(/^u_[0-9a-f]{12}$/) }] });
      // Transcript text is off by default: left out of the record.
      expect(page.records[0]).not.toHaveProperty("transcript");
      expect(page.items).toContain("voice-audio");
      expect((await fetch(`${at}/telemetry?from=yesterday`, as(true))).status).toBe(400);
      const played = await fetch(`${at}/audio/clip-1`, as(true));
      expect(played.status).toBe(200);
      expect(played.headers.get("content-type")).toBe("audio/ogg");
      expect(Buffer.from(await played.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
      const exported = await (await fetch(`${at}/audio/export`, as(true, { method: "POST" }))).json();
      // Question text is off here, so the clip has no reference: set aside, not scored.
      expect(exported).toMatchObject({ clips: 0, flagged: 1 });
      expect(readFileSync(exported.flaggedFile, "utf8")).toContain('"flag":"no-text"');
      expect((await (await fetch(`${at}/audio?user=ana`, as(true, { method: "DELETE" }))).json()).deleted).toBe(1);
      expect((await fetch(`${at}/audio/clip-1`, as(true))).status).toBe(404);
      expect(audited.map((e) => `${e.action} ${e.outcome}`)).toEqual(["GET /_x/telemetry denied", "GET /_x/telemetry/checklist denied", "GET /_x/audio/clip-1 denied", "audio play ok", "audio export ok", "audio delete user ok", "audio play denied"]);
      // The switchboard: admins only; a privacy-sensitive item turns on only when confirmed; every change audited and live.
      const put = (body: unknown, adminUser = true) => fetch(`${at}/settings/telemetry`, as(adminUser, { method: "PUT", body: JSON.stringify(body) }));
      type Item = { id: string; status: string; offBy: string | null; switch: { on: boolean; changed: { by: string } | null } };
      const itemOf = (c: { groups: { items: Item[] }[] }, id: string) => c.groups.flatMap((g) => g.items).find((i) => i.id === id)!;
      expect((await put({ "items.question-text": true, confirm: true }, false)).status).toBe(403);
      const unconfirmed = await put({ "items.transcript-text": true });
      expect(unconfirmed.status).toBe(409);
      expect(await unconfirmed.json()).toMatchObject({ confirm: { key: "items.transcript-text", sensitive: expect.stringMatching(/word for word/) } });
      const confirmed = await (await put({ "items.transcript-text": true, confirm: true })).json();
      expect(itemOf(confirmed, "transcript-text").switch).toMatchObject({ on: true, changed: { by: "root" } });
      // Applied at once: the next transcript keeps its words.
      await settings.telemetry.transcribed({ id: "clip-2", who: { user: "ana", roles: [] }, pack: "p", model: "stt", languageRequested: "en", languageDetected: "en", seconds: 1, usd: null, ms: 1, retried: false, text: "hello again" });
      expect(await settings.telemetryLog.find({ from: new Date(0), type: "transcript" })).toEqual([expect.objectContaining({ transcriptId: "clip-2", transcript: "hello again" }), expect.not.objectContaining({ transcript: expect.anything() })]);
      // Off needs no confirming, and says since when and by whom.
      const off = await (await put({ "items.speed-p95": false })).json();
      expect(itemOf(off, "speed-p95")).toMatchObject({ status: "off", offBy: "root" });
      // A section off stops kept recordings; null puts it back.
      await put({ "groups.voice": false });
      expect(settings.audioSettings().keepAudio).toBe(false);
      await put({ "groups.voice": null });
      expect(settings.audioSettings().keepAudio).toBe(true);
      // Telemetry as a whole is the telemetry feature switch.
      const allOff = await (await put({ telemetry: false })).json();
      expect(allOff.telemetry).toMatchObject({ on: false, changed: { by: "root" } });
      expect(settings.features.on("telemetry")).toBe(false);
      await put({ telemetry: true });
      // What cannot be switched, and what is not a switch.
      expect((await put({ "items.speed-time-saved": true })).status).toBe(409);
      expect((await put({ "items.nope": true })).status).toBe(400);
      expect((await put({ "items.speed-p95": "yes" })).status).toBe(400);
      expect((await put({ retentionDays: 30 })).status).toBe(200);
      expect(settings.switches.retentionDays()).toBe(30);
      const changes = audited.filter((e) => e.action === "settings telemetry");
      expect(changes.map((e) => e.outcome)).toEqual(["denied", "ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
      expect(changes[1]!.detail).toContain('"confirmed":true');
      // Kept recordings are the voice-audio item now, not a speech setting.
      expect((await fetch(`${at}/settings/speech`, as(true, { method: "PUT", body: JSON.stringify({ keepAudio: false }) }))).status).toBe(409);
      const speech = await (await fetch(`${at}/settings/speech`, as(true, { method: "PUT", body: JSON.stringify({ audioRetentionDays: 7, consentNotice: "Kept a week." }) }))).json();
      expect(speech).toMatchObject({ keepAudio: true, audioRetentionDays: 7, maxStoredMb: 1000, consentNotice: "Kept a week." });
      expect((await fetch(`${at}/settings/speech`, { method: "PUT", headers: { "x-user": "root", "x-admin": "1" }, body: JSON.stringify({ maxStoredMb: 0 }) })).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
