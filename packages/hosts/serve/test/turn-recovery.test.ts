// A reply cut off on its way to the browser, after its turn already changed the board. The client sends a key with
// each question; the server keeps what the turn did under it. Asking about the key says what happened, and asking the
// same question again with the same key (Retry) answers from the record: no model call, no second edit. The next
// turn's prompt, and list_versions, say by title what was removed and when, so the chat can answer someone whose open
// page still shows the widget. The model is a stub that removes a widget and says so.
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Host, type Provider, buildProvider, configSchema, createApp, openConfig, registerLlmAdapter } from "../src";

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

type Part = { type: string; delta?: string; output?: any; data?: any };
const partsOf = async (res: Response) =>
  (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Part);
const textOf = (parts: Part[]) => parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");

describe("a turn whose reply was cut off", () => {
  let server: Server;
  let host: Host;
  let close: () => Promise<void>;
  let base: string;
  // The stub's script, one entry per model call, and the system prompt each call was given.
  const script: unknown[][] = [];
  const prompts: string[] = [];

  beforeAll(async () => {
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack, source: "data" }] }), tmpdir());
    host = opened.hosts[0]!;
    close = opened.close;
    const model = new MockLanguageModelV4({
      doStream: async (o: { prompt: { role: string; content: unknown }[] }) => {
        prompts.push(o.prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n"));
        return stream(script.shift() ?? say("Done."));
      },
    });
    registerLlmAdapter({ kind: "recovery-stub", defaultBaseUrl: "mock:", build: () => model });
    const providers: Provider[] = [{ ...buildProvider({ name: "stub", kind: "recovery-stub", model: "m", pricing: { input: 1, output: 2 } }), available: true }];
    server = createServer(createApp([host], { providers }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${host.name}`;
    await host.store.create({ id: "cut", pack: host.pack, title: "Tasks" });
    const text = (id: string, title: string) => ({ op: "add_widget" as const, id, widget: { kind: "text" as const, title, body: title }, placement: { place: "bottom", width: "third" as const } });
    expect((await host.store.patch({ id: "cut", ops: [text("a", "Task records"), text("b", "Tasks by team")], catalogue: host.catalogue!, source: "seed" })).ok).toBe(true);
  });
  afterAll(async () => {
    server.close();
    await close();
  });

  const ask = (question: string, turnKey?: string) =>
    fetch(`${base}/cut/chat?review=off`, { method: "POST", body: JSON.stringify({ messages: [{ id: `u${Date.now()}`, role: "user", parts: [{ type: "text", text: question }] }], ...(turnKey ? { turnKey } : {}) }) });

  it("keeps what the turn did under the client's key, and says so when asked", async () => {
    script.push(tool("remove_widget", { id: "b" }), say("I removed “Tasks by team”."));
    const parts = await partsOf(await ask("delete the tasks by team chart", "key-remove-1"));
    expect(parts.find((p) => p.type === "tool-output-available")?.output).toMatchObject({ applied: true });
    expect((await host.store.get("cut"))!.version).toBe(3);

    const res = await fetch(`${base}/cut/turn?key=key-remove-1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: 3,
      turn: { state: "done", from: 2, to: 3, changes: { added: [], removed: ["Tasks by team"], changed: [], other: false }, reply: "I removed “Tasks by team”." },
    });
  });

  it("answers the same key again from the record: no model call, and the edit is not made twice", async () => {
    const calls = prompts.length;
    const parts = await partsOf(await ask("delete the tasks by team chart", "key-remove-1"));
    expect(prompts.length).toBe(calls);
    expect(parts.find((p) => p.type === "data-recovered")?.data).toMatchObject({ state: "done", from: 2, to: 3, changes: { removed: ["Tasks by team"] } });
    expect(textOf(parts)).toBe("I removed “Tasks by team”.");
    expect(parts.filter((p) => p.type === "tool-output-available")).toEqual([]);
    expect((await host.store.get("cut"))!.version).toBe(3);
  });

  it("knows no turn under a key it was never sent, and still gives the board's version", async () => {
    const res = await fetch(`${base}/cut/turn?key=never-sent-9`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ version: 3, error: "no such turn" });
    // A key that is not a key is no key at all.
    expect((await fetch(`${base}/cut/turn?key=..%2F..`)).status).toBe(404);
  });

  it("tells the next turn what was removed, when and by whom, and list_versions names it by title", async () => {
    script.push(tool("list_versions", { limit: 5 }), say("It was removed in v3."));
    const parts = await partsOf(await ask("where is the tasks by team chart? I can still see it", "key-where-1"));
    const prompt = prompts.at(-2)!;
    expect(prompt).toContain("RECENTLY REMOVED FROM THIS BOARD");
    expect(prompt).toMatch(/- “Tasks by team”: removed in v3, \d{4}-\d{2}-\d{2} \d{2}:\d{2}, by the chat/);
    expect(prompt).toContain("never say it does not exist");
    const versions = parts.find((p) => p.type === "tool-output-available")?.output.versions as { version: number; changed?: string[] }[];
    expect(versions[0]).toMatchObject({ version: 3, changed: ["removed “Tasks by team”"] });
  });

  it("runs a question without a key as before", async () => {
    script.push(say("Two tasks."));
    expect(textOf(await partsOf(await ask("how many?")))).toBe("Two tasks.");
  });
});
