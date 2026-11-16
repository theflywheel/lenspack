import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type LanguageModelUsage, type ToolSet, generateText, jsonSchema, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { type Host, type LlmAdapter, type Provider, REVIEW_PROMPT, buildProvider, configSchema, createApp, effortFor, llmAdapter, openConfig, publicView, registerLlmAdapter, reviewTurn, shapeCall } from "../src";
import { usageLedger, usageOf } from "../src/metering";

// No model is called: every request is caught at fetch and answered from a
// canned response, so what is asserted is the exact body each provider sends.

type Sent = { url: string; headers: Record<string, string>; body: any };

/** A fetch that records each request and answers with the next canned response. */
function recorder(...responses: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) });
    return (responses[Math.min(sent.length - 1, responses.length - 1)] ?? (() => new Response("{}", { status: 500 })))();
  };
  return { sent, fetch: fetch as typeof globalThis.fetch };
}

const anthropicText = (text: string, usage: Record<string, number> = { input_tokens: 10, output_tokens: 2 }) => () =>
  Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage });

/** Anthropic's streaming events, as server-sent events. */
const sse = (events: Record<string, unknown>[]) => () =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

const openAIText = (text: string) => () =>
  Response.json({ id: "c1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });

const sonnet = { name: "sonnet", kind: "anthropic", model: "claude-sonnet-5-5", apiKey: "test-key" };
const echoTools: ToolSet = {
  first: tool({ description: "first", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
  last: tool({ description: "last", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
};

describe("the adapter registry", () => {
  it("defaults to openai-compatible, so a config written before kinds existed means the same", () => {
    expect(llmAdapter().kind).toBe("openai-compatible");
    const p = buildProvider({ name: "old", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" });
    expect(p.kind).toBe("openai-compatible");
    expect(p.prepare).toBeUndefined();
    expect(p.apiKey).toBeUndefined();
  });

  it("names the known kinds when asked for one it does not have", () => {
    expect(() => buildProvider({ name: "x", kind: "nope", model: "m" })).toThrow(/No LLM adapter of kind "nope"; registered: openai-compatible, anthropic/);
  });

  it("builds a provider with a registered adapter, its prices and its call shaping", () => {
    const seen: string[] = [];
    const adapter: LlmAdapter = {
      kind: "test-kind",
      defaultBaseUrl: "http://test",
      build: (cfg) => (seen.push(cfg.model), new MockLanguageModelV4()),
      pricing: () => ({ input: 1, output: 2 }),
      prepare: (call) => ({ system: call.system.join(" | "), messages: call.messages }),
    };
    registerLlmAdapter(adapter);
    const p = buildProvider({ name: "t", kind: "test-kind", model: "tm" });
    expect(seen).toEqual(["tm"]);
    expect(p.pricing).toEqual({ input: 1, output: 2 });
    expect(shapeCall(p, { system: ["a", "b"], messages: [] }).system).toBe("a | b");
  });

  it("refuses a setting meant for another kind rather than dropping it", () => {
    expect(() => buildProvider({ ...sonnet, extraBody: { reasoning: {} } })).toThrow(/extraBody is for openai-compatible providers, and this one is anthropic/);
    expect(() => buildProvider({ name: "o", baseUrl: "http://h/v1", model: "m", anthropic: { effort: "low" } })).toThrow(/anthropic is for anthropic providers/);
  });

  it("needs a baseUrl only where the adapter has no default", () => {
    expect(() => buildProvider({ name: "o", model: "m" })).toThrow(/openai-compatible provider needs a baseUrl/);
    expect(() => buildProvider(sonnet)).not.toThrow();
  });
});

describe("the openai-compatible adapter", () => {
  it("sends the system prompt as written, extraBody merged, and no cache markers", async () => {
    const { sent, fetch } = recorder(openAIText("ok"));
    const p = buildProvider({ name: "o", baseUrl: "http://llm.test/v1", apiKey: "k", model: "m", extraBody: { reasoning: { effort: "low" } }, fetch });
    const call = shapeCall(p, { system: ["STABLE.", "\n\nBOARD."], messages: [{ role: "user", content: "hi" }], tools: echoTools, loop: true });
    await generateText({ model: p.languageModel, ...call });
    expect(sent[0]!.url).toBe("http://llm.test/v1/chat/completions");
    expect(sent[0]!.headers["x-title"]).toBe("lenspack");
    expect(sent[0]!.body.messages[0]).toEqual({ role: "system", content: "STABLE.\n\nBOARD." });
    expect(sent[0]!.body.reasoning).toEqual({ effort: "low" });
    expect(sent[0]!.body.max_tokens).toBeUndefined();
    expect(JSON.stringify(sent[0]!.body)).not.toMatch(/cache_control|cacheControl/);
  });
});

describe("the anthropic adapter", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prices Sonnet 5.5 from the published rates, cache writes by TTL, and lets a config's own price win", () => {
    expect(buildProvider(sonnet).pricing).toEqual({ input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 });
    expect(buildProvider({ ...sonnet, anthropic: { cacheTtl: "1h" } }).pricing).toMatchObject({ cacheWrite: 4 });
    expect(buildProvider({ ...sonnet, pricing: { input: 9, output: 9 } }).pricing).toEqual({ input: 9, output: 9 });
    expect(buildProvider({ ...sonnet, model: "claude-next" }).pricing).toBeUndefined();
  });

  it("sends Sonnet 5.5 a Messages request: adaptive thinking that drops stale blocks, medium effort, refusal fallback, a cap", async () => {
    const { sent, fetch } = recorder(anthropicText("ok"));
    const p = buildProvider({ ...sonnet, fetch });
    const out = await generateText({ model: p.languageModel, prompt: "hi" });
    expect(out.text).toBe("ok");
    const [req] = sent;
    expect(req!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req!.headers["x-api-key"]).toBe("test-key");
    expect(req!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req!.headers["anthropic-beta"]?.split(",")).toEqual(expect.arrayContaining(["thinking-binding-controls-2026-08-01", "server-side-fallback-2026-07-01"]));
    expect(req!.body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort: "medium" },
      fallbacks: "default",
    });
    expect(req!.body.temperature).toBeUndefined();
  });

  it("gives a caller's own cap room for thinking, and takes settings from the config", async () => {
    const { sent, fetch } = recorder(anthropicText("ok"));
    const p = buildProvider({ ...sonnet, anthropic: { effort: "low", thinking: "between_tools", thinkingAllowance: 1000 }, fetch });
    await generateText({ model: p.languageModel, prompt: "hi", maxOutputTokens: 400 });
    expect(sent[0]!.body.max_tokens).toBe(1400);
    expect(sent[0]!.body.thinking).toEqual({ type: "between_tools" });
    expect(sent[0]!.body.output_config).toEqual({ effort: "low" });
    // Between-tools thinking cannot drop stale blocks, and Anthropic's fallback would re-send it to a model that refuses it.
    expect(sent[0]!.body.fallbacks).toBeUndefined();
  });

  it("lists the efforts each model takes, and its default, in the public view", () => {
    const efforts = (cfg: object) => publicView(buildProvider({ ...sonnet, ...cfg })).efforts;
    expect(efforts({})).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], default: "medium" });
    expect(efforts({ model: "claude-sonnet-4-6" })).toEqual({ levels: ["low", "medium", "high", "max"], default: "medium" });
    expect(efforts({ anthropic: { effort: "low", thinking: "between_tools" } })).toEqual({ levels: ["low", "medium", "high"], default: "low" });
    // No effort setting: nothing to choose, so nothing shown.
    expect(efforts({ model: "claude-haiku-4-5" })).toBeUndefined();
    expect(publicView(buildProvider({ name: "old", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" }))).not.toHaveProperty("efforts");
    expect(effortFor(buildProvider(sonnet), "high")).toBe("high");
    expect(effortFor(buildProvider(sonnet), null)).toBe("medium");
    expect(() => effortFor(buildProvider({ ...sonnet, model: "claude-sonnet-4-6" }), "xhigh")).toThrow(/effort "xhigh" is not one sonnet takes: low, medium, high, max/);
  });

  it("sends a call's own effort over the provider's, with or without caching", async () => {
    const { sent, fetch } = recorder(anthropicText("ok"));
    for (const anthropic of [{}, { cache: false }]) {
      const p = buildProvider({ ...sonnet, anthropic, fetch });
      await generateText({ model: p.languageModel, ...shapeCall(p, { system: ["S"], messages: [{ role: "user", content: "hi" }], loop: true, effort: "high" }) });
    }
    expect(sent.map((r) => r.body.output_config)).toEqual([{ effort: "high" }, { effort: "high" }]);
    // The loop's breakpoint survives beside the effort.
    expect(sent[0]!.body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("reads the key from a file or ANTHROPIC_API_KEY, and goes through a gateway when given a baseUrl", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "lenspack-key-")), "key");
    writeFileSync(keyFile, "file-key\n");
    const a = recorder(anthropicText("ok"));
    await generateText({ model: buildProvider({ ...sonnet, apiKey: undefined, apiKeyFile: keyFile, baseUrl: "https://gateway.test/anthropic/v1", fetch: a.fetch }).languageModel, prompt: "hi" });
    expect(a.sent[0]!.url).toBe("https://gateway.test/anthropic/v1/messages");
    expect(a.sent[0]!.headers["x-api-key"]).toBe("file-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
    const b = recorder(anthropicText("ok"));
    await generateText({ model: buildProvider({ ...sonnet, apiKey: undefined, fetch: b.fetch }).languageModel, prompt: "hi" });
    expect(b.sent[0]!.headers["x-api-key"]).toBe("env-key");
  });

  it("puts cache breakpoints on the last tool, the stable system part and a loop's tail", async () => {
    const { sent, fetch } = recorder(anthropicText("ok"));
    const p = buildProvider({ ...sonnet, fetch });
    const call = shapeCall(p, { system: ["STABLE.", "\n\nBOARD."], messages: [{ role: "user", content: "hi" }], tools: echoTools, loop: true });
    await generateText({ model: p.languageModel, ...call });
    const body = sent[0]!.body;
    expect(body.system).toEqual([
      { type: "text", text: "STABLE.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "\n\nBOARD." },
    ]);
    expect(body.tools.map((t: any) => [t.name, t.cache_control])).toEqual([
      ["first", undefined],
      ["last", { type: "ephemeral" }],
    ]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("caches a one-shot call's fixed prompt but not its unique tail, and honours cache: false and a 1h TTL", async () => {
    const a = recorder(anthropicText("ok"));
    const one = buildProvider({ ...sonnet, anthropic: { cacheTtl: "1h" }, fetch: a.fetch });
    await generateText({ model: one.languageModel, ...shapeCall(one, { system: ["FIXED."], messages: [{ role: "user", content: "unique" }] }) });
    expect(a.sent[0]!.body.system).toEqual([{ type: "text", text: "FIXED.", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    expect(a.sent[0]!.body.cache_control).toBeUndefined();
    const b = recorder(anthropicText("ok"));
    const off = buildProvider({ ...sonnet, anthropic: { cache: false }, fetch: b.fetch });
    await generateText({ model: off.languageModel, ...shapeCall(off, { system: ["A", "B"], messages: [{ role: "user", content: "x" }], tools: echoTools, loop: true }) });
    expect(JSON.stringify(b.sent[0]!.body)).not.toContain("cache_control");
  });
});

describe("the reviewer through the anthropic adapter", () => {
  it("caches the fixed review prompt, gives its cap room for thinking, and reads the verdict and usage", async () => {
    const { sent, fetch } = recorder(anthropicText('{"satisfied": true, "missing": [], "wrong": [], "note": "fine"}', { input_tokens: 900, cache_read_input_tokens: 1200, output_tokens: 40 }));
    const review = await reviewTurn(buildProvider({ ...sonnet, fetch }), { catalogue: "PACK", instruction: "add a kpi", before: "", after: "", receipt: "v2 added" });
    expect(review).toMatchObject({ satisfied: true, note: "fine" });
    expect(review.usage).toMatchObject({ inputTokens: 2100, inputTokenDetails: { cacheReadTokens: 1200 } });
    expect(sent[0]!.body.system).toEqual([{ type: "text", text: REVIEW_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(sent[0]!.body.max_tokens).toBe(4000 + 4096);
    expect(sent[0]!.body.cache_control).toBeUndefined();
  });
});

describe("pricing a call", () => {
  const usage = (input: number, read: number, write: number, output: number): LanguageModelUsage =>
    ({ inputTokens: input, inputTokenDetails: { noCacheTokens: input - read - write, cacheReadTokens: read, cacheWriteTokens: write }, outputTokens: output, outputTokenDetails: { textTokens: output, reasoningTokens: 0 } }) as LanguageModelUsage;

  it("charges uncached input, cache reads and cache writes each at their own rate", () => {
    // 1M input: 200K plain, 500K read, 300K written; 100K output, at Sonnet 5.5's rates.
    const u = usageOf(usage(1_000_000, 500_000, 300_000, 100_000), { input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 });
    expect(u).toMatchObject({ inputTokens: 1_000_000, cachedInputTokens: 500_000, cacheWriteTokens: 300_000, outputTokens: 100_000, unpriced: 0 });
    expect(u.usd).toBeCloseTo(0.4 + 0.1 + 0.75 + 1, 9);
  });

  it("charges a cache write with no price of its own as plain input, and counts an unpriced call", () => {
    expect(usageOf(usage(1_000_000, 0, 1_000_000, 0), { input: 3, output: 15 }).usd).toBeCloseTo(3, 9);
    expect(usageOf(usage(10, 0, 0, 1))).toMatchObject({ usd: 0, unpriced: 1 });
  });
});

// A whole chat turn through the server: the request the chat sends, and what the turn is metered at.
describe("a chat turn", () => {
  const tickets = fileURLToPath(new URL("../../../examples/tickets/pack.yaml", import.meta.url));
  const servers: Server[] = [];
  let host: Host;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack: tickets, source: "data" }] }), tmpdir());
    host = opened.hosts[0]!;
    close = opened.close;
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    await close();
  });

  async function turn(providers: Provider[], board: string, ledger = usageLedger(), query = "", audit?: (e: { action: string; detail?: string }) => void) {
    await host.store.create({ id: board, pack: host.pack, title: "Overview" });
    const server = createServer(createApp([host], { providers, ledger, ...(audit ? { audit } : {}) }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const res = await fetch(`${base}/${host.name}/${board}/chat?review=off${query}`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "what is on the board?" }] }] }),
    });
    const text = await res.text();
    const parts = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)));
    const report = await (await fetch(`${base}/_usage`)).json();
    const api = await (await fetch(base)).json();
    return { status: res.status, text, parts, report, api };
  }

  it("with a model whose adapter shapes nothing: one system prompt, usage in data-usage and the ledger", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "text-start", id: "t" });
            c.enqueue({ type: "text-delta", id: "t", delta: "It is empty." });
            c.enqueue({ type: "text-end", id: "t" });
            c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } } });
            c.close();
          },
        }),
      },
    });
    // A kind registered for the test: metered by buildProvider like any adapter, with no metering code of its own.
    registerLlmAdapter({ kind: "plain-mock", defaultBaseUrl: "mock:", build: () => model });
    const mock: Provider = { ...buildProvider({ name: "mock", kind: "plain-mock", model: "m", pricing: { input: 1, output: 2 } }), available: true };
    const { parts, report } = await turn([mock], "mock-board");
    const prompt = model.doStreamCalls[0]!.prompt;
    expect(prompt.filter((m) => m.role === "system")).toHaveLength(1);
    expect(prompt[0]!.content).toContain("Rules:");
    const usage = parts.find((p) => p.type === "data-usage")!.data;
    expect(usage.total).toMatchObject({ calls: 1, inputTokens: 1000, outputTokens: 50, usd: (1000 * 1 + 50 * 2) / 1e6, unpriced: 0 });
    expect(usage.models).toEqual([expect.objectContaining({ role: "build", provider: "mock" })]);
    expect(report.total).toMatchObject({ turns: 1, inputTokens: 1000, outputTokens: 50 });
  });

  it("with Sonnet 5.5: a tool loop with thinking passed back, cache breakpoints, and cache reads and writes priced", async () => {
    const usage0 = { input_tokens: 40, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 1 };
    const { sent, fetch } = recorder(
      sse([
        { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: usage0 } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_board", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } },
        { type: "message_stop" },
      ]),
      sse([
        { type: "message_start", message: { id: "m2", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 60, cache_creation_input_tokens: 100, cache_read_input_tokens: 3000, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The board is empty." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: "message_stop" },
      ]),
    );
    const { parts, report } = await turn([{ ...buildProvider({ ...sonnet, fetch }), available: true }], "sonnet-board");
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe("The board is empty.");
    expect(sent).toHaveLength(2);
    for (const { body } of sent) {
      // The pack's stable prompt is cached apart from the board, which changes with every edit.
      expect(body.system).toHaveLength(2);
      expect(body.system[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
      expect(body.system[0].text).toContain("Rules:");
      expect(body.system[1].text).toContain("CURRENT BOARD:");
      expect(body.system[1].cache_control).toBeUndefined();
      expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
      expect(body.tools.slice(0, -1).every((t: any) => !t.cache_control)).toBe(true);
      expect(body.cache_control).toEqual({ type: "ephemeral" });
    }
    // The second step carries the first's thinking block unchanged, then the tool call and its result.
    const [assistant, result] = sent[1]!.body.messages.slice(-2);
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig-1" });
    expect(assistant.content[1]).toMatchObject({ type: "tool_use", id: "toolu_1", name: "get_board" });
    expect(result.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    // Two steps at Sonnet 5.5's published rates: plain input $2, cache reads $0.20, writes $2.50, output $10 per million.
    const usage = parts.find((p) => p.type === "data-usage")!.data;
    expect(usage.total).toMatchObject({ calls: 2, inputTokens: 3040 + 3160, cachedInputTokens: 3000, cacheWriteTokens: 3100, outputTokens: 40 });
    expect(usage.total.usd).toBeCloseTo((100 * 2 + 3000 * 0.2 + 3100 * 2.5 + 40 * 10) / 1e6, 9);
    expect(report.total).toMatchObject({ turns: 1, cachedInputTokens: 3000, cacheWriteTokens: 3100 });
    // Both steps of the tool loop are attributed to the turn's round: the scope survived the loop.
    expect(usage.models).toEqual([expect.objectContaining({ role: "build", provider: "sonnet", calls: 2 })]);
    expect(report.turns[0]).toMatchObject({ pack: host.name, turns: 1, byRole: { build: expect.objectContaining({ calls: 2 }) } });
  });

  it("with ?effort=: sent to a model that takes it, recorded on the call and the audit line, refused when not one it takes", async () => {
    const reply = sse([
      { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
    const { sent, fetch } = recorder(reply);
    const p: Provider = { ...buildProvider({ ...sonnet, fetch }), available: true };
    const audited: { action: string; detail?: string }[] = [];
    const ok = await turn([p], "effort-board", usageLedger(), "&effort=high", (e) => audited.push(e));
    expect(sent[0]!.body.output_config).toEqual({ effort: "high" });
    expect(ok.parts.find((x) => x.type === "data-round")!.data).toMatchObject({ builder: "sonnet", effort: "high" });
    expect(ok.parts.filter((x) => x.type === "text-delta").map((x) => x.delta).join("")).toBe("Done.");
    expect(ok.parts.find((x) => x.type === "data-usage")!.data.models).toEqual([expect.objectContaining({ role: "build", effort: "high", calls: 1, failed: 0 })]);
    expect(JSON.parse(audited.find((e) => e.action === "chat-turn")!.detail!)).toMatchObject({ builder: "sonnet", effort: "high" });
    // GET /api says which efforts the model takes, so the UI can offer them.
    expect(ok.api.models[0]).toMatchObject({ name: "sonnet", efforts: { levels: ["low", "medium", "high", "xhigh", "max"], default: "medium" } });
    // No effort asked for: the provider's default, recorded as such.
    const plain = await turn([p], "effort-default-board");
    expect(sent[1]!.body.output_config).toEqual({ effort: "medium" });
    expect(plain.parts.find((x) => x.type === "data-usage")!.data.models[0]).toMatchObject({ effort: "medium" });
    const bad = await turn([p], "effort-bad-board", usageLedger(), "&effort=extreme");
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.text).error).toMatch(/effort "extreme" is not one sonnet takes: low, medium, high, xhigh, max/);
    expect(sent).toHaveLength(2);
  });

  it("with ?effort= and a model that has no effort setting: ignored", async () => {
    const finish = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } } as const;
    const model = new MockLanguageModelV4({ doStream: { stream: new ReadableStream({ start: (c) => (c.enqueue(finish), c.close()) }) } });
    registerLlmAdapter({ kind: "effortless-mock", defaultBaseUrl: "mock:", build: () => model });
    const p: Provider = { ...buildProvider({ name: "effortless", kind: "effortless-mock", model: "m" }), available: true };
    const { status, parts } = await turn([p], "effortless-board", usageLedger(), "&effort=extreme");
    expect(status).toBe(200);
    expect(parts.find((x) => x.type === "data-round")!.data).not.toHaveProperty("effort");
    expect(model.doStreamCalls[0]!.providerOptions?.anthropic).toBeUndefined();
  });
});

describe("streamText through the anthropic adapter", () => {
  it("streams with the same shaped call the chat uses", async () => {
    const { sent, fetch } = recorder(
      sse([
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]),
    );
    const p = buildProvider({ ...sonnet, fetch });
    const result = streamText({ model: p.languageModel, ...shapeCall(p, { system: ["S"], messages: [{ role: "user", content: "x" }], loop: true }) });
    expect(await result.text).toBe("hi");
    expect(sent[0]!.body.stream).toBe(true);
  });
});
