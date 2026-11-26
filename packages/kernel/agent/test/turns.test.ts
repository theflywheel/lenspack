// The record of what each chat turn did, under the key its client sent (turns.ts): what Retry and the client's check
// after a cut-off reply read, so a turn that already changed the board is never run twice.
import { describe, expect, it } from "vitest";

import { memoryTurnLog, turnKeyOf, widgetChanges } from "../src/turns";

const scope = { user: "ana", board: "b1", key: "k-12345678" };
const board = (widgets: Record<string, string>, title = "Board") =>
  ({ title, widgets: Object.fromEntries(Object.entries(widgets).map(([id, t]) => [id, { kind: "text", title: t, body: t }])), layout: Object.keys(widgets).map((i, n) => ({ i, x: 0, y: n, w: 12, h: 2 })), filters: [] }) as never;

describe("memoryTurnLog", () => {
  it("starts a record once: the same key again is the same question, still running or done", async () => {
    const log = memoryTurnLog();
    expect(log.begin(scope, 2)).toBe(true);
    expect(log.begin(scope, 2)).toBe(false);
    expect(log.get(scope)).toEqual({ state: "running", from: 2 });
    log.end(scope, { from: 2, to: 3, changes: { added: [], removed: ["Stock"], changed: [], other: false }, reply: "Removed." });
    expect(log.begin(scope, 3)).toBe(false);
    expect(log.get(scope)).toMatchObject({ state: "done", from: 2, to: 3, reply: "Removed." });
  });

  it("lets a turn that failed without changing anything be asked again", () => {
    const log = memoryTurnLog();
    log.begin(scope, 2);
    log.end(scope, { from: 2, to: 2, failed: true });
    expect(log.begin(scope, 2)).toBe(true);
    expect(log.get(scope)).toEqual({ state: "running", from: 2 });
    // One that failed after changing the board is not run again.
    log.end(scope, { from: 2, to: 3, failed: true });
    expect(log.begin(scope, 3)).toBe(false);
  });

  it("keeps one user's and one board's records from another's", () => {
    const log = memoryTurnLog();
    log.begin(scope, 2);
    expect(log.get({ ...scope, user: "ben" })).toBeUndefined();
    expect(log.get({ ...scope, board: "b2" })).toBeUndefined();
    expect(log.begin({ ...scope, user: "ben" }, 2)).toBe(true);
  });

  it("forgets a record after its time", () => {
    let t = 0;
    const log = memoryTurnLog({ ttlMs: 1000, now: () => t });
    log.begin(scope, 2);
    t = 1001;
    expect(log.get(scope)).toBeUndefined();
    expect(log.begin(scope, 2)).toBe(true);
  });

  it("waits for a running turn to end, up to a limit", async () => {
    const log = memoryTurnLog();
    log.begin(scope, 2);
    setTimeout(() => log.end(scope, { from: 2, to: 2, reply: "Two." }), 300);
    expect(await log.settled(scope, 5000)).toMatchObject({ state: "done", reply: "Two." });
    const other = { ...scope, key: "k-87654321" };
    log.begin(other, 2);
    expect(await log.settled(other, 250)).toMatchObject({ state: "running" });
  });
});

describe("turnKeyOf", () => {
  it("takes 8 to 64 letters, digits, - and _ only", () => {
    expect(turnKeyOf("0b9c2d7e-1f00-4a8e-9a77-3c2c5a1d9e10")).toBe("0b9c2d7e-1f00-4a8e-9a77-3c2c5a1d9e10");
    for (const bad of ["short", "../../etc", "a".repeat(65), 12345678, null]) expect(turnKeyOf(bad)).toBeNull();
  });
});

describe("widgetChanges", () => {
  it("names widgets added, removed and changed by title, and flags any other change", () => {
    expect(widgetChanges(board({ a: "Visits", b: "Stock" }), board({ a: "Visits" }))).toEqual({ added: [], removed: ["Stock"], changed: [], other: false });
    expect(widgetChanges(board({ a: "Visits" }), board({ a: "Visits by day", c: "New" }))).toEqual({ added: ["New"], removed: [], changed: ["Visits by day"], other: false });
    expect(widgetChanges(board({ a: "Visits" }), board({ a: "Visits" }, "Renamed"))).toEqual({ added: [], removed: [], changed: [], other: true });
  });
});
