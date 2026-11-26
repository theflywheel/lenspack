// The Telemetry tab's data: what's recorded (each field group's switch and status from the deployment's switches,
// its context, its features and the last 7 days of records) and what it tells you (each metric worked out from the
// same records, or why it can't be).
import { describe, expect, it } from "vitest";

import { type ChecklistInput, type FieldRow, type MetricRow, type TelemetryLine, fieldDefaults, telemetryChecklist } from "../src";

const now = new Date("2026-11-20T12:00:00Z");
const turn = (o: Record<string, unknown> = {}) => ({ type: "turn", v: 2, turnId: "t", sessionId: "s1", at: "2026-11-19T10:00:00.000Z", pack: "p", board: "b", tenant: null, datasets: [], user: "ana", roles: ["Gamma"], kind: "direct", outcome: "answered", outcomeReason: null, input: "typed", questionHash: "h", questionWords: 4, questionLanguage: "en", totalMs: 900, costUsd: 0.004, ...o }) as unknown as TelemetryLine;
const input = (o: Partial<ChecklistInput> = {}): ChecklistInput => ({
  now,
  switches: { telemetry: true, fields: fieldDefaults() },
  settings: { retentionDays: 90, audioRetentionDays: 30, consentNotice: null },
  features: { telemetry: true, voice: true, cache: true, clarify: true, personalDashboards: true, "review.daily": false },
  context: { "*": { country: "A", campaign: "Round 1", campaignType: "door-to-door" } },
  lines: [turn()],
  audioSaved: [],
  supersetLogs: null,
  ...o,
});
const withField = (id: string, on: boolean, o: Partial<ChecklistInput> = {}) => input({ switches: { telemetry: true, fields: { ...fieldDefaults(), [id]: on } }, ...o });
const row = (i: ChecklistInput, id: string): FieldRow => {
  const found = telemetryChecklist(i).categories.flatMap((c) => c.rows).find((x) => x.id === id);
  if (!found) throw new Error(`no field ${id}`);
  return found;
};
const metric = (i: ChecklistInput, id: string): MetricRow => {
  const found = telemetryChecklist(i).metrics.flatMap((g) => g.metrics).find((x) => x.id === id);
  if (!found) throw new Error(`no metric ${id}`);
  return found;
};

describe("what's recorded", () => {
  it("lists the field groups by plain category, each with what it holds, its record fields, a status and a switch", () => {
    const c = telemetryChecklist(input());
    expect(c.generatedAt).toBe(now.toISOString());
    expect(c.categories.map((g) => g.title)).toEqual(["Who and where", "What was asked", "What happened", "Cost and speed", "Feedback", "Voice", "Texts"]);
    for (const x of c.categories.flatMap((g) => g.rows)) {
      expect(x.label && x.about && x.status).toBeTruthy();
      expect(x.switch.editable || x.switch.reason).toBeTruthy();
    }
    expect(row(input(), "user")).toMatchObject({ fields: ["turn.user", "transcript.user", "event.user"], privacy: ["usernames visible to admins with the usage right"] });
    expect(row(input(), "feedback").fields).toEqual(["event.rating", "event.reason", "event.commentHash", "event:feedback"]);
    expect(c.note).toMatch(/stays until it ages out/);
  });

  it("names the metrics that read each field", () => {
    expect(row(input(), "user").usedBy.map((m) => m.id)).toEqual(["users-active", "users-by-role", "users-by-country", "users-return", "volume-per-user", "cost-per-user"]);
    expect(row(input(), "question-text").usedBy).toEqual([]);
  });

  it("counts the records that carry the field in the last 7 days, not a metric's value", () => {
    const i = input({ lines: [turn({ at: "2026-11-18T09:00:00.000Z" }), turn({ at: "2026-11-19T10:00:00.000Z", user: "ben" })] });
    expect(row(i, "user")).toMatchObject({ status: "recording", howToEnable: null, count7d: 2, lastSeen: "2026-11-19T10:00:00.000Z", switch: { key: "fields.user", on: true, editable: true } });
    // Written after the user name went off: the record has no user, so it does not count.
    const nameless = turn() as unknown as Record<string, unknown>;
    delete nameless.user;
    expect(row(input({ lines: [turn({ at: "2026-11-18T09:00:00.000Z" }), nameless as unknown as TelemetryLine] }), "user")).toMatchObject({ count7d: 1, lastSeen: "2026-11-18T09:00:00.000Z" });
    expect(row(input({ lines: [] }), "user")).toMatchObject({ status: "enabled-no-data", count7d: 0, lastSeen: null });
  });

  it("says off, since when and by whom, for its own switch and telemetry's", () => {
    const changed = { "fields.timing": { at: "2026-11-19T08:00:00.000Z", by: "root" }, telemetry: { at: "2026-11-19T11:00:00.000Z", by: "admin3" } };
    expect(row(withField("timing", false, { changed }), "timing")).toMatchObject({ status: "off", offSince: "2026-11-19T08:00:00.000Z", offBy: "root", switch: { on: false, editable: true } });
    const allOff = input({ switches: { telemetry: false, fields: fieldDefaults() }, changed });
    expect(row(allOff, "user")).toMatchObject({ status: "off", howToEnable: "Telemetry is off.", offBy: "admin3" });
    expect(telemetryChecklist(allOff).telemetry).toEqual({ on: false, changed: { at: "2026-11-19T11:00:00.000Z", by: "admin3" } });
  });

  it("starts the privacy-sensitive fields off, each with its note, and recordings with the consent notice", () => {
    const i = input({ settings: { retentionDays: 90, audioRetentionDays: 30, consentNotice: "Recordings are kept for a month." } });
    for (const id of ["question-text", "transcript-text", "voice-audio", "device-class", "device-network"]) expect(row(i, id)).toMatchObject({ status: "off", switch: { on: false, default: false, editable: true, sensitive: expect.any(String) } });
    expect(row(i, "voice-audio").switch.consent).toBe("Recordings are kept for a month.");
    expect(row(i, "question-text").switch.consent).toBe(null);
    const kept = withField("voice-audio", true);
    expect(row(kept, "voice-audio").status).toBe("enabled-no-data");
    expect(row({ ...kept, audioSaved: ["2026-11-19T08:00:00.000Z"] }, "voice-audio")).toMatchObject({ status: "recording", count7d: 1 });
  });

  it("locks a switch with the reason on the row and where to fix it", () => {
    expect(row(input({ features: { ...input().features, cache: false } }), "reuse")).toMatchObject({ status: "off", switch: { editable: false, lock: { kind: "feature", feature: "cache" }, reason: expect.stringMatching(/saved answers switch, which is off/), fix: { kind: "settings", feature: "cache" } } });
    expect(row(input({ features: { ...input().features, voice: false } }), "input")).toMatchObject({ switch: { editable: false, reason: expect.stringMatching(/^Needs voice/), fix: { kind: "settings", feature: "voice" } } });
    expect(row(input({ context: {} }), "context")).toMatchObject({ status: "needs-config", switch: { editable: false, reason: expect.stringMatching(/^Needs configuration: map dashboards/), fix: { kind: "config", key: "context" } } });
    expect(row(input(), "daily-review")).toMatchObject({ status: "off", switch: { key: null, editable: false, reason: expect.stringMatching(/^Owned by the daily review switch/), fix: { kind: "settings", feature: "review.daily" } } });
    const reviewing = input({ features: { ...input().features, "review.daily": true }, owned: { "review-runs": { count: 4, lastSeen: "2026-11-19T06:00:00.000Z" }, "review-proposals": { count: 2, lastSeen: null } } });
    expect(row(reviewing, "daily-review")).toMatchObject({ status: "recording", count7d: 6, switch: { on: true, editable: false } });
    expect(row(input(), "superset-actions")).toMatchObject({ status: "needs-config", switch: { editable: false, lock: { kind: "superset" } } });
    expect(row(input({ supersetLogs: { available: false, reason: "403 from the log API", count: 0, lastSeen: null } }), "superset-actions")).toMatchObject({ status: "needs-config", howToEnable: "403 from the log API", switch: { editable: true } });
    // Role names an older plugin does not sign: a warning, not a lock.
    expect(row(input({ lines: [turn({ roles: [] })] }), "roles")).toMatchObject({ status: "needs-config", howToEnable: expect.stringMatching(/plugin/), switch: { editable: true } });
  });

  it("works out each category's switch from the switches inside it", () => {
    const cats = (i: ChecklistInput) => Object.fromEntries(telemetryChecklist(i).categories.map((c) => [c.id, { state: c.state, next: c.next, note: c.note }]));
    expect(cats(input())).toMatchObject({ who: { state: "on", next: false, note: "sensitive-apart" }, asked: { state: "on", next: false, note: null }, texts: { state: "off", next: null, note: "sensitive-only" } });
    expect(cats(withField("timing", false))["cost-speed"]).toEqual({ state: "mixed", next: true, note: null });
    expect(cats(withField("question-text", true)).texts).toEqual({ state: "mixed", next: false, note: "sensitive-only" });
    // With voice off every voice switch is locked: the category shows them as they stand and does nothing.
    expect(cats(input({ features: { ...input().features, voice: false } })).voice).toMatchObject({ state: "on", next: null });
  });
});

describe("what it tells you", () => {
  const week = [
    turn({ turnId: "a", user: "ana", roles: ["Gamma"], at: "2026-11-20T09:00:00.000Z", costUsd: 0.004, outcome: "answered", sessionId: "s1", questionHash: "h1" }),
    turn({ turnId: "b", user: "ana", roles: ["Gamma"], at: "2026-11-18T09:00:00.000Z", costUsd: 0.006, outcome: "declined", outcomeReason: "no-data", sessionId: "s1", questionHash: "h2", kind: "derived", totalMs: 4000 }),
    turn({ turnId: "c", user: "ben", roles: ["Alpha"], at: "2026-11-17T09:00:00.000Z", costUsd: 0.002, outcome: "answered", sessionId: "s2", questionHash: "h1", input: "spoken", transcriptEditDistance: 1 }),
    turn({ turnId: "d", user: "cy", roles: ["Gamma", "Alpha"], at: "2026-11-16T09:00:00.000Z", costUsd: 0.004, outcome: "answered", sessionId: "s3", questionHash: "h1" }),
    { type: "event", v: 2, event: "feedback", at: "2026-11-19T09:00:00.000Z", turnId: "b", pack: "p", board: "b", data: null, rating: "down", reason: "wrong-number" } as unknown as TelemetryLine,
    { type: "event", v: 2, event: "feedback", at: "2026-11-19T09:00:00.000Z", turnId: "a", pack: "p", board: "b", data: null, rating: "up", reason: null } as unknown as TelemetryLine,
  ];

  it("works out each metric live from the last 7 days of records", () => {
    const i = input({ lines: week });
    expect(metric(i, "users-active")).toMatchObject({ status: "ready", reading: { value: { kind: "count", value: 3, unit: "users" }, parts: [{ key: "last24h", figure: { value: 1 } }, { key: "dailyAvg" }] } });
    expect(metric(i, "cost-per-question").reading!.value).toEqual({ kind: "usd", value: 0.004 });
    expect(metric(i, "cost-per-user").reading!.value.value).toBeCloseTo(0.016 / 3);
    expect(metric(i, "quality-answer-rate").reading!.value).toEqual({ kind: "percent", value: 0.75 });
    expect(metric(i, "volume-per-user").reading!.value.value).toBeCloseTo(4 / 3);
    expect(metric(i, "users-by-role").reading).toMatchObject({ value: { value: 2 }, parts: [{ label: "Alpha", figure: { value: 2 } }, { label: "Gamma", figure: { value: 2 } }] });
    expect(metric(i, "quality-thumbs-down").reading).toMatchObject({ value: { value: 1 }, parts: [{ key: "ofRatings", figure: { value: 0.5 } }, { label: "wrong-number", figure: { value: 1 } }] });
    expect(metric(i, "conv-follow-ups").reading!.value.value).toBeCloseTo(4 / 3);
    expect(metric(i, "asks-mix").reading!.parts).toEqual([{ label: "direct", figure: { kind: "percent", value: 0.75 } }, { label: "derived", figure: { kind: "percent", value: 0.25 } }]);
    expect(metric(i, "speed-p95").reading!.value).toEqual({ kind: "ms", value: 4000 });
    expect(metric(i, "voice-share").reading!.value).toEqual({ kind: "percent", value: 0.25 });
    expect(metric(i, "quality-unanswered").reading).toMatchObject({ value: { value: 1 }, parts: [{ key: "distinct", figure: { value: 1 } }, { key: "topRepeat" }] });
    // Each lists the fields it uses, and whether each is recording.
    expect(metric(i, "cost-per-user").needs).toEqual([{ id: "user", label: "User name", on: true }, { id: "cost", label: "Cost, tokens and models", on: true }]);
  });

  it("never shows a name or the words of a question", () => {
    const words = turn({ question: "How many visits in the north?" });
    const text = JSON.stringify(telemetryChecklist(input({ lines: [...week, words] })).metrics);
    for (const name of ["ana", "ben", "cy", "How many visits"]) expect(text).not.toContain(`"${name}`);
  });

  it("says no data when the fields are on and nothing came in", () => {
    expect(metric(input({ lines: [] }), "users-active")).toMatchObject({ status: "no-data", reading: { value: { value: 0 } } });
  });

  it("says unavailable, and what would fix it, when a field it needs is off, locked or needs configuring", () => {
    expect(metric(withField("user", false), "cost-per-user")).toMatchObject({ status: "unavailable", reading: null, unavailable: { kind: "fields-off", text: "Unavailable: needs User name (switched off).", fields: [{ id: "user" }], fix: { kind: "field", id: "user" } } });
    expect(metric(input({ features: { ...input().features, cache: false } }), "reuse-saved")).toMatchObject({ unavailable: { kind: "locked", lock: { kind: "feature", feature: "cache" }, fix: { kind: "settings", feature: "cache" } } });
    expect(metric(input({ context: { b1: { campaign: "Round 1" } } }), "users-by-country")).toMatchObject({ unavailable: { kind: "needs-config", context: ["country"], text: expect.stringMatching(/to a country/), fix: { kind: "config" } } });
    expect(metric(input(), "review-runs")).toMatchObject({ unavailable: { kind: "locked", fix: { kind: "settings", feature: "review.daily" } } });
    expect(metric(input(), "speed-time-saved")).toMatchObject({ unavailable: { kind: "not-telemetry", text: expect.stringMatching(/baseline/) } });
    expect(metric(input({ switches: { telemetry: false, fields: fieldDefaults() } }), "users-active")).toMatchObject({ unavailable: { kind: "telemetry-off" } });
    // Kept by a feature, not by telemetry: telemetry off does not hide it.
    expect(metric(input({ switches: { telemetry: false, fields: fieldDefaults() }, features: { ...input().features, "review.daily": true }, owned: { "review-runs": { count: 3, lastSeen: null } } }), "review-runs")).toMatchObject({ status: "ready", reading: { value: { value: 3 } } });
  });

  it("reads Superset's action log only inside Superset", () => {
    expect(metric(input(), "trust-superset-actions")).toMatchObject({ unavailable: { kind: "locked", lock: { kind: "superset" } } });
    expect(metric(input({ supersetLogs: { available: true, count: 3, lastSeen: "2026-11-19T00:00:00" } }), "trust-superset-actions")).toMatchObject({ status: "ready", reading: { value: { value: 3 } } });
  });
});
