// A turn's cost as the chat panel and the audit log see it: the chat models' calls plus the speech
// to text the question was spoken through, claimed once by the turn that names the clip.
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_SPEECH_MODEL, type Host, type Provider, buildProvider, configSchema, createApp, openConfig, registerLlmAdapter, turnCost, turnSummary, usageLedger } from "../src";

const clip = new Uint8Array([26, 69, 223, 163, 1, 2, 3]);

function model() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "text-start", id: "t" });
          c.enqueue({ type: "text-delta", id: "t", delta: "It is empty." });
          c.enqueue({ type: "text-end", id: "t" });
          c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } } });
          c.close();
        },
      }),
    }),
  });
}

describe("turnSummary", () => {
  it("names the models, the tokens, the cost and the speech part", () => {
    const at = new Date().toISOString();
    const base = { at, kind: "k", inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, priced: true, ms: 1, ok: true };
    const cost = turnCost([
      { ...base, role: "speech", provider: "speech", model: "stt-model", usd: 0.0002 },
      { ...base, role: "build", provider: "sonnet", model: "claude-sonnet-5-5", inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50, usd: 0.0015 },
      { ...base, role: "review", provider: "haiku", model: "claude-haiku-5-5", inputTokens: 300, outputTokens: 20, usd: 0.00004 },
    ]);
    expect(turnSummary(cost)).toEqual({
      costUsd: 0.00174,
      tokens: { in: 1300, out: 70, cacheRead: 400, cacheWrite: 0 },
      models: ["claude-sonnet-5-5", "claude-haiku-5-5", "stt-model"],
      sttUsd: 0.0002,
      unpriced: 0,
    });
  });
});

describe("a spoken question's turn", () => {
  const tickets = fileURLToPath(new URL("../../../examples/tickets/pack.yaml", import.meta.url));
  let host: Host;
  let close: () => Promise<void>;
  let server: Server;
  let base: string;
  const audited: { action: string; detail?: string; user: string }[] = [];
  let sttCalls = 0;

  beforeAll(async () => {
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack: tickets, source: "data" }] }), tmpdir());
    host = opened.hosts[0]!;
    close = opened.close;
    await host.store.create({ id: "cost-board", pack: host.pack, title: "Overview" });
    registerLlmAdapter({ kind: "cost-mock", defaultBaseUrl: "mock:", build: () => model() });
    const mock: Provider = { ...buildProvider({ name: "mock", kind: "cost-mock", model: "m", pricing: { input: 1, output: 2 } }), available: true };
    const f = (async () => {
      sttCalls++;
      return new Response(JSON.stringify({ text: "what is on the board", usage: { seconds: 1, cost: 0.0003 } }));
    }) as typeof fetch;
    server = createServer(createApp([host], { providers: [mock], ledger: usageLedger(), audit: (e) => audited.push(e), speech: { apiKey: "k", model: () => DEFAULT_SPEECH_MODEL, fetch: f } }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(async () => {
    server.close();
    await close();
  });

  const speak = async () => (await (await fetch(`${base}/_stt?language=en`, { method: "POST", headers: { "content-type": "audio/webm" }, body: clip })).json()) as { text: string; clip: string };
  const ask = async (speech?: unknown) => {
    const res = await fetch(`${base}/${host.name}/cost-board/chat?review=off`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "what is on the board?" }] }], ...(speech !== undefined ? { speech } : {}) }),
    });
    const parts = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)));
    return parts.find((p) => p.type === "data-usage")!.data as { total: { usd: number }; models: { role: string }[]; summary: { costUsd: number; sttUsd: number; models: string[]; tokens: { in: number; out: number } } };
  };

  it("answers the clip with an id, and the turn that names it includes the clip's cost", async () => {
    const heard = await speak();
    expect(heard.text).toBe("what is on the board");
    expect(heard.clip).toMatch(/^[0-9a-f-]{36}$/);
    const usage = await ask([heard.clip]);
    const chat = (1000 * 1 + 50 * 2) / 1e6;
    expect(usage.summary).toMatchObject({ sttUsd: 0.0003, tokens: { in: 1000, out: 50 }, models: ["m", DEFAULT_SPEECH_MODEL] });
    expect(usage.summary.costUsd).toBeCloseTo(chat + 0.0003, 9);
    expect(usage.models.map((m) => m.role).sort()).toEqual(["build", "speech"]);
    // The audit line carries the same fields, for the settings page.
    const line = JSON.parse(audited.filter((e) => e.action === "chat-turn").at(-1)!.detail!);
    expect(line).toMatchObject({ sttUsd: 0.0003, models: ["m", DEFAULT_SPEECH_MODEL], tokens: { in: 1000, out: 50, cacheRead: 0, cacheWrite: 0 } });
    expect(line.costUsd).toBeCloseTo(chat + 0.0003, 9);
    expect(line.cost.total.usd).toBeCloseTo(chat + 0.0003, 9);
  });

  it("counts a clip once, ignores ids it never issued, and takes no dollar figure from the browser", async () => {
    const heard = await speak();
    expect((await ask([heard.clip])).summary.sttUsd).toBe(0.0003);
    // Sent again (a retry): already counted.
    expect((await ask([heard.clip])).summary.sttUsd).toBe(0);
    expect((await ask(["not-a-clip", 42, { usd: 5 }])).summary.sttUsd).toBe(0);
    expect((await ask({ sttUsd: 5 })).summary.sttUsd).toBe(0);
    // A typed question: chat models only.
    expect((await ask()).summary.models).toEqual(["m"]);
    expect(sttCalls).toBe(2);
  });
});
