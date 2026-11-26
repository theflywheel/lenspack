import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyBoard } from "@lenspack/core";
import { catalogueFrom, loadPack, parsePack } from "@lenspack/pack";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { INLINE_KEYS, PROMPT_VERSION, configSchema, languageText, openConfig, recentTurns, systemParts, userChangesText } from "../src";

const tickets = fileURLToPath(new URL("../../../../examples/tickets/pack.yaml", import.meta.url));

describe("the system prompt", () => {
  it("carries the pack's domain rules and checked examples", async () => {
    const pack = await loadPack(tickets);
    const [system] = systemParts(pack, catalogueFrom(pack));
    expect(system).toContain("DOMAIN RULES:\nCompare resolution times on the median or p90");
    expect(system).toContain('- "How often do tickets get escalated?" → value transitions where transition eq "escalated" (tickets by transition would fan out, so count status changes)');
  });

  it("lists only keys and labels for a catalogue too large to inline, and points at list_metrics", () => {
    const measures = Array.from({ length: INLINE_KEYS + 1 }, (_, i) => ({ key: `m${i}`, entity: "t", agg: "count", label: i === 0 ? "First" : undefined, hint: "a long meaning" }));
    const pack = parsePack({ pack: "big", version: 1, entities: { t: { source: "t" } }, measures });
    const [system] = systemParts(pack, catalogueFrom(pack));
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
  });

  it("words the user's changes by version and by who made them", () => {
    expect(userChangesText([])).toBe("");
    expect(userChangesText(changes)).toBe(
      "\n\nCHANGES MADE BY THE USER SINCE YOUR LAST TURN (the current board above already includes them):\n- v7 (by hand): moved “Open by team”\n- v8 (by hand): removed “Backlog”\n- v9 (rollback): restored v7 (added “Backlog”)",
    );
  });

  it("adds the clarify rule only when the switch is on", async () => {
    const pack = await loadPack(tickets);
    const [off] = systemParts(pack, catalogueFrom(pack));
    const [on] = systemParts(pack, catalogueFrom(pack), undefined, undefined, undefined, undefined, { clarify: true });
    expect(off).not.toContain("clarify");
    expect(on).toContain("clarify");
    expect(on.length - off.length).toBeLessThan(700);
  });

  it("keeps replies after edits to plain sentences, and allows short lists and bold for an informational answer", async () => {
    const pack = await loadPack(tickets);
    const [stable] = systemParts(pack, catalogueFrom(pack));
    expect(PROMPT_VERSION).toBe(29);
    expect(stable).toContain("no links, HTML or images (a board holds no URLs");
    expect(stable).toContain("After edits, reply in one or two plain sentences with the outcome only.");
    expect(stable).toContain("may use a short bullet list and **bold**");
    expect(stable).toContain("Never use markdown headings.");
    expect(stable).toContain("at most 6 rows and 4 columns");
    expect(stable).toContain("they are deliberate: keep them, never undo them unless asked");
    expect(stable).toContain("restore_version with to: baseline");
    expect(stable).toContain("the layout is done: do not resize anything unless the user asked for a size.");
    expect(stable).toContain("use the row numbers and width words from the tool notes");
    expect(stable).toContain("Never address the user by name.");
    // A rate or change is computed from the measures there are, and the reply says what it was taken as.
    expect(stable).toContain('never say one is not in the data before trying compute. "Burn rate per ward" is breakdown by ward');
    expect(stable).toContain('"average day-on-day % change per ward" is breakdown by ward, grain day, compute "pct_change, mean"');
    expect(stable).toContain("records counts only the records behind the groups shown");
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

describe("languageText", () => {
  it("is empty without a policy, so prompts without one are unchanged", () => {
    expect(languageText()).toBe("");
  });
  it("replies in the user's language on auto and titles in the board's language by default", () => {
    const t = languageText({ reply: "auto" });
    expect(t).toContain("Reply in the language and script of the user's latest message; never in a language or script they have not used in this chat.");
    expect(t).toContain("titles in English, the board's language");
  });
  it("replies in a picked language, and titles follow the reply when the setting says speaker", () => {
    const t = languageText({ reply: "hi", titles: "speaker", board: "fr" });
    expect(t).toContain("write every reply in Hindi (Devanagari script)");
    // Portuguese: one wording for Mozambique, Angola, Portugal and Brazil.
    expect(languageText({ reply: "pt" })).toMatch(/write every reply in Portuguese \(neutral Portuguese that reads naturally in Mozambique, Angola and Portugal as well as Brazil/);
    expect(languageText({ reply: "pt-BR" })).toContain("neutral Portuguese");
    // The data's terms stay as the dataset names them: a ward is never a "distrito".
    expect(languageText({ reply: "pt" })).toMatch(/keep the data's own terms such as ward, LGA and health facility untranslated, never "distrito" for a ward/);
    expect(t).toContain("titles in the language you reply in");
    expect(t).not.toContain("French");
  });
  it("goes in the board part, after the board, never in the cached stable part", async () => {
    const { systemParts } = await import("../src/prompt");
    const pack = { pack: "p", entities: {}, dimensions: [], measures: [], examples: [] } as never;
    const catalogue = { dimensions: [], measures: [] } as never;
    const [stable, board] = systemParts(pack, catalogue, undefined, new Date(0), [], { reply: "fr", board: "fr" });
    expect(stable).not.toContain("LANGUAGE:");
    expect(board).toContain("write every reply in French");
  });
});
