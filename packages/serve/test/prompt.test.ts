import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyBoard } from "@lenspack/core";
import { catalogueFrom, loadPack, parsePack } from "@lenspack/spec";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { INLINE_KEYS, PROMPT_VERSION, SYSTEM, configSchema, openConfig, recentTurns, systemParts, userChangesText } from "../src";

const tickets = fileURLToPath(new URL("../../../examples/tickets/pack.yaml", import.meta.url));

describe("the system prompt", () => {
  it("carries the pack's domain rules and checked examples", async () => {
    const pack = await loadPack(tickets);
    const system = SYSTEM(pack, catalogueFrom(pack));
    expect(system).toContain("DOMAIN RULES:\nCompare resolution times on the median or p90");
    expect(system).toContain('- "How often do tickets get escalated?" → value transitions where transition eq "escalated" (tickets by transition would fan out, so count status changes)');
  });

  it("lists only keys and labels for a catalogue too large to inline, and points at list_metrics", () => {
    const measures = Array.from({ length: INLINE_KEYS + 1 }, (_, i) => ({ key: `m${i}`, entity: "t", agg: "count", label: i === 0 ? "First" : undefined, hint: "a long meaning" }));
    const pack = parsePack({ pack: "big", version: 1, entities: { t: { source: "t" } }, measures });
    const system = SYSTEM(pack, catalogueFrom(pack));
    expect(system).toContain("- t: m0 (First), m1, m2,");
    expect(system).not.toContain("a long meaning");
    expect(system).toContain("Meanings are not listed: call list_metrics");
  });
});

describe("the system prompt's parts", () => {
  const board = (title: string) => ({ ...emptyBoard({ pack: "tickets", version: 1 }, title) });
  const changes = [
    { version: 7, source: "layout", text: "moved “Open by team”" },
    { version: 8, source: "ops", text: "removed “Backlog”" },
    { version: 9, source: "revert", text: "restored v7 (added “Backlog”)" },
  ];

  it("keeps the stable part identical across boards and the user's changes, so a prompt cache keeps it", async () => {
    const pack = await loadPack(tickets);
    const catalogue = catalogueFrom(pack);
    const now = new Date("2026-01-02T00:00:00Z");
    const [stableA, boardA] = systemParts(pack, catalogue, board("One"), now);
    const [stableB, boardB] = systemParts(pack, catalogue, board("Two"), now, changes);
    expect(stableA).toBe(stableB);
    expect(stableA).not.toContain("CURRENT BOARD");
    expect(stableA).not.toContain("CHANGES MADE BY THE USER");
    expect(boardA).not.toContain("CHANGES MADE BY THE USER");
    // The board first, then the user's edits since the last turn, last of all.
    expect(boardB.indexOf("CURRENT BOARD:")).toBe(2);
    expect(boardB.indexOf("CHANGES MADE BY THE USER")).toBeGreaterThan(boardB.indexOf("Board: “Two”"));
    expect(SYSTEM(pack, catalogue, board("Two"), now, changes)).toBe(stableB + boardB);
  });

  it("words the user's changes by version and by who made them", () => {
    expect(userChangesText([])).toBe("");
    expect(userChangesText(changes)).toBe(
      "\n\nCHANGES MADE BY THE USER SINCE YOUR LAST TURN (the current board above already includes them):\n- v7 (by hand): moved “Open by team”\n- v8 (by hand): removed “Backlog”\n- v9 (rollback): restored v7 (added “Backlog”)",
    );
  });

  it("keeps replies after edits to plain sentences, and allows short lists and bold for an informational answer", async () => {
    const pack = await loadPack(tickets);
    const [stable] = systemParts(pack, catalogueFrom(pack));
    expect(PROMPT_VERSION).toBe(10);
    expect(stable).toContain("After edits, reply in one or two plain sentences with the outcome only.");
    expect(stable).toContain("may use a short bullet list and **bold**");
    expect(stable).toContain("Never use markdown headings or tables.");
    expect(stable).toContain("they are deliberate: keep them, never undo them unless asked");
  });
});

describe("chat history", () => {
  const msg = (id: string, role: "user" | "assistant", text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
  it("keeps the last n user turns, each assistant reply whole with its tool calls", () => {
    const call = { ...msg("a1", "assistant", "done"), parts: [{ type: "tool-query", toolCallId: "c1", state: "output-available", input: {}, output: { ok: true } }] } as unknown as UIMessage;
    const history = [msg("u0", "user", "first"), msg("a0", "assistant", "ok"), msg("u1", "user", "second"), call, msg("u2", "user", "third")];
    expect(recentTurns(history, 2).map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    expect(recentTurns(history, 8)).toEqual(history);
  });
});

describe("pack examples at load", () => {
  const open = (pack: string) => openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack, source: "data" }] }), tmpdir());
  it("resolves each example against the source, and refuses one the source would refuse", async () => {
    await (await open(tickets)).close();
    const bad = join(mkdtempSync(join(tmpdir(), "lenspack-examples-")), "pack.yaml");
    writeFileSync(bad, readFileSync(tickets, "utf8").replace("measure: transitions, filters", "measure: tickets, filters"));
    await expect(open(bad)).rejects.toThrow(/examples\[1\] \("How often do tickets get escalated\?"\): .*Measure one of these instead: transitions/);
  });
});
