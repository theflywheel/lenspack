import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLOSING_PROMPT, type Host, type Provider, buildProvider, configSchema, createApp, openConfig, registerLlmAdapter } from "../src";

const pack = fileURLToPath(new URL("../../../examples/tickets/pack.yaml", import.meta.url));
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stream = (parts: unknown[]) => ({
  stream: new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  }),
});

// A model that never stops editing: every step renames the board again. When the closing
// call comes (tools off), it answers with `closing`, which may be empty.
function looping(closing: string, call: (n: number) => { toolName: string; input: unknown } = (n) => ({ toolName: "rename_board", input: { title: `Title ${n}` } })) {
  let n = 0;
  const seen: { toolChoice?: unknown; lastUser?: string }[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ toolChoice, prompt }) => {
      const last = [...prompt].reverse().find((m) => m.role === "user");
      const lastUser = last && Array.isArray(last.content) ? last.content.map((p) => ("text" in p ? p.text : "")).join("") : String(last?.content ?? "");
      seen.push({ toolChoice, lastUser });
      if (toolChoice?.type === "none")
        return stream([
          ...(closing ? [{ type: "text-start", id: "s" }, { type: "text-delta", id: "s", delta: closing }, { type: "text-end", id: "s" }] : []),
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ]);
      n += 1;
      return stream([
        { type: "tool-call", toolCallId: `c${n}`, toolName: call(n).toolName, input: JSON.stringify(call(n).input) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
      ]);
    },
  });
  return { model, seen, steps: () => n };
}

describe("a turn that runs out of steps", () => {
  const servers: Server[] = [];
  let host: Host;
  let close: () => Promise<void>;
  let base: string;
  // Renames the board once, then keeps asking to move "a" where it already is: a no-op move,
  // refused every time, until the guard on repeated refusals ends the loop.
  const noop = (n: number) => (n === 1 ? { toolName: "rename_board", input: { title: "Renamed once" } } : { toolName: "move_widget", input: { id: "a", place: "bottom", width: "half" } });
  const models: Record<string, ReturnType<typeof looping>> = {
    talks: looping("Je l'ai renommé douze fois ; rien d'autre n'est fait."),
    silent: looping(""),
    refused: looping("Renamed the board; the chart was already at the bottom, so it did not move.", noop),
    refusedSilent: looping("", noop),
  };

  beforeAll(async () => {
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack, source: "data" }] }), tmpdir());
    host = opened.hosts[0]!;
    close = opened.close;
    const providers: Provider[] = Object.entries(models).map(([name, m]) => {
      registerLlmAdapter({ kind: `stepcap-${name}`, defaultBaseUrl: "mock:", build: () => m.model });
      return { ...buildProvider({ name, kind: `stepcap-${name}`, model: "m" }), available: true };
    });
    const server = createServer(createApp([host], { providers }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${host.name}`;
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    await close();
  });

  const chat = async (board: string, model: string, withWidget = false) => {
    await host.store.create({ id: board, pack: host.pack, title: "Start" });
    if (withWidget)
      await fetch(`${base}/${board}/ops`, { method: "POST", body: JSON.stringify({ ops: [{ op: "add_widget", id: "a", widget: { kind: "text", title: "A", body: "a" }, placement: { width: "half" } }] }) });
    const res = await fetch(`${base}/${board}/chat?review=off&model=${model}`, { method: "POST", body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "renomme le tableau" }] }] }) });
    const body = await res.text();
    return body
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l.includes('"text-delta"'))
      .map((l) => (JSON.parse(l.slice(6)) as { delta: string }).delta)
      .join("");
  };

  it("ends with a summary from one more call, tools off", async () => {
    const reply = await chat("talks", "talks");
    expect(models.talks!.steps()).toBe(12);
    const closing = models.talks!.seen.at(-1)!;
    expect(closing.toolChoice).toEqual({ type: "none" });
    expect(closing.lastUser?.startsWith(CLOSING_PROMPT)).toBe(true);
    // Grounded in the board, start of turn against now.
    expect(closing.lastUser).toContain("Board at the start of this turn:");
    expect(closing.lastUser).toContain("“Title 12”");
    expect(reply).toBe("Je l'ai renommé douze fois ; rien d'autre n'est fait.");
  });

  it("falls back to the board's versions when that call says nothing", async () => {
    const reply = await chat("silent", "silent");
    expect(reply).toMatch(/^I ran out of steps before finishing\. Changed so far: /);
    expect(reply).toContain("Title 12");
  });

  it("describes the board, not the last refusal, when a loop of no-op moves ends the turn", async () => {
    const reply = await chat("refused", "refused", true);
    expect(models.refused!.seen.at(-1)!.toolChoice).toEqual({ type: "none" });
    expect(reply).toBe("Renamed the board; the chart was already at the bottom, so it did not move.");
    expect(reply).not.toContain("Refused:");
  });

  it("falls back to what changed and what was refused when that summary is empty", async () => {
    const reply = await chat("refusedSilent", "refusedSilent", true);
    expect(reply).toMatch(/^I ran out of steps before finishing\. Changed so far: .*Renamed once/);
    expect(reply).toContain("Not done: move_widget: Moving \"a\" there changes nothing");
    expect(reply).not.toContain("I could not do that");
  });
});
