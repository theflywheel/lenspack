import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { type Provider, buildProvider, configSchema, createApp, openConfig, registerLlmAdapter } from "../src";

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

// Renames the board once, then says so; the reviewer (a generate call) says it's fine.
function renamer() {
  let step = 0;
  let reviews = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      step += 1;
      return step % 2 === 1
        ? stream([
            { type: "tool-call", toolCallId: `c${step}`, toolName: "rename_board", input: JSON.stringify({ title: `Renamed ${step}` }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
          ])
        : stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Renamed." }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }]);
    },
    doGenerate: async () => {
      reviews += 1;
      return { content: [{ type: "text", text: '{"satisfied": true, "note": "fine"}' }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
  });
  return { model, reviews: () => reviews };
}

describe("the reviewer switch", () => {
  it("a deployment's review: () => false skips the reviewer on every turn; on, it reviews an edit", async () => {
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack, source: "data" }] }), tmpdir());
    const host = opened.hosts[0]!;
    const m = renamer();
    registerLlmAdapter({ kind: "review-switch", defaultBaseUrl: "mock:", build: () => m.model });
    const providers: Provider[] = [{ ...buildProvider({ name: "r", kind: "review-switch", model: "m" }), available: true }];
    let reviewOn = false;
    const server = createServer(createApp([host], { providers, review: () => reviewOn }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${host.name}`;
    const turn = async (board: string) => {
      await host.store.create({ id: board, pack: host.pack, title: "Start" });
      const res = await fetch(`${base}/${board}/chat?model=r`, { method: "POST", body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "rename it" }] }] }) });
      return res.text();
    };
    try {
      const off = await turn("off");
      expect(off).not.toContain('"data-review"');
      expect(m.reviews()).toBe(0);
      reviewOn = true;
      await turn("on");
      expect(m.reviews()).toBeGreaterThan(0);
    } finally {
      server.close();
      await opened.close();
    }
  });
});
