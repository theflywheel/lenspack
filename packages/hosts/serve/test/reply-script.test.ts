import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { type ToolSet, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Provider, UNREADABLE, buildProvider, configSchema, createApp, keepReplyScripts, openConfig, registerLlmAdapter, replyScripts } from "../src";

// A reply never shows a script the user neither wrote in nor picked. The case it comes from: on
// "auto", after a turn asked and answered in Hindi, an English question got a first line in Khmer
// ("can't compute … I'll answer in English") and then the English answer.

const finish = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } } as const;
const model = (deltas: string[]) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "text-start", id: "t" });
          for (const delta of deltas) c.enqueue({ type: "text-delta", id: "t", delta });
          c.enqueue({ type: "text-end", id: "t" });
          c.enqueue(finish);
          c.close();
        },
      }),
    }),
  });

const HINDI_QUESTION = "अच्छा, कौन से वॉर्ड में बच्चों को सबसे ज्यादा दवाइयाँ मिली हैं?";
const ENGLISH_QUESTION = "burn rate of a facility basis consumption?";
// The Khmer line split mid-word across chunks, as a model streams it.
const KHMER_THEN_ENGLISH = ["ពុំអាចគណនា burn rate ក្នុងមួយ", " facility បានទេ។ ខ្ញុំសូមឆ្លើយជាភាសាអង់គ្លេស។\n", "\nI can't give a burn rate", " per facility from this data.\n- **Stock is per team**, not per facility."];

async function run(deltas: string[], texts: string[], picked?: string) {
  const r = streamText({ model: model(deltas), prompt: "q", experimental_transform: keepReplyScripts<ToolSet>(replyScripts(texts, picked)) });
  let streamed = "";
  for await (const part of r.stream) if (part.type === "text-delta") streamed += part.text;
  return { streamed, text: await r.text };
}

describe("the scripts a reply may use", () => {
  it("is Latin, the scripts the user wrote in, and those of the language they picked", () => {
    expect(replyScripts([ENGLISH_QUESTION])).toEqual(["latin"]);
    expect(replyScripts([HINDI_QUESTION, ENGLISH_QUESTION], "auto").sort()).toEqual(["devanagari", "latin"]);
    expect(replyScripts([ENGLISH_QUESTION], "hi").sort()).toEqual(["devanagari", "latin"]);
    expect(replyScripts(["Quantas doses?"], "pt")).toEqual(["latin"]);
  });
});

describe("a reply line in a script the user did not use", () => {
  it("is dropped, with the gap after it, and the English answer streams on; the recorded text matches", async () => {
    const { streamed, text } = await run(KHMER_THEN_ENGLISH, [HINDI_QUESTION, ENGLISH_QUESTION], "auto");
    expect(streamed).toBe("I can't give a burn rate per facility from this data.\n- **Stock is per team**, not per facility.");
    expect(text).toBe(streamed);
  });

  it("keeps Hindi in a chat the user wrote Hindi in, a table of Latin names included", async () => {
    const reply = ["सबसे ज्यादा बच्चों को टीका **Kardi** वॉर्ड में लगा: 3,773 बच्चे।\n", "| वॉर्ड | बच्चे |\n| Kardi | 3,773 |\n| Cheberu | 3,215 |"];
    const { streamed } = await run(reply, [HINDI_QUESTION]);
    expect(streamed).toBe(reply.join(""));
  });

  it("drops Hindi in a chat that was English only, and a short last line is judged too", async () => {
    const { streamed } = await run(["Kukah had the highest coverage.\n", "धन्यवाद"], [ENGLISH_QUESTION]);
    expect(streamed).toBe("Kukah had the highest coverage.\n");
  });

  it("says so in one line when nothing is left, rather than ending blank", async () => {
    const { streamed } = await run(["ពុំអាចគណនាបានទេ។ ខ្ញុំសូមឆ្លើយ។"], [ENGLISH_QUESTION]);
    expect(streamed).toBe(UNREADABLE);
  });
});

describe("the chat route", () => {
  let server: Server;
  let close: () => Promise<void>;
  let base: string;

  beforeAll(async () => {
    const pack = fileURLToPath(new URL("../../../../examples/tickets/pack.yaml", import.meta.url));
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack, source: "data" }] }), tmpdir());
    const host = opened.hosts[0]!;
    close = opened.close;
    await host.store.create({ id: "scripts", pack: host.pack, title: "Scripts" });
    registerLlmAdapter({ kind: "reply-script-mock", defaultBaseUrl: "mock:", build: () => model(KHMER_THEN_ENGLISH) });
    const provider: Provider = { ...buildProvider({ name: "mock", kind: "reply-script-mock", model: "m" }), available: true };
    server = createServer(createApp([host], { providers: [provider] }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${host.name}`;
  });
  afterAll(async () => {
    server.close();
    await close();
  });

  it("replays the lab turn on auto: no Khmer reaches the panel", async () => {
    const say = (id: string, role: "user" | "assistant", text: string) => ({ id, role, parts: [{ type: "text", text }] });
    const messages = [say("u1", "user", HINDI_QUESTION), say("a1", "assistant", "सबसे ज्यादा बच्चों को टीका Kardi वॉर्ड में लगा।"), say("u2", "user", ENGLISH_QUESTION)];
    const res = await fetch(`${base}/scripts/chat?review=off`, { method: "POST", body: JSON.stringify({ messages, language: "auto" }) });
    const deltas = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; delta?: string })
      .filter((e) => e.type === "text-delta")
      .map((e) => e.delta)
      .join("");
    expect(deltas).toContain("I can't give a burn rate per facility");
    expect(deltas).not.toMatch(/\p{Script=Khmer}/u);
  });
});
