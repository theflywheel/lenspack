// A chat turn whose first edit the reviewer sends back, and whose fix round edits again: what the
// board saves, what the reply says and what the audit log records must agree. The turn saves all
// of its edits or none: one version when the fix is judged good, none when it is not, and the reply
// says "left the board unchanged" only when nothing was saved. Edits held for the reviewer are
// recorded as drafts, never as saved versions; the turn's save (or its absence) is recorded once.
// The models are stubs: a script of builder steps and reviewer verdicts.
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AuditEvent, type Host, type Provider, buildProvider, configSchema, createApp, openConfig, registerLlmAdapter } from "../src";

const pack = fileURLToPath(new URL("../../../../examples/tickets/pack.yaml", import.meta.url));
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const stream = (parts: unknown[]) => ({
  stream: new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  }),
});
const tool = (toolName: string, input: unknown) => [
  { type: "tool-call", toolCallId: `c${Math.random().toString(36).slice(2)}`, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const say = (text: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];

function scripted(steps: unknown[][], verdicts: unknown[]) {
  const seen = { steps: 0, reviews: 0 };
  const model = new MockLanguageModelV4({
    doStream: async () => stream(steps[seen.steps++] ?? say("Done.")),
    doGenerate: async () => {
      const v = verdicts[seen.reviews++] ?? { findings: [] };
      return { content: [{ type: "text", text: JSON.stringify(v) }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
  });
  return { model, seen };
}

// "Make the first chart twice as wide": round 1 widens it and squeezes its neighbours; the reviewer
// says the neighbours were changed unasked; the fix round puts them back and moves one down.
const SQUEEZED = { severity: "material", widget: "b", problem: "b went from 4/12 to 3/12 although only a was to change", forUser: "Another tile in the top row was made narrower, which you did not ask for." };
const STILL_WRONG = { severity: "material", widget: "a", problem: "a is 5/12, not twice its former 4/12", forUser: "The first chart is still narrower than asked." };
const round1 = [tool("resize_widget", { id: "a", width: "half", height: 0 }), say("I made the first chart half width.")];
const fixRound = [
  tool("move_widget", { id: "c", place: "below:a", width: "third" }),
  tool("resize_widget", { id: "b", width: "third", height: 0 }),
  say("The first chart is now half width beside the second, and the third tile sits on the row below."),
];

type Part = { type: string; id?: string; delta?: string; output?: any; data?: any };

describe("a turn whose edit is sent back for a fix", () => {
  const servers: Server[] = [];
  let host: Host;
  let close: () => Promise<void>;
  let base: string;
  const audited: AuditEvent[] = [];
  const scripts: Record<string, ReturnType<typeof scripted>> = {};

  beforeAll(async () => {
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack, source: "data" }] }), tmpdir());
    host = opened.hosts[0]!;
    close = opened.close;
    Object.assign(scripts, {
      good: scripted([...round1, ...fixRound], [{ findings: [SQUEEZED] }, { findings: [] }]),
      bad: scripted([...round1, ...fixRound, say("I couldn't make the first chart twice as wide without moving the others, so the board is as it was.")], [{ findings: [SQUEEZED] }, { findings: [STILL_WRONG] }]),
    });
    const providers: Provider[] = Object.entries(scripts).map(([name, s]) => {
      registerLlmAdapter({ kind: `commit-${name}`, defaultBaseUrl: "mock:", build: () => s.model });
      return { ...buildProvider({ name, kind: `commit-${name}`, model: "m", pricing: { input: 1, output: 2 } }), available: true };
    });
    const server = createServer(createApp([host], { providers, audit: (e) => audited.push(e) }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${host.name}`;
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    await close();
  });

  const text = (id: string, title: string) => ({ op: "add_widget" as const, id, widget: { kind: "text" as const, title, body: title }, placement: { place: "bottom", width: "third" as const } });

  const turn = async (name: string) => {
    // Three tiles side by side in row 1, saved as v2 before the turn.
    await host.store.create({ id: name, pack: host.pack, title: "Tasks" });
    const seeded = await host.store.patch({ id: name, ops: [text("a", "Task records"), text("b", "Tasks per week"), text("c", "Tasks by team")], catalogue: host.catalogue!, source: "seed" });
    expect(seeded.ok).toBe(true);
    const from = audited.length;
    const res = await fetch(`${base}/${name}/chat?model=${name}`, { method: "POST", body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "make the first chart twice as wide" }] }] }) });
    const parts = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)) as Part);
    const texts: string[] = [];
    for (const p of parts) {
      if (p.type === "text-start") texts.push("");
      if (p.type === "text-delta" && texts.length) texts.push(texts.pop()! + (p.delta ?? ""));
    }
    const versions = await host.store.versions(name);
    const board = (await host.store.get(name))!;
    const lines = audited.slice(from).filter((e) => e.board === name);
    return { parts, texts, board, saved: versions.filter((v) => v.version > 2).reverse(), lines, edits: parts.filter((p) => p.type === "tool-output-available").map((p) => p.output) };
  };

  it("a fix judged good saves one version, the board as it ended; the reply describes it", async () => {
    const t = await turn("good");
    expect(scripts.good!.seen.reviews).toBe(2);
    // One version for the turn, holding the fix's layout: a two thirds wide, b as it was, c below a.
    expect(t.saved.map((v) => `${v.version} ${v.source}`)).toEqual(["3 chat"]);
    expect(t.board.version).toBe(3);
    const at = (id: string) => t.board.config.layout.find((l) => l.i === id)!;
    expect([at("a").w, at("b").w, at("c").y > at("a").y]).toEqual([6, 4, true]);
    // The reply says what the board ended as, never that it was left unchanged.
    expect(t.texts).toEqual(["The first chart is now half width beside the second, and the third tile sits on the row below."]);
    expect(t.texts.join(" ")).not.toMatch(/unchanged|as it was/i);
    // The edits on the way were drafts, and say so to the chat panel; they are not saved versions.
    expect(t.edits.filter((o) => o.applied).every((o) => o.held === true)).toBe(true);
    const edits = t.lines.filter((e) => e.action === "chat-edit");
    expect(edits.map((e) => e.detail)).toEqual(["resize_widget → draft v3", "resize_widget,move_widget → draft v4", "resize_widget → draft v5"]);
    // The turn's save is recorded once, with the version it really made.
    const saves = t.lines.filter((e) => e.action === "chat-save");
    expect(saves.map((e) => `${e.outcome} ${e.detail}`)).toEqual(["ok saved v3: resized “Task records”, moved “Tasks per week”"]);
    const line = JSON.parse(t.lines.find((e) => e.action === "chat-turn")!.detail!);
    expect(line).toMatchObject({ outcome: "saved", saved: ["v3"] });
  });

  it("a fix judged bad saves nothing; only then does the reply say the board was left unchanged", async () => {
    const t = await turn("bad");
    expect(scripts.bad!.seen.reviews).toBe(2);
    expect(t.saved).toEqual([]);
    expect(t.board.version).toBe(2);
    expect(t.board.config.layout.map((l) => `${l.i} ${l.x},${l.y} ${l.w}`)).toEqual(["a 0,0 4", "b 4,0 4", "c 8,0 4"]);
    expect(t.texts).toEqual(["I couldn't make the first chart twice as wide without moving the others, so the board is as it was."]);
    expect(t.texts.join(" ")).not.toContain("half width beside");
    // Three draft edits, then one line saying none of them was saved.
    expect(t.lines.filter((e) => e.action === "chat-edit").map((e) => e.detail)).toEqual(["resize_widget → draft v3", "resize_widget,move_widget → draft v4", "resize_widget → draft v5"]);
    const saves = t.lines.filter((e) => e.action === "chat-save");
    expect(saves.map((e) => `${e.outcome} ${e.detail}`)).toEqual(["refused nothing saved: 3 draft edits (v3–v5) dropped"]);
    const line = JSON.parse(t.lines.find((e) => e.action === "chat-turn")!.detail!);
    expect(line).toMatchObject({ outcome: "left unchanged", saved: [] });
  });
});
