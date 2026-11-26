// The turn gate: how many model turns run at once, who waits and is told their place, who is
// turned away, and edits to one board one after another.
import { describe, expect, it } from "vitest";

import { QueueBusy, type QueueWait, localTurnGate, looksLikeEdit, queueSettings } from "../src";

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("the turn gate", () => {
  it("lets maxConcurrent turns run, lines the next up with their place, and turns away one more", async () => {
    const gate = localTurnGate(() => ({ maxConcurrent: 2, maxWaiting: 2, maxWaitSeconds: 5 }));
    const a = await gate.acquire();
    const b = await gate.acquire();
    const told: QueueWait[][] = [[], []];
    let cGot = false;
    const c = gate.acquire({ onWait: (w) => told[0]!.push(w) }).then((t) => ((cGot = true), t));
    const d = gate.acquire({ onWait: (w) => told[1]!.push(w) });
    await settle();
    expect(told[0]!.at(-1)).toMatchObject({ state: "waiting", reason: "busy", position: 1 });
    expect(told[1]!.at(-1)).toMatchObject({ position: 2, etaSeconds: expect.any(Number) });
    expect(gate.stats()).toMatchObject({ running: 2, waiting: 2 });
    // The line is full: one more is told to come back.
    await expect(gate.acquire()).rejects.toMatchObject({ why: "full", retryAfterSeconds: 60 });
    // A place frees: the first in line goes, the second moves up.
    a.release();
    const ct = await c;
    expect(cGot).toBe(true);
    expect(ct.queueMs).toBeGreaterThanOrEqual(0);
    expect(told[1]!.at(-1)).toMatchObject({ position: 1 });
    // Releasing twice frees one place only.
    b.release();
    b.release();
    const dt = await d;
    expect(gate.stats()).toMatchObject({ running: 2, waiting: 0 });
    ct.release();
    dt.release();
    expect(gate.stats().running).toBe(0);
  });

  it("gives up on a wait longer than maxWaitSeconds", async () => {
    const gate = localTurnGate(() => ({ maxConcurrent: 1, maxWaiting: 5, maxWaitSeconds: 1 }));
    const held = await gate.acquire();
    const t0 = Date.now();
    const err = await gate.acquire().catch((e) => e);
    expect(err).toBeInstanceOf(QueueBusy);
    expect(err.why).toBe("timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(gate.stats().waiting).toBe(0);
    held.release();
  });

  it("runs edits to one board one after another; other boards and questions do not wait for them", async () => {
    const gate = localTurnGate(() => ({ maxConcurrent: 8, maxWaiting: 8, maxWaitSeconds: 5 }));
    const first = await gate.acquire({ board: "b1", edit: true });
    const told: QueueWait[] = [];
    let secondIn = false;
    const second = gate.acquire({ board: "b1", edit: true, onWait: (w) => told.push(w) }).then((t) => ((secondIn = true), t));
    const otherBoard = await gate.acquire({ board: "b2", edit: true });
    const question = await gate.acquire({ board: "b1" });
    await settle();
    expect(secondIn).toBe(false);
    expect(told.at(-1)).toMatchObject({ reason: "edit", position: 1 });
    first.release();
    const s = await second;
    expect(s.boardWaited).toBe(true);
    expect(first.boardWaited).toBe(false);
    for (const t of [s, otherBoard, question]) t.release();
  });

  it("knows an edit request in four languages, and checks its settings", () => {
    for (const q of ["Add a KPI for doses", "please remove the map", "Ajoutez un graphique", "Remova a tabela", "चार्ट जोड़ें"]) expect(looksLikeEdit(q)).toBe(true);
    for (const q of ["How many doses today?", "Combien de doses aujourd'hui ?", "Quantas doses hoje?"]) expect(looksLikeEdit(q)).toBe(false);
    const saved: Record<string, unknown> = {};
    const s = queueSettings({ get: <T>(k: string) => saved[k] as T, set: (k, v) => void (saved[k] = v) }, { maxConcurrent: 4 });
    expect(s.get()).toEqual({ maxConcurrent: 4, maxWaiting: 50, maxWaitSeconds: 60 });
    expect(s.update({ maxWaiting: 10 })).toEqual({ ok: true });
    expect(s.get().maxWaiting).toBe(10);
    expect(s.update({ maxConcurrent: 0 })).toMatchObject({ ok: false });
    expect(s.update({ lanes: 3 })).toMatchObject({ ok: false });
  });
});
