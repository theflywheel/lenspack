import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { catalogueFrom } from "@lenspack/spec";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Host, type Provider, buildProvider, configSchema, createApp, openConfig, registerLlmAdapter } from "../src";

// What the user changes by hand between two chat turns reaches the model on
// the next turn, read from the version log; nothing calls the model on its own.

const pack = fileURLToPath(new URL("../../../examples/tickets/pack.yaml", import.meta.url));
const text = (title: string) => ({ kind: "text", title, body: title });

describe("changes made by hand between chat turns", () => {
  const servers: Server[] = [];
  let host: Host;
  let close: () => Promise<void>;
  let base: string;
  const prompts: string[] = [];

  beforeAll(async () => {
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack, source: "data" }] }), tmpdir());
    host = opened.hosts[0]!;
    close = opened.close;
    // A model that records the system prompt it was sent and says one word.
    const finish = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } } as const;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt.filter((m) => m.role === "system").map((m) => m.content).join(""));
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "text-start", id: "t" });
              c.enqueue({ type: "text-delta", id: "t", delta: "Noted." });
              c.enqueue({ type: "text-end", id: "t" });
              c.enqueue(finish);
              c.close();
            },
          }),
        };
      },
    });
    registerLlmAdapter({ kind: "changes-mock", defaultBaseUrl: "mock:", build: () => model });
    const provider: Provider = { ...buildProvider({ name: "mock", kind: "changes-mock", model: "m" }), available: true };
    const server = createServer(createApp([host], { providers: [provider] }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${host.name}`;
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    await close();
  });

  const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) })).json();
  const chat = async (board: string, body: Record<string, unknown>) => {
    const res = await fetch(`${base}/${board}/chat?review=off`, { method: "POST", body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "and now?" }] }], ...body }) });
    await res.text();
    return prompts.at(-1)!;
  };

  it("saves a drag with the line the client sent, else what the layouts differ by", async () => {
    await host.store.create({ id: "drag", pack: host.pack, title: "Drag" });
    const added = await post("/drag/ops", { ops: [{ op: "add_widget", id: "a", widget: text("First"), placement: { width: "half" } }, { op: "add_widget", id: "b", widget: text("Second"), placement: { width: "half" } }] });
    const layout = added.board.config.layout as { i: string; w: number }[];
    await post("/drag/layout", { layout: layout.map((l) => (l.i === "a" ? { ...l, w: 3 } : l)), summary: "resized “First”\nand more" });
    // From the layout before the first save: “First” goes back to its old width as “Second” narrows.
    await post("/drag/layout", { layout: layout.map((l) => (l.i === "b" ? { ...l, w: 4 } : l)) });
    const versions = await (await fetch(`${base}/drag/versions`)).json();
    expect(versions.slice(0, 2).map((v: { summary: string }) => v.summary)).toEqual(["resized “First”, resized “Second”", "resized “First” and more"]);
  });

  it("tells the next turn what the user moved and removed since the last one, after the board, and nothing without a last turn", async () => {
    await host.store.create({ id: "turns", pack: host.pack, title: "Turns" });
    const ops = [
      { op: "add_widget", id: "a", widget: text("Alpha"), placement: { width: "half" } },
      { op: "add_widget", id: "b", widget: text("Beta"), placement: { width: "half" } },
    ];
    const made = await host.store.patch({ id: "turns", ops: ops as never, catalogue: host.catalogue ?? catalogueFrom(host.pack), source: "chat" });
    if (!made.ok) throw new Error(made.error);
    const since = made.board.version;

    const before = await chat("turns", { since });
    expect(before).not.toContain("CHANGES MADE BY THE USER");

    const layout = made.board.config.layout.map((l) => (l.i === "b" ? { ...l, x: 0 } : { ...l, x: 6 }));
    await post("/turns/layout", { layout, summary: "moved “Beta”" });
    await post("/turns/ops", { ops: [{ op: "remove_widget", id: "a" }] });

    const after = await chat("turns", { since });
    const changes = after.slice(after.indexOf("CHANGES MADE BY THE USER SINCE YOUR LAST TURN"));
    expect(changes).toContain(`- v${since + 1} (by hand): moved “Beta”`);
    expect(changes).toContain(`- v${since + 2} (by hand): removed “Alpha”`);
    // After the board, at the very end: the part a prompt cache does not keep.
    expect(after.indexOf("CURRENT BOARD:")).toBeLessThan(after.indexOf("CHANGES MADE BY THE USER"));
    expect(after.indexOf("Rules:")).toBeLessThan(after.indexOf("CURRENT BOARD:"));

    // A first turn, or a since that is not a number, says nothing about changes.
    expect(await chat("turns", {})).not.toContain("CHANGES MADE BY THE USER");
    expect(await chat("turns", { since: "1" })).not.toContain("CHANGES MADE BY THE USER");
  });
});
