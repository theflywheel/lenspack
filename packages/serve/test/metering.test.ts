import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateText, jsonSchema, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type CallRecord,
  type Host,
  type Pricing,
  type Provider,
  addUsageSink,
  budgetReport,
  buildProvider,
  configSchema,
  createApp,
  jsonlUsageSink,
  openConfig,
  overBudget,
  probe,
  readUsageFile,
  registerLlmAdapter,
  turnCost,
  usageLedger,
  withMeter,
} from "../src";

// Every model here is a mock behind a test adapter, built by buildProvider
// like any other: the metering under test is the wrapper every provider gets.

type Model = InstanceType<typeof MockLanguageModelV4>;
let kinds = 0;
function provider(model: Model, pricing?: Pricing, name = "mock"): Provider {
  const kind = `meter-mock-${++kinds}`;
  registerLlmAdapter({ kind, defaultBaseUrl: "mock:", build: () => model });
  return { ...buildProvider({ name, kind, model: "mock-1", ...(pricing ? { pricing } : {}) }), available: true };
}

const usage = (input: number, read: number, write: number, output: number, reasoning = 0) => ({
  inputTokens: { total: input, noCache: input - read - write, cacheRead: read, cacheWrite: write },
  outputTokens: { total: output, text: output - reasoning, reasoning },
});
const generated = (text: string, u = usage(100, 0, 0, 10)) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: u, warnings: [] });
const streamed = (parts: unknown[]) => ({ stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) as never });
const textStream = (text: string, u = usage(100, 0, 0, 10)) =>
  streamed([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: u }]);
const toolCallStream = (u = usage(100, 0, 0, 10)) =>
  streamed([{ type: "tool-call", toolCallId: "c1", toolName: "look", input: "{}" }, { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: u }]);
const sonnetRates: Pricing = { input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5 };

describe("metering at the model", () => {
  it("records a generate call with its scope, tokens by kind and price", async () => {
    const p = provider(new MockLanguageModelV4({ doGenerate: generated("ok", usage(1_000_000, 500_000, 300_000, 100_000, 40_000)) }), sonnetRates, "sonnet");
    const calls: CallRecord[] = [];
    await withMeter({ role: "eval", user: "u1", pack: "p1", collect: calls }, () => generateText({ model: p.languageModel, prompt: "hi" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: "sonnet", model: "mock-1", kind: p.kind, role: "eval", user: "u1", pack: "p1",
      inputTokens: 1_000_000, cachedInputTokens: 500_000, cacheWriteTokens: 300_000, outputTokens: 100_000, reasoningTokens: 40_000,
      priced: true, ok: true,
    });
    // 200K plain at $2, 500K read at $0.20, 300K written at $2.50, 100K out at $10.
    expect(calls[0]!.usd).toBeCloseTo(0.4 + 0.1 + 0.75 + 1, 6);
    expect(calls[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  it("records a stream once its finish part has passed", async () => {
    const p = provider(new MockLanguageModelV4({ doStream: textStream("hello", usage(300, 200, 0, 20)) }), sonnetRates);
    const calls: CallRecord[] = [];
    const text = await withMeter({ role: "build", collect: calls }, async () => streamText({ model: p.languageModel, prompt: "hi" }).text);
    expect(text).toBe("hello");
    expect(calls).toEqual([expect.objectContaining({ role: "build", inputTokens: 300, cachedInputTokens: 200, outputTokens: 20, ok: true })]);
  });

  it("records a failed call as failed, and still throws", async () => {
    const p = provider(new MockLanguageModelV4({ doGenerate: async () => { throw new Error("boom: 529 overloaded"); } }), sonnetRates);
    const calls: CallRecord[] = [];
    await expect(withMeter({ role: "review", collect: calls }, () => generateText({ model: p.languageModel, prompt: "hi", maxRetries: 0 }))).rejects.toThrow(/boom/);
    expect(calls).toEqual([expect.objectContaining({ ok: false, error: "boom: 529 overloaded", usd: 0, inputTokens: 0 })]);
  });

  it("reports a provider with no price as unpriced, never as $0", async () => {
    const p = provider(new MockLanguageModelV4({ doGenerate: generated("ok") }));
    const calls: CallRecord[] = [];
    await withMeter({ role: "build", collect: calls }, () => generateText({ model: p.languageModel, prompt: "hi" }));
    expect(calls[0]).toMatchObject({ usd: null, priced: false, inputTokens: 100 });
    expect(turnCost(calls).total).toMatchObject({ calls: 1, unpriced: 1, usd: 0 });
    const ledger = usageLedger();
    ledger.record(calls[0]!);
    expect(ledger.report().total).toMatchObject({ unpriced: 1, usd: 0 });
  });

  it("counts a call made outside any scope, as role other, in the process-wide sinks", async () => {
    const seen: CallRecord[] = [];
    const remove = addUsageSink({ record: (r) => seen.push(r) });
    try {
      const p = provider(new MockLanguageModelV4({ doGenerate: generated("ok") }), sonnetRates);
      await generateText({ model: p.languageModel, prompt: "hi" });
      await probe(p);
      expect(seen.map((r) => r.role)).toEqual(["other", "probe"]);
    } finally {
      remove();
    }
  });

  it("keeps the scope through streamText's tool loop, whoever reads the stream", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolCallStream(), textStream("done")] });
    const p = provider(model, sonnetRates);
    const tools = { look: tool({ description: "look", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => ({ ok: true }) }) };
    const calls: CallRecord[] = [];
    // Started in the scope, read after it has returned: the second step is started by the reader.
    const result = withMeter({ role: "build", turn: "turn-1", collect: calls }, () => streamText({ model: p.languageModel, prompt: "hi", tools, stopWhen: stepCountIs(5) }));
    expect(await result.text).toBe("done");
    expect(model.doStreamCalls).toHaveLength(2);
    expect(calls.map((r) => [r.role, r.turn])).toEqual([
      ["build", "turn-1"],
      ["build", "turn-1"],
    ]);
  });

  it("nests scopes: a round's role inside a turn's user and pack", async () => {
    const p = provider(new MockLanguageModelV4({ doGenerate: generated("ok") }), sonnetRates);
    const calls: CallRecord[] = [];
    await withMeter({ user: "u", pack: "p", turn: "t", collect: calls }, async () => {
      await withMeter({ role: "build" }, () => generateText({ model: p.languageModel, prompt: "a" }));
      await withMeter({ role: "review" }, () => generateText({ model: p.languageModel, prompt: "b" }));
    });
    expect(calls.map((r) => [r.role, r.user, r.pack, r.turn])).toEqual([
      ["build", "u", "p", "t"],
      ["review", "u", "p", "t"],
    ]);
    expect(turnCost(calls).models.map((m) => m.role)).toEqual(["build", "review"]);
  });
});

describe("the usage file", () => {
  it("keeps one JSON line per call, and gives today's back to a fresh ledger", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "lenspack-usage-")), "logs", "usage.jsonl");
    const p = provider(new MockLanguageModelV4({ doGenerate: generated("ok", usage(1_000_000, 0, 0, 0)) }), sonnetRates, "sonnet");
    await withMeter({ role: "build", user: "u1", pack: "p1", board: "b1", turn: "t1", sinks: [jsonlUsageSink(file)] }, () => generateText({ model: p.languageModel, prompt: "hi" }));
    // A day-old line and a torn last line, as a crash would leave it.
    const old = { ...JSON.parse(readFileSync(file, "utf8")), at: "2020-01-01T00:00:00.000Z" };
    writeFileSync(file, `${JSON.stringify(old)}\n${readFileSync(file, "utf8")}{"at":"20`);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(JSON.parse(lines[1]!)).toMatchObject({ provider: "sonnet", model: "mock-1", role: "build", user: "u1", pack: "p1", board: "b1", turn: "t1", inputTokens: 1_000_000, usd: 2, priced: true, ok: true });
    const today = readUsageFile(file);
    expect(today).toHaveLength(1);
    const ledger = usageLedger();
    ledger.restore(today);
    expect(ledger.spent()).toBeCloseTo(2, 6);
    expect(ledger.spent({ user: "u1" })).toBeCloseTo(2, 6);
    expect(ledger.report().total).toMatchObject({ turns: 1, calls: 1 });
  });
});

describe("the budget", () => {
  const record = (over: Partial<CallRecord>): CallRecord => ({
    at: new Date().toISOString(), provider: "sonnet", model: "m", kind: "anthropic", role: "build",
    inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, usd: 1, priced: true, ms: 1, ok: true, ...over,
  });

  it("stops a user at their cap and everyone at the server's; a probe counts toward the server only", () => {
    const ledger = usageLedger();
    ledger.record(record({ user: "a", usd: 3 }));
    ledger.record(record({ role: "probe", usd: 5 }));
    expect(overBudget(ledger, undefined, "a")).toBeNull();
    expect(overBudget(ledger, { usdPerUserPerDay: 3 }, "a")).toMatch(/You have used today's chat budget \(US\$3\.00 of US\$3\.00\)/);
    expect(overBudget(ledger, { usdPerUserPerDay: 3 }, "b")).toBeNull();
    expect(overBudget(ledger, { usdPerDay: 8 }, "b")).toMatch(/today's budget for this server \(US\$8\.00 of US\$8\.00\)/);
    expect(overBudget(ledger, { usdPerDay: 8.01 }, "b")).toBeNull();
    // Yesterday's spend is yesterday's.
    expect(overBudget(ledger, { usdPerDay: 1 }, "a", new Date(Date.now() + 86_400_000))).toBeNull();
  });

  it("reports the caps beside today's spend, the server's and each user's; a probe has no user", () => {
    const ledger = usageLedger();
    ledger.record(record({ user: "a", usd: 1.25, effort: "high" }));
    ledger.record(record({ user: "a", usd: 0.5, role: "review", effort: "high" }));
    ledger.record(record({ user: "b", usd: 2 }));
    ledger.record(record({ role: "probe", usd: 0.25 }));
    expect(budgetReport(ledger, { usdPerDay: 25, usdPerUserPerDay: 10 })).toEqual({ usdPerDay: 25, usdPerUserPerDay: 10, day: new Date().toISOString().slice(0, 10), spent: 4, users: { a: 1.75, b: 2 } });
    expect(budgetReport(ledger, { usdPerDay: 25 }, new Date(Date.now() + 86_400_000))).toMatchObject({ spent: 0, users: {} });
    // The effort a call ran at, by provider, where one was recorded.
    const a = ledger.report().turns.find((t) => t.user === "a")!;
    expect(a.byEffort).toEqual({ sonnet: { high: expect.objectContaining({ calls: 2, usd: 1.75 }) } });
    expect(ledger.report().turns.find((t) => t.user === "b")!.byEffort).toEqual({});
  });

  const tickets = fileURLToPath(new URL("../../../examples/tickets/pack.yaml", import.meta.url));
  let host: Host;
  let close: () => Promise<void>;
  const servers: Server[] = [];
  beforeAll(async () => {
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack: tickets, source: "data" }], budget: { usdPerDay: 5 }, usage: "./usage.jsonl" }), tmpdir());
    host = opened.hosts[0]!;
    close = opened.close;
    await host.store.create({ id: "b", pack: host.pack, title: "Overview" });
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    await close();
  });

  it("answers chat with 429 before any model call once today's spend is over the cap", async () => {
    const model = new MockLanguageModelV4({ doStream: textStream("never") });
    const ledger = usageLedger();
    ledger.record(record({ user: "someone else", usd: 5 }));
    const server = createServer(createApp([host], { providers: [provider(model, sonnetRates)], ledger, budget: { usdPerDay: 5 } }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const res = await fetch(`${base}/${host.name}/b/chat`, { method: "POST", body: JSON.stringify({ messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "hi" }] }] }) });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/today's budget for this server .* resets at 00:00 UTC/);
    expect(model.doStreamCalls).toHaveLength(0);
    // Whoever may read usage sees the caps beside it; a server with no budget says nothing of one.
    expect((await (await fetch(`${base}/_usage`)).json()).budget).toMatchObject({ usdPerDay: 5, spent: 5, users: { "someone else": 5 } });
    const open = createServer(createApp([host], { ledger }));
    servers.push(open);
    await new Promise<void>((r) => open.listen(0, "127.0.0.1", r));
    expect(await (await fetch(`http://127.0.0.1:${(open.address() as { port: number }).port}/api/_usage`)).json()).not.toHaveProperty("budget");
  });
});
