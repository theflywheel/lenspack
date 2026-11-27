// The Telemetry tab's data: what's recorded (each field group's switch and status from the deployment's switches,
// its context, its features and the last 7 days of records), and for each field group that is not recording, why
// (fieldNotices): what a board widget that needs it says instead of a figure.
import { describe, expect, it } from "vitest";

import { type ChecklistInput, type FieldRow, type TelemetryLine, fieldDefaults, fieldNotices, telemetryChecklist } from "../src";

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

  it("names what reads each field, as the host found it on the usage board", () => {
    const uses = { user: [{ id: "users_7d", label: "Active users, 7 days" }] };
    expect(row(input({ uses }), "user").usedBy).toEqual([{ id: "users_7d", label: "Active users, 7 days" }]);
    expect(row(input({ uses }), "question-text").usedBy).toEqual([]);
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

describe("why a field is not recording", () => {
  const notices = (o: Partial<ChecklistInput> & { superset?: boolean } = {}) => fieldNotices({ ...input(o), superset: o.superset });

  it("leaves out every field that is recording", () => {
    const n = notices();
    expect(n.user).toBeUndefined();
    expect(n.cost).toBeUndefined();
    // Off by default: the privacy-sensitive ones, and the daily review, which starts off.
    expect(Object.keys(n).sort()).toEqual(["daily-review", "device-class", "device-network", "question-text", "superset-actions", "transcript-text", "voice-audio"]);
  });

  it("says which field a figure needs and how to get it back: its switch, a feature, voice or the config", () => {
    expect(notices({ switches: { telemetry: true, fields: { ...fieldDefaults(), user: false } } }).user).toEqual({ text: "Needs the User name field, which is switched off.", fix: { kind: "field", id: "user" } });
    expect(notices({ features: { ...input().features, cache: false } }).reuse).toEqual({ text: "Needs the Saved answers used field, which comes with the saved answers switch; that switch is off.", fix: { kind: "settings", feature: "cache" } });
    expect(notices({ features: { ...input().features, voice: false } }).input).toMatchObject({ text: expect.stringMatching(/needs voice/), fix: { kind: "settings", feature: "voice" } });
    expect(notices({ context: {} }).context).toMatchObject({ text: expect.stringMatching(/needs configuration: map dashboards, datasets or roles to a campaign, campaign type or country/), fix: { kind: "config", key: "context" } });
    expect(notices()["daily-review"]).toMatchObject({ text: expect.stringMatching(/daily review feature keeps/), fix: { kind: "settings", feature: "review.daily" } });
    expect(notices({ superset: true })["superset-actions"]).toBeUndefined();
  });

  it("says telemetry is off for every field when it is", () => {
    const n = notices({ switches: { telemetry: false, fields: fieldDefaults() } });
    expect(n.user).toEqual({ text: "Telemetry is off, so nothing new is recorded.", fix: { kind: "settings", feature: "telemetry" } });
  });
});
