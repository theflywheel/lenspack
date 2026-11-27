import { mkdtempSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type FieldNotice, fieldDefaults, fieldNotices } from "@lenspack/agent";
import { principalOf } from "@lenspack/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLUMNS, TELEMETRY_BOARD, keyFields, usageBoard } from "../src";

// The Telemetry tab's "What it tells you": a board over the usage pack, read from the telemetry records. Made-up
// records only: four questions from three people in the last few days, two ratings and one transcription.

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const turn = (o: Record<string, unknown>) => ({ type: "turn", v: 2, sessionId: "s1", pack: "shop", board: "sales", tenant: null, datasets: [], user: "ana", roles: ["Gamma"], kind: "direct", outcome: "answered", outcomeReason: null, input: "typed", questionHash: "h1", questionWords: 4, questionLanguage: "en", totalMs: 900, costUsd: 0.004, ...o });
const LINES = [
  turn({ turnId: "a", at: hoursAgo(3), user: "ana", roles: ["Gamma"], costUsd: 0.004, sessionId: "s1", questionHash: "h1" }),
  turn({ turnId: "b", at: hoursAgo(50), user: "ana", roles: ["Gamma"], costUsd: 0.006, outcome: "declined", outcomeReason: "no-data", sessionId: "s1", questionHash: "h2", kind: "derived", totalMs: 4000 }),
  turn({ turnId: "c", at: hoursAgo(74), user: "ben", roles: ["Alpha"], costUsd: 0.002, sessionId: "s2", questionHash: "h1", input: "spoken", transcriptEditDistance: 1, questionWords: 5 }),
  turn({ turnId: "d", at: hoursAgo(98), user: "cy", roles: ["Gamma", "Alpha"], costUsd: 0.004, sessionId: "s3", questionHash: "h1" }),
  { type: "event", v: 2, event: "feedback", at: hoursAgo(40), turnId: "b", pack: "shop", board: "sales", data: null, user: "ana", rating: "down", reason: "wrong-number" },
  { type: "event", v: 2, event: "feedback", at: hoursAgo(2), turnId: "a", pack: "shop", board: "sales", data: null, user: "ana", rating: "up", reason: null },
  { type: "transcript", v: 2, transcriptId: "x1", at: hoursAgo(74), pack: "shop", user: "ben", model: "speech-a", seconds: 3, usd: 0.0004, ms: 400, words: 5 },
];
const allOn = () => fieldNotices({ switches: { telemetry: true, fields: { ...fieldDefaults(), "question-text": true } }, features: { telemetry: true, voice: true, cache: true, clarify: true, personalDashboards: true }, context: { "*": { country: "Country A", campaignType: "door-to-door" } } });

describe("the telemetry board", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-usage-tl-"));
  let notices: Record<string, FieldNotice> = allOn();
  let usage: Awaited<ReturnType<typeof usageBoard>>;
  let server: ReturnType<typeof createServer>;
  let base = "";
  const data = async () => (await (await fetch(`${base}/${TELEMETRY_BOARD}/data`)).json()) as Record<string, { rows: { group: string; value: number | null }[]; error?: string; notice?: { text: string; action?: { label: string; href: string } } }>;
  const value = (d: Awaited<ReturnType<typeof data>>, id: string) => d[id]!.rows[0]?.value;

  beforeAll(async () => {
    writeFileSync(join(dir, `telemetry-${new Date().toISOString().slice(0, 7)}.jsonl`), `${LINES.map((l) => JSON.stringify(l)).join("\n")}\n`);
    usage = await usageBoard({ stateDir: dir, providers: () => [], notices: () => notices, refreshSeconds: 0 });
    const who = principalOf({ user: "root", edit: true, maintain: true, roles: ["admin"] });
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
      await usage!.handle(req, res, url.pathname.slice(1), url.search, who);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.close();
    await usage?.close();
  });

  it("works out each figure from the records with the engine: counts, sums and distinct users in the pack, rates as ratio steps", async () => {
    const d = await data();
    // Every widget draws, or says which field it needs (device and network start off).
    for (const [id, w] of Object.entries(d)) expect(w.error === undefined || w.notice !== undefined, `${id}: ${w.error}`).toBe(true);
    expect(Object.entries(d).filter(([, w]) => w.notice).map(([id]) => id).sort()).toEqual(["device_mix", "network_mix"]);
    expect(value(d, "users_7d")).toBe(3);
    expect(value(d, "users_24h")).toBe(1);
    expect(value(d, "questions_per_user")).toBeCloseTo(4 / 3);
    expect(value(d, "cost_per_question")).toBeCloseTo(0.004);
    expect(value(d, "cost_per_user")).toBeCloseTo(0.016 / 3);
    expect(value(d, "speech_cost")).toBeCloseTo(0.0004);
    expect(value(d, "answer_rate")).toBeCloseTo(0.75);
    expect(value(d, "thumbs_down_share")).toBeCloseTo(0.5);
    expect(value(d, "follow_ups")).toBeCloseTo(4 / 3);
    expect(value(d, "spoken_share")).toBeCloseTo(0.25);
    expect(value(d, "edited_share")).toBeCloseTo(1);
    expect(value(d, "word_error")).toBeCloseTo(1 / 5);
    expect(value(d, "distinct_questions")).toBe(2);
    expect(value(d, "unanswered_distinct")).toBe(1);
    expect(value(d, "reply_p95")).toBeGreaterThan(3);
    expect(d.users_role!.rows.map((r) => [r.group, r.value])).toEqual([["Alpha", 2], ["Gamma", 2]]);
    expect(d.kind_mix!.rows.map((r) => [r.group, r.value])).toEqual([["direct", 3], ["derived", 1]]);
    // The thumbs-up has no reason: it reads as a zero, not as a thumbs-down.
    expect(d.thumbs_reasons!.rows.map((r) => [r.group, r.value])).toEqual([["wrong-number", 1], ["(none)", 0]]);
  });

  it("says a widget needs a field that is off, with a link to its switch, instead of drawing a figure without it", async () => {
    notices = fieldNotices({ switches: { telemetry: true, fields: { ...fieldDefaults(), user: false } }, features: { telemetry: true, voice: true, cache: true, clarify: true, personalDashboards: false }, context: {} });
    try {
      const d = await data();
      expect(d.users_7d!.notice).toEqual({ text: "Needs the User name field, which is switched off.", action: { label: "Show the field", href: "#telemetry/field/user" } });
      expect(d.cost_per_user!.notice?.text).toMatch(/User name/);
      expect(d.answer_rate_campaign!.notice?.text).toMatch(/needs configuration: map dashboards, datasets or roles/);
      expect(d.dashboards!.notice).toMatchObject({ text: expect.stringMatching(/personal dashboards switch/), action: { label: "Open Settings", href: "#settings" } });
      expect(d.top_unanswered!.notice?.text).toMatch(/Question words/);
      // What does not need them still draws.
      expect(value(d, "questions_7d")).toBe(4);
      expect(d.questions_7d!.notice).toBeUndefined();
    } finally {
      notices = allOn();
    }
  });

  it("finds what reads each field: every column the records fill, and every widget that reads one", async () => {
    const k = keyFields(usage!.pack);
    expect(k.people).toEqual(["user"]);
    expect(k.thumbs_down).toEqual(["feedback"]);
    expect(k.role_turns).toEqual(["roles"]);
    expect(k.not_sent).toEqual(["voice-not-sent"]);
    expect(k.dashboard_actions).toEqual(["personal-dashboards"]);
    expect(k.turns).toEqual([]);
    // Each column named is one the tables have.
    const uses = await usage!.fieldUses();
    expect(uses.user!.map((w) => w.id)).toContain("users_7d");
    expect(uses["question-text"]!.map((w) => w.id)).toEqual(["top_unanswered", "top_questions_role"]);
    expect(Object.values(uses).flat().some((w) => w.id.startsWith("s_"))).toBe(false);
    expect(Object.keys(COLUMNS)).toEqual(["usage_turns", "usage_features", "usage_roles", "usage_events", "usage_transcripts"]);
  });

  it("names nobody and quotes no question to an admin without the usage right", async () => {
    const who = principalOf({ user: "viv", edit: true, maintain: true, roles: ["admin"], usage: false });
    const s2 = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      await usage!.handle(req, res, url.pathname.slice(1), url.search, who);
    });
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", r));
    try {
      const d = await (await fetch(`http://127.0.0.1:${(s2.address() as { port: number }).port}/${TELEMETRY_BOARD}/data`)).json();
      expect(JSON.stringify(d)).not.toMatch(/"(ana|ben|cy)"/);
      expect(d.top_unanswered.error).toMatch(/not available to you/);
    } finally {
      s2.close();
    }
  });
});
