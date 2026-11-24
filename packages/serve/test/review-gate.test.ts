// What a chat turn does with the reviewer's findings. The edits are held until the reviewer has
// checked them; a material finding (the board would mislead) gets one fix round and a second
// check, and a change still wrong after it is never saved. Minor findings are saved and mentioned
// in one plain sentence. The models are stubs: a script of builder steps and reviewer verdicts.
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Host, type Provider, ROLLBACK_PROMPT, buildProvider, configSchema, createApp, openConfig, registerLlmAdapter, reviewTurn } from "../src";

const pack = fileURLToPath(new URL("../../../examples/tickets/pack.yaml", import.meta.url));
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
const textWidget = (id: string, title: string) => ({ id, kind: "text", title, body: "Stock received less stock issued.", query_kind: "value" });

const DOUBLE_COUNTED = {
  severity: "material",
  widget: "hf_burn",
  problem: "hf_burn: the query has no facility level filter, so each transfer is counted at both ends; the title claims health facility level.",
  forUser: "The table counted each transfer twice.",
};
const EXTRA_COLUMNS = { severity: "minor", widget: "hf_burn", problem: "hf_burn: stock_received was added although not requested", forUser: "The table also shows stock received, which you didn't ask for." };

/**
 * A builder that plays `steps` in order (one per model step; a tools-off call takes the next one
 * too) and a reviewer that returns `verdicts` in order. `onReview` sees the saved board at each review.
 */
function scripted(steps: unknown[][], verdicts: unknown[], onReview?: () => Promise<void>) {
  const seen = { steps: 0, reviews: 0, toolsOff: [] as string[] };
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt, toolChoice }) => {
      if (toolChoice?.type === "none") {
        const last = [...prompt].reverse().find((m) => m.role === "user");
        seen.toolsOff.push(last && Array.isArray(last.content) ? last.content.map((p) => ("text" in p ? p.text : "")).join("") : String(last?.content ?? ""));
      }
      return stream(steps[seen.steps++] ?? say("Done."));
    },
    doGenerate: async () => {
      await onReview?.();
      const v = verdicts[seen.reviews++] ?? { findings: [] };
      return { content: [{ type: "text", text: JSON.stringify(v) }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
  });
  return { model, seen };
}

type Part = { type: string; id?: string; delta?: string; data?: any };

describe("a chat turn with the reviewer", () => {
  const servers: Server[] = [];
  let host: Host;
  let close: () => Promise<void>;
  let base: string;
  const scripts: Record<string, ReturnType<typeof scripted>> = {};
  // The saved board's version each time the reviewer is called: the held edits must not be in it.
  const savedAtReview: number[] = [];

  const fixedSteps = [
    tool("add_widget", textWidget("hf_burn", "Stock burn at health facility level")),
    say("I added the burn rate at health facility level."),
    tool("remove_widget", { id: "hf_burn" }),
    tool("add_widget", textWidget("hf_burn_fixed", "Stock burn at health facility level")),
    say("I removed the table because its numbers counted each transfer twice; here is the corrected one."),
  ];

  beforeAll(async () => {
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack, source: "data" }] }), tmpdir());
    host = opened.hosts[0]!;
    close = opened.close;
    const atReview = (board: string) => async () => void savedAtReview.push((await host.store.get(board))!.version);
    Object.assign(scripts, {
      fixed: scripted(fixedSteps, [{ findings: [DOUBLE_COUNTED], userNote: "", note: "double counted" }, { findings: [], userNote: "", note: "fine" }], atReview("fixed")),
      failed: scripted(
        [...fixedSteps.slice(0, 4), say("Here is the corrected one."), say("I couldn't build a correct version: the table would count each transfer twice, so the board is as it was.")],
        [{ findings: [DOUBLE_COUNTED] }, { findings: [DOUBLE_COUNTED] }],
        atReview("failed"),
      ),
      minor: scripted([tool("add_widget", textWidget("hf_burn", "Stock burn")), say("I added the burn rate.")], [{ findings: [EXTRA_COLUMNS], userNote: "The table also shows stock received, which you didn't ask for.", note: "extra column" }]),
      off: scripted([tool("add_widget", textWidget("hf_burn", "Stock burn")), say("I added the burn rate.")], []),
    });
    const providers: Provider[] = Object.entries(scripts).map(([name, s]) => {
      registerLlmAdapter({ kind: `gate-${name}`, defaultBaseUrl: "mock:", build: () => s.model });
      return { ...buildProvider({ name, kind: `gate-${name}`, model: "m", pricing: { input: 1, output: 2 } }), available: true };
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

  const turn = async (name: string, query = "") => {
    await host.store.create({ id: name, pack: host.pack, title: "Stock" });
    const res = await fetch(`${base}/${name}/chat?model=${name}${query}`, { method: "POST", body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "add the stock burn rate at health facility level" }] }] }) });
    const parts = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)) as Part);
    // The text the person reads, one entry per text part.
    const texts: string[] = [];
    for (const p of parts) {
      if (p.type === "text-start") texts.push("");
      if (p.type === "text-delta" && texts.length) texts.push(texts.pop()! + (p.delta ?? ""));
    }
    const board = (await host.store.get(name))!;
    return { parts, texts, board, versions: await host.store.versions(name), usage: parts.find((p) => p.type === "data-usage")!.data };
  };

  it("a material finding gets one fix round; the fixed edit is saved and the reply says what changed", async () => {
    const t = await turn("fixed");
    expect(Object.keys(t.board.config.widgets)).toEqual(["hf_burn_fixed"]);
    // Saved when the turn ended, as one version: the wrong table is not even in the history.
    expect(t.versions.map((v) => `${v.version} ${v.source} ${v.summary}`)).toEqual(["2 chat added “Stock burn at health facility level”", "1 create created"]);
    // Neither review saw a saved edit: the wrong table never reached the board.
    expect(savedAtReview).toEqual([1, 1]);
    // The first answer streams as it is written; the fix round's words come only after its check passed.
    expect(t.texts).toEqual(["I added the burn rate at health facility level.", "I removed the table because its numbers counted each transfer twice; here is the corrected one."]);
    expect(t.texts.join(" ")).not.toMatch(/review/i);
    const reviews = t.parts.filter((p) => p.type === "data-review").map((p) => p.data);
    expect(reviews.map((r) => r.findings.length)).toEqual([1, 0]);
    expect(reviews[0].findings[0]).toMatchObject({ severity: "material", widget: "hf_burn" });
    // The fix round and both reviews are in the turn's cost.
    const roles = (t.usage.models as { role: string; calls: number }[]).map((m) => [m.role, m.calls]);
    expect(roles).toEqual([["build", 2], ["review", 2], ["escalate", 3]]);
  });

  it("a fix that is still wrong leaves the board as it was, and the reply says so", async () => {
    savedAtReview.length = 0;
    const t = await turn("failed");
    expect(t.board.version).toBe(1);
    expect(t.board.config.widgets).toEqual({});
    expect(t.versions).toHaveLength(1);
    expect(savedAtReview).toEqual([1, 1]);
    // The fix round's own claim ("Here is the corrected one.") is never shown.
    expect(t.texts).toEqual(["I added the burn rate at health facility level.", "I couldn't build a correct version: the table would count each transfer twice, so the board is as it was."]);
    // The closing words come from one more builder call, tools off, told why.
    expect(scripts.failed!.seen.toolsOff[0]).toContain(ROLLBACK_PROMPT);
    expect(scripts.failed!.seen.toolsOff[0]).toContain("counted at both ends");
    expect(JSON.stringify(t.parts.filter((p) => p.type === "data-usage"))).toContain('"escalate"');
  });

  it("minor findings: the edit is saved and the reply adds one plain sentence", async () => {
    const t = await turn("minor");
    expect(Object.keys(t.board.config.widgets)).toEqual(["hf_burn"]);
    expect(t.board.version).toBe(2);
    expect(t.texts).toEqual(["I added the burn rate.", "The table also shows stock received, which you didn't ask for."]);
    expect(t.parts.filter((p) => p.type === "data-round")).toHaveLength(1);
    expect(t.texts.join(" ")).not.toContain("hf_burn");
  });

  it("with the reviewer off, edits are saved as they are made and nothing is checked", async () => {
    const t = await turn("off", "&review=off");
    expect(Object.keys(t.board.config.widgets)).toEqual(["hf_burn"]);
    expect(t.parts.some((p) => p.type === "data-review")).toBe(false);
    expect(scripts.off!.seen.reviews).toBe(0);
    expect(t.texts).toEqual(["I added the burn rate."]);
  });
});

describe("the reviewer's verdict", () => {
  const reviewer = (text: string) =>
    new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }) });
  const input = { catalogue: "PACK", instruction: "add a kpi", before: "", after: "", receipt: "v2 added k" };

  it("reads each finding's severity; one it doesn't name is minor, so it never undoes a change", async () => {
    const r = await reviewTurn(reviewer(`Here: ${JSON.stringify({ findings: [DOUBLE_COUNTED, { problem: "odd colour", forUser: "The colour is odd." }, { severity: "material" }], userNote: "The colour is odd.", note: "n" })}`), input);
    expect(r.satisfied).toBe(false);
    expect(r.findings.map((f) => f.severity)).toEqual(["material", "minor"]);
    expect(r.userNote).toBe("The colour is odd.");
  });

  it("no findings is satisfied; no verdict at all is unavailable, not a failure", async () => {
    expect(await reviewTurn(reviewer('{"findings": [], "note": "fine"}'), input)).toMatchObject({ satisfied: true, findings: [], note: "fine" });
    expect(await reviewTurn(reviewer("I think it is fine"), input)).toMatchObject({ satisfied: true, unavailable: true });
  });
});
