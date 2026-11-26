// The Telemetry tab's checklist, which is also its switchboard: each item's switch and status from the
// deployment's switches, its context, its features and the last 7 days of records.
import { describe, expect, it } from "vitest";

import { type ChecklistInput, type ChecklistItem, type TelemetryLine, switchDefaults, telemetryChecklist } from "../src";

const now = new Date("2026-11-20T12:00:00Z");
const turn = (o: Record<string, unknown> = {}) => ({ type: "turn", v: 2, turnId: "t", at: "2026-11-19T10:00:00.000Z", pack: "p", board: "b", tenant: null, datasets: [], user: "ana", roles: ["Gamma"], kind: "direct", outcome: "answered", input: "typed", questionHash: "h", totalMs: 900, device: "mobile", viewport: "narrow", network: "3g", ...o }) as unknown as TelemetryLine;
const input = (o: Partial<ChecklistInput> = {}): ChecklistInput => ({
  now,
  switches: { telemetry: true, ...switchDefaults() },
  settings: { retentionDays: 90, audioRetentionDays: 30, consentNotice: null },
  features: { telemetry: true, voice: true, cache: true, clarify: true, "review.daily": false },
  context: { "*": { country: "A", campaign: "Round 1", campaignType: "door-to-door" } },
  lines: [turn()],
  audioSaved: [],
  supersetLogs: null,
  ...o,
});
const withSignal = (id: string, on: boolean, o: Partial<ChecklistInput> = {}) => input({ switches: { telemetry: true, groups: switchDefaults().groups, items: { ...switchDefaults().items, [id]: on } }, ...o });
const item = (i: ChecklistInput, id: string): ChecklistItem => {
  const found = telemetryChecklist(i).groups.flatMap((g) => g.items).find((x) => x.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
};

describe("the telemetry checklist", () => {
  it("follows the pilot's metric groups, every item with a decision, fields, a status and a switch", () => {
    const c = telemetryChecklist(input());
    expect(c.generatedAt).toBe(now.toISOString());
    expect(c.groups.map((g) => g.id)).toEqual(["users", "volume-cost", "quality", "asks", "speed", "voice", "conversation", "trust-reuse", "device-network"]);
    expect(c.groups.map((g) => g.title)).toEqual(["Users", "Volume and cost", "Quality", "What people ask", "Speed", "Voice and language", "Conversation", "Trust and reuse", "Device and network"]);
    for (const x of c.groups.flatMap((g) => g.items)) {
      expect(x.decision && x.label && x.status).toBeTruthy();
      expect(x.switch.editable || x.switch.reason).toBeTruthy();
    }
    expect(c.note).toMatch(/stays until it ages out/);
  });

  it("says recording, with the count and the last time, when records show it", () => {
    const i = input({ lines: [turn({ at: "2026-11-18T09:00:00.000Z" }), turn({ at: "2026-11-19T10:00:00.000Z" })] });
    expect(item(i, "users-active")).toMatchObject({ status: "recording", howToEnable: null, count7d: 2, lastSeen: "2026-11-19T10:00:00.000Z", switch: { key: "items.users-active", on: true, editable: true } });
  });

  it("says enabled-no-data when it is on and nothing has come in", () => {
    expect(item(input({ lines: [] }), "users-active")).toMatchObject({ status: "enabled-no-data", count7d: 0, lastSeen: null });
    expect(item(input(), "quality-thumbs-down")).toMatchObject({ status: "enabled-no-data" });
  });

  it("counts only records that carry the item's fields, so a switched-off item stops counting", () => {
    // Written after users-active went off: the record has no user.
    const nameless = turn({ at: "2026-11-19T10:00:00.000Z" }) as unknown as Record<string, unknown>;
    delete nameless.user;
    const i = input({ lines: [turn({ at: "2026-11-18T09:00:00.000Z" }), nameless as unknown as TelemetryLine] });
    expect(item(i, "users-active")).toMatchObject({ count7d: 1, lastSeen: "2026-11-18T09:00:00.000Z" });
  });

  it("says off, since when and by whom, for its own switch, its section's and telemetry's", () => {
    const changed = { "items.speed-p95": { at: "2026-11-19T08:00:00.000Z", by: "root" }, "groups.users": { at: "2026-11-19T09:00:00.000Z", by: "admin2" }, telemetry: { at: "2026-11-19T11:00:00.000Z", by: "admin3" } };
    expect(item(withSignal("speed-p95", false, { changed }), "speed-p95")).toMatchObject({ status: "off", offSince: "2026-11-19T08:00:00.000Z", offBy: "root", switch: { on: false, editable: true } });
    const sectionOff = input({ switches: { telemetry: true, groups: { ...switchDefaults().groups, users: false }, items: switchDefaults().items }, changed });
    expect(item(sectionOff, "users-active")).toMatchObject({ status: "off", howToEnable: expect.stringMatching(/Users section/), offBy: "admin2", switch: { on: true } });
    expect(telemetryChecklist(sectionOff).groups[0]).toMatchObject({ id: "users", on: false, changed: { by: "admin2" } });
    const allOff = input({ switches: { ...input().switches, telemetry: false }, changed });
    expect(item(allOff, "users-active")).toMatchObject({ status: "off", howToEnable: "Telemetry is off.", offBy: "admin3" });
    expect(telemetryChecklist(allOff).telemetry).toEqual({ on: false, changed: { at: "2026-11-19T11:00:00.000Z", by: "admin3" } });
  });

  it("starts the privacy-sensitive items off, each with its note, and kept recordings with the consent notice", () => {
    const i = input({ settings: { retentionDays: 90, audioRetentionDays: 30, consentNotice: "We keep recordings for a month." } });
    for (const id of ["question-text", "transcript-text", "voice-audio", "device-class", "device-network"]) {
      const x = item(i, id);
      expect(x.status).toBe("off");
      expect(x.switch).toMatchObject({ on: false, default: false, editable: true, sensitive: expect.any(String) });
    }
    expect(item(i, "voice-audio").switch.consent).toBe("We keep recordings for a month.");
    expect(item(i, "question-text").switch.consent).toBe(null);
    const kept = withSignal("voice-audio", true);
    expect(item(kept, "voice-audio").status).toBe("enabled-no-data");
    expect(item({ ...kept, audioSaved: ["2026-11-19T08:00:00.000Z"] }, "voice-audio")).toMatchObject({ status: "recording", count7d: 1 });
  });

  it("gives what cannot be switched a disabled switch and the reason", () => {
    expect(item(input(), "speed-time-saved")).toMatchObject({ status: "not-telemetry", switch: { key: null, editable: false, blockedBy: "not-telemetry", reason: expect.stringMatching(/baseline/) } });
    expect(item(input(), "voice-wer-true")).toMatchObject({ status: "not-telemetry", howToEnable: expect.stringMatching(/hand-made transcripts/) });
    expect(item(input({ context: {} }), "users-by-country")).toMatchObject({ status: "needs-config", switch: { editable: false, blockedBy: "needs-config", reason: expect.stringMatching(/country/) } });
    expect(item(input({ context: { b1: { country: "A" } } }), "users-return")).toMatchObject({ status: "needs-config", howToEnable: expect.stringMatching(/campaign/) });
    expect(item(input({ lines: [turn({ roles: [] })] }), "users-by-role")).toMatchObject({ status: "needs-config", howToEnable: expect.stringMatching(/plugin/) });
    expect(item(input(), "users-by-role").status).toBe("recording");
  });

  it("links what another feature owns to that feature's switch, disabled while it is off", () => {
    const cacheOff = input({ features: { ...input().features, cache: false } });
    expect(item(cacheOff, "reuse-hit-rate")).toMatchObject({ status: "off", feature: "cache", switch: { editable: false, blockedBy: "feature", feature: "cache", reason: expect.stringMatching(/cache switch, which is off/) } });
    expect(item(input({ lines: [turn({ reuse: "exact" })] }), "reuse-hit-rate")).toMatchObject({ status: "recording", switch: { editable: true } });
    expect(item(input(), "review-runs")).toMatchObject({ status: "off", switch: { editable: false, feature: "review.daily" } });
    const reviewing = input({ features: { ...input().features, "review.daily": true }, owned: { "review-runs": { count: 4, lastSeen: "2026-11-19T06:00:00.000Z" } } });
    expect(item(reviewing, "review-runs")).toMatchObject({ status: "recording", count7d: 4, switch: { on: true, editable: false, feature: "review.daily", reason: expect.stringMatching(/its own switch/) } });
    expect(item(input({ features: { ...input().features, voice: false } }), "voice-share")).toMatchObject({ status: "off", switch: { editable: false, feature: "voice" } });
    expect(item(input({ features: { telemetry: true } }), "quality-clarify")).toMatchObject({ status: "off", howToEnable: expect.stringMatching(/does not have/) });
  });

  it("says needs-config for Superset's action log outside Superset or when it cannot be read", () => {
    expect(item(input(), "trust-superset-actions").status).toBe("needs-config");
    expect(item(input({ supersetLogs: { available: false, reason: "403 from the log API", count: 0, lastSeen: null } }), "trust-superset-actions")).toMatchObject({ status: "needs-config", howToEnable: "403 from the log API" });
    expect(item(input({ supersetLogs: { available: true, count: 3, lastSeen: "2026-11-19T00:00:00" } }), "trust-superset-actions")).toMatchObject({ status: "recording", count7d: 3 });
  });

  it("says what each item means for privacy", () => {
    expect(item(input(), "users-active").privacy).toEqual(["usernames visible to admins with the usage right"]);
    expect(item(input(), "question-text").privacy).toEqual(["stores question text"]);
    expect(item(input(), "voice-audio").privacy).toEqual(["stores audio"]);
  });
});
