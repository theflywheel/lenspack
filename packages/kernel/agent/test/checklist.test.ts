// The admin console's telemetry checklist: each measure's status from the deployment's switches, its context, its
// features and the last 7 days of records.
import { describe, expect, it } from "vitest";

import { type ChecklistInput, type ChecklistItem, type TelemetryLine, telemetryChecklist } from "../src";

const now = new Date("2026-11-20T12:00:00Z");
const turn = (o: Record<string, unknown> = {}) => ({ type: "turn", at: "2026-11-19T10:00:00.000Z", user: "ana", roles: ["Gamma"], kind: "direct", outcome: "answered", input: "typed", transcriptEditDistance: null, reAskAfterVoice: null, rephraseOf: null, reuse: null, abandoned: false, device: "mobile", viewport: "narrow", network: "3g", ...o }) as unknown as TelemetryLine;
const input = (o: Partial<ChecklistInput> = {}): ChecklistInput => ({
  now,
  switches: { telemetry: true, questionText: true, keepAudio: false, audioRetentionDays: 30, retentionDays: 90, consentNotice: false },
  features: { telemetry: true, voice: true },
  context: { "*": { country: "A", campaign: "Round 1", campaignType: "door-to-door" } },
  lines: [turn()],
  audioSaved: [],
  supersetLogs: null,
  ...o,
});
const item = (i: ChecklistInput, id: string): ChecklistItem => {
  const found = telemetryChecklist(i).groups.flatMap((g) => g.items).find((x) => x.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
};

describe("the telemetry checklist", () => {
  it("follows the pilot's metric groups, every item with a decision, fields and a status", () => {
    const c = telemetryChecklist(input());
    expect(c.generatedAt).toBe(now.toISOString());
    expect(c.groups.map((g) => g.title)).toEqual(["Users", "Volume and cost", "Quality", "What people ask", "Speed", "Voice and language", "Conversation", "Trust and reuse", "Device and network"]);
    for (const x of c.groups.flatMap((g) => g.items)) expect(x.decision && x.label && x.status).toBeTruthy();
  });

  it("says recording, with the count and the last time, when records show it", () => {
    const i = input({ lines: [turn({ at: "2026-11-18T09:00:00.000Z" }), turn({ at: "2026-11-19T10:00:00.000Z" })] });
    expect(item(i, "users-active")).toMatchObject({ status: "recording", howToEnable: null, count7d: 2, lastSeen: "2026-11-19T10:00:00.000Z" });
  });

  it("says enabled-no-data when it is on and nothing has come in", () => {
    expect(item(input({ lines: [] }), "users-active")).toMatchObject({ status: "enabled-no-data", count7d: 0, lastSeen: null });
    expect(item(input(), "quality-thumbs-down")).toMatchObject({ status: "enabled-no-data" });
  });

  it("says off when its switch is off, and how to turn it on", () => {
    const off = input({ switches: { ...input().switches, telemetry: false } });
    expect(item(off, "users-active")).toMatchObject({ status: "off", howToEnable: expect.stringMatching(/telemetry switch/) });
    expect(item(input({ features: { telemetry: true, voice: false } }), "voice-share")).toMatchObject({ status: "off", howToEnable: expect.stringMatching(/voice/) });
    expect(item(input(), "voice-audio")).toMatchObject({ status: "off", howToEnable: expect.stringMatching(/keepAudio/), privacy: ["stores audio"] });
    const kept = input({ switches: { ...input().switches, keepAudio: true } });
    expect(item(kept, "voice-audio").status).toBe("enabled-no-data");
    expect(item({ ...kept, audioSaved: ["2026-11-19T08:00:00.000Z"] }, "voice-audio")).toMatchObject({ status: "recording", count7d: 1 });
  });

  it("says needs-config for a context field nobody mapped, and for role names an older plugin does not send", () => {
    expect(item(input({ context: {} }), "users-by-country")).toMatchObject({ status: "needs-config", howToEnable: expect.stringMatching(/country/) });
    expect(item(input({ context: { b1: { country: "A" } } }), "users-return")).toMatchObject({ status: "needs-config", howToEnable: expect.stringMatching(/campaign/) });
    expect(item(input({ context: { b1: { country: "A" } } }), "users-by-country").status).toBe("recording");
    expect(item(input({ lines: [turn({ roles: [] })] }), "users-by-role")).toMatchObject({ status: "needs-config", howToEnable: expect.stringMatching(/plugin/) });
    expect(item(input(), "users-by-role").status).toBe("recording");
  });

  it("says needs-config for Superset's action log outside Superset or when it cannot be read", () => {
    expect(item(input(), "trust-superset-actions").status).toBe("needs-config");
    expect(item(input({ supersetLogs: { available: false, reason: "403 from the log API", count: 0, lastSeen: null } }), "trust-superset-actions")).toMatchObject({ status: "needs-config", howToEnable: "403 from the log API" });
    expect(item(input({ supersetLogs: { available: true, count: 3, lastSeen: "2026-11-19T00:00:00" } }), "trust-superset-actions")).toMatchObject({ status: "recording", count7d: 3 });
  });

  it("marks what other features own, off until that feature is here and on", () => {
    expect(item(input(), "reuse-hit-rate")).toMatchObject({ status: "off", feature: "reuse", howToEnable: expect.stringMatching(/does not have/) });
    expect(item(input({ features: { telemetry: true, review: false } }), "review-runs")).toMatchObject({ status: "off", howToEnable: "Turn on the review switch." });
    expect(item(input({ features: { telemetry: true, reuse: true }, lines: [turn({ reuse: "exact" })] }), "reuse-hit-rate").status).toBe("recording");
  });

  it("says not-telemetry for what records cannot measure, and why", () => {
    expect(item(input(), "speed-time-saved")).toMatchObject({ status: "not-telemetry", howToEnable: expect.stringMatching(/baseline/) });
    expect(item(input(), "voice-wer-true")).toMatchObject({ status: "not-telemetry", howToEnable: expect.stringMatching(/hand-made transcripts/) });
  });

  it("says what each item means for privacy, following the question text setting", () => {
    expect(item(input(), "quality-unanswered").privacy).toEqual(["stores question text"]);
    expect(item(input({ switches: { ...input().switches, questionText: false } }), "quality-unanswered").privacy).toEqual(["question text kept only as a keyed hash"]);
    expect(item(input(), "users-active").privacy).toEqual(["usernames visible to admins with the usage right"]);
  });
});
