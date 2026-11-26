import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { type AuditEvent, type Provider, adminSettings, buildProvider, configSchema, createApp, openConfig, registerLlmAdapter, reviewSystem, PROMPT_VERSION } from "../src";

const pack = fileURLToPath(new URL("../../../../examples/tickets/pack.yaml", import.meta.url));
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stream = (parts: unknown[]) => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) });
const text = (t: string) => stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: t }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }]);

// Round one asks which reading is meant; round two writes the short question.
function asker(prompts: string[]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async (opts) => {
      step += 1;
      prompts.push(JSON.stringify(opts.prompt));
      if (step % 2 === 1)
        return stream([
          { type: "tool-call", toolCallId: `c${step}`, toolName: "clarify", input: JSON.stringify({ pattern: "open tickets", readings: "Not closed: every ticket not yet closed | Waiting on us: open and not waiting on the customer", ask: true }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
        ]);
      return text("Do you mean every ticket not yet closed, or only those waiting on us?");
    },
    doGenerate: async () => ({ content: [{ type: "text", text: '{"satisfied": true}' }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
  });
}

describe("clarify", () => {
  it("moved the prompt's version", () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(26);
  });

  it("asks with quick replies, logs the open question, counts the reply picked, and records it all in the audit line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-clarify-"));
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack, source: "data" }] }), tmpdir());
    const host = opened.hosts[0]!;
    const admin = adminSettings(dir, {}, {});
    const prompts: string[] = [];
    const model = asker(prompts);
    registerLlmAdapter({ kind: "clarify-mock", defaultBaseUrl: "mock:", build: () => model });
    const providers: Provider[] = [{ ...buildProvider({ name: "m", kind: "clarify-mock", model: "m" }), available: true }];
    const review = reviewSystem({ stateDir: dir, hosts: [{ name: host.name, pack: host.pack, connector: host.connector, ctx: host.ctx }], features: admin.features, settings: admin.settings, providers: () => providers });
    const lines: AuditEvent[] = [];
    const server = createServer(createApp([host], { providers, definitions: review.turn, review: () => false, audit: (e) => lines.push(e) }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${host.name}`;
    await host.store.create({ id: "b", pack: host.pack, title: "Tickets" });
    const chat = (body: Record<string, unknown>) => fetch(`${base}/b/chat?model=m`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.text());
    try {
      const out = await chat({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "How many open tickets?" }] }] });
      expect(prompts[0]).toContain("clarify");
      const part = out.split("\n").filter((l) => l.startsWith("data: ") && l.includes('"data-clarify"')).map((l) => JSON.parse(l.slice(6)))[0];
      expect(part.data.options.map((o: { label: string }) => o.label)).toEqual(["Not closed", "Waiting on us"]);
      const [q] = await review.questions(host.name).list("open");
      expect(q).toMatchObject({ pattern: "open tickets", sources: ["turn"], examples: ["How many open tickets?"] });
      expect(part.data.question).toBe(q!.id);
      const line = lines.find((l) => l.action === "chat-turn")!;
      expect(JSON.parse(line.detail!).clarify).toMatchObject({ asked: true });
      // The person picks a button: the reply is counted against that reading.
      await chat({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "How many open tickets?" }] }, { id: "a1", role: "assistant", parts: [{ type: "text", text: "Which?" }] }, { id: "u2", role: "user", parts: [{ type: "text", text: "Not closed: every ticket not yet closed" }] }], quickReply: { question: q!.id, option: "Not closed" } });
      expect((await review.questions(host.name).get(q!.id)).choices).toEqual({ "Not closed": 1 });
      expect(JSON.parse(lines.filter((l) => l.action === "chat-turn")[1]!.detail!).quickReply).toEqual({ question: q!.id, option: "Not closed" });
      // Switched off: no tool and no rule in the prompt.
      admin.features.update({ clarify: false });
      prompts.length = 0;
      await chat({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }] });
      expect(prompts[0]).not.toContain('"clarify"');
    } finally {
      server.close();
      await opened.close();
    }
  });
});
