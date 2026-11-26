// Data export without a host: who may read which stream (policy), which streams the switches keep, what a record may
// carry when it leaves, and cursor pages that never skip or repeat a record.
import { type ExportGrant, exportDecision, exportIndex } from "@lenspack/policy";
import { describe, expect, it } from "vitest";

import { type TelemetryLine, TELEMETRY_ITEMS, decodeCursor, encodeCursor, exportLine, exportPage, itemsOn, standIn, streamsKept, switchDefaults, switchable, telemetryStream, withoutNames } from "../src";

const ALL: ReadonlySet<string> = new Set(TELEMETRY_ITEMS.filter(switchable).map((s) => s.id));
const hash = (s: string) => Buffer.from(s).toString("hex").padEnd(64, "0");
const grant = (g: Partial<ExportGrant> = {}): ExportGrant => ({ name: "warehouse", streams: ["turns", "feedback", "audit", "cost"], usernames: false, ...g });

const turn = (o: Partial<Extract<TelemetryLine, { type: "turn" }>> = {}) =>
  ({ type: "turn", v: 1, turnId: "t1", sessionId: "s1", at: "2026-11-01T10:00:00.000Z", user: "ana", roles: ["Viewer"], tenant: null, board: "b1", pack: "p", datasets: ["d1"], question: "how many visits last week", questionHash: "qh", kind: "direct", outcome: "answered", costUsd: 0.01, ...o }) as unknown as TelemetryLine;
const event = (o: Record<string, unknown> = {}) => ({ type: "event", v: 1, event: "feedback", at: "2026-11-01T10:01:00.000Z", user: "ana", roles: [], turnId: "t1", board: "b1", pack: "p", rating: "down", reason: "wrong-number", comment: "the total looks off", data: null, ...o }) as unknown as TelemetryLine;

describe("who may read a stream (policy)", () => {
  const states = streamsKept({ itemsOn: ALL, telemetry: true, audit: true });
  it("refuses a stream the token was not given, and one the deployment does not keep", () => {
    expect(exportDecision(grant(), "events", states)).toMatchObject({ ok: false, status: 403, code: "not-granted" });
    expect(exportDecision(grant(), "nonsense", states)).toMatchObject({ ok: false, status: 404, code: "unknown-stream" });
    const off = streamsKept({ itemsOn: ALL, telemetry: true, audit: false });
    expect(exportDecision(grant(), "audit", off)).toMatchObject({ ok: false, status: 404, code: "not-kept" });
    expect(exportDecision(grant(), "turns", states)).toEqual({ ok: true, stream: "turns", usernames: false, actor: "export:warehouse" });
  });
  it("lists what a token may read now, and why the rest is off", () => {
    const off = streamsKept({ itemsOn: ALL, telemetry: false, audit: true });
    expect(exportIndex(grant(), off)).toEqual({ token: "warehouse", usernames: false, streams: ["audit", "cost"], off: { turns: "usage telemetry is off", feedback: "usage telemetry is off" } });
  });
});

describe("which streams the switches keep", () => {
  it("follows telemetry as a whole, the feedback item, the voice items and the audit log", () => {
    const defaults = itemsOn({ telemetry: true, ...switchDefaults() }, { voice: true });
    const s = streamsKept({ itemsOn: defaults, telemetry: true, audit: true });
    expect(s.turns.kept && s.feedback.kept && s.audit.kept && s.cost.kept).toBe(true);
    // Kept recordings start off.
    expect(s.recordings).toEqual({ kept: false, why: "the voice-audio item (kept recordings) is off" });
    const noThumbs = new Set([...defaults].filter((id) => id !== "quality-thumbs-down"));
    expect(streamsKept({ itemsOn: noThumbs, telemetry: true, audit: true }).feedback.kept).toBe(false);
    expect(Object.values(streamsKept({ itemsOn: new Set(), telemetry: false, audit: true })).filter((x) => x.kept)).toHaveLength(2);
  });
  it("keeps only events whose item is on", () => {
    const ev = telemetryStream("events")!;
    expect(ev.keep(event(), ALL)).toBe(true);
    expect(ev.keep(event(), new Set([...ALL].filter((id) => id !== "quality-thumbs-down")))).toBe(false);
    expect(ev.keep(turn(), ALL)).toBe(false);
  });
});

describe("what a record carries when it leaves", () => {
  it("leaves out the fields of items switched off now, even if they were written while on", () => {
    const off = new Set([...ALL].filter((id) => id !== "question-text"));
    const out = exportLine(turn(), off, { usernames: true, hash });
    expect(out.question).toBeUndefined();
    expect(out.questionHash).toBe("qh");
    expect(exportLine(turn(), ALL, { usernames: true, hash }).question).toBe("how many visits last week");
  });
  it("gives user names as written only with the usernames right; otherwise the admin panel's stand-in", () => {
    expect(exportLine(turn(), ALL, { usernames: true, hash }).user).toBe("ana");
    const masked = exportLine(turn(), ALL, { usernames: false, hash }).user;
    expect(masked).toMatch(/^u_[0-9a-f]{12}$/);
    expect(masked).toBe(withoutNames([{ user: "ana" }], hash)[0]!.user);
    expect(standIn("ana", hash)).toBe(masked);
  });
  it("drops the user entirely when no user item is on", () => {
    const noUsers = new Set([...ALL].filter((id) => !TELEMETRY_ITEMS.find((i) => i.id === id)?.turn?.includes("user")));
    expect(exportLine(turn(), noUsers, { usernames: true, hash }).user).toBeUndefined();
  });
});

describe("cursor pages", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m)).toISOString();
  // Three records share a time, so the page break falls between equal times.
  const recs = [0, 1, 1, 1, 2, 3, 4].map((m, i) => ({ at: at(m), id: `r${i}` }));
  it("pages oldest first, with no record skipped or repeated across equal times", () => {
    const seen: string[] = [];
    let cursor;
    for (let n = 0; n < 10; n++) {
      const p = exportPage(recs, { limit: 2, cursor }, (r) => r.id);
      seen.push(...p.records.map((r) => r.id));
      if (!p.next) break;
      const back = decodeCursor(encodeCursor(p.next));
      if ("error" in back) throw new Error(back.error);
      cursor = back;
    }
    expect(seen.sort()).toEqual(recs.map((r) => r.id).sort());
    expect(new Set(seen).size).toBe(recs.length);
  });
  it("puts records written while a client pages through on a later page", () => {
    const first = exportPage(recs, { limit: 3 }, (r) => r.id);
    const grown = [...recs, { at: at(9), id: "late" }];
    const rest = exportPage(grown, { limit: 100, cursor: first.next! }, (r) => r.id);
    expect([...first.records, ...rest.records].map((r) => r.id)).toHaveLength(grown.length);
    expect(rest.records.at(-1)!.id).toBe("late");
  });
  it("keeps from inclusive and to exclusive, and refuses a cursor it did not give", () => {
    const p = exportPage(recs, { limit: 100, from: new Date(at(1)), to: new Date(at(3)) }, (r) => r.id);
    expect(p.records.map((r) => r.at)).toEqual([at(1), at(1), at(1), at(2)]);
    expect(p.next).toBeNull();
    expect(decodeCursor("not-a-cursor")).toEqual({ error: "cursor is not one this server gave" });
  });
});
