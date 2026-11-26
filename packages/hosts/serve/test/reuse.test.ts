// Answer and plan reuse: a question answered before is answered again without the model. The models
// are stubs (a builder that queries and then reads the number it got back, a router that answers
// from a script), the data the synthetic campaign example on DuckDB, scaled on demand to stand for
// data that changed since.
import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { catalogueFrom } from "@lenspack/pack";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { seed } from "../../../../examples/campaign/seed";
import { type AppOptions, BUSY_TEXT, CACHE_DEFAULTS, DEFAULT_BRAND, resolveBrand, type CacheSettings, type Host, type Provider, QUEUE_DEFAULTS, QueueBusy, type Reuse, type TurnGate, buildProvider, localTurnGate, cacheSettings, configSchema, createApp, openConfig, registerLlmAdapter, reuseLayer } from "../src";
import { anthropicAdapter, anthropicTokens } from "../src/adapters/anthropic";
import { costOf } from "../src/metering";
import { cacheRoutes } from "../src/reuse";
import { fill, guessLanguage, normalise, retemplate, shapeOf, slotInto, slotsOf, standalone, timePhrase } from "@lenspack/agent";

const campaign = fileURLToPath(new URL("../../../../examples/campaign/", import.meta.url));
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const stream = (parts: unknown[]) => ({ stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) });
const toolStep = (toolName: string, input: unknown) => [
  { type: "tool-call", toolCallId: `c${Math.random().toString(36).slice(2)}`, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const sayStep = (text: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];

/** The first number a tool result in the prompt carries as its value. */
const lastValue = (prompt: unknown) => {
  const m = [...JSON.stringify(prompt).matchAll(/\\?"value\\?":(\d+(?:\.\d+)?)/g)].at(-1);
  return m ? Number(m[1]) : NaN;
};

type Step = unknown[] | ((prompt: unknown) => unknown[] | Promise<unknown[]>);
type Part = { type: string; id?: string; delta?: string; data?: any; toolName?: string; output?: any };

describe("answer and plan reuse", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-reuse-"));
  const servers: Server[] = [];
  let host: Host;
  let close: () => Promise<void>;
  let base: string;
  let reuse: Reuse;
  let settings: Partial<CacheSettings> & { on?: boolean } = {};
  let appOptions: AppOptions;
  /** Another server on the same host and answer store, with other options (a queue). */
  const serverWith = async (o: Partial<AppOptions>) => {
    const server = createServer(createApp([host], { ...appOptions, ...o }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${host.name}`;
  };
  const clock = { now: new Date("2026-11-26T09:00:00Z") };
  // Data that "changed": every value the source returns is multiplied by this.
  const data = { factor: 1 };
  // The builder plays these steps in order; the router answers with these.
  const script: { steps: Step[]; calls: number; reviews: number; verdicts: unknown[] } = { steps: [], calls: 0, reviews: 0, verdicts: [] };
  const router: { answers: ((system: string, user: string) => string)[]; calls: number; seen: string[] } = { answers: [], calls: 0, seen: [] };

  beforeAll(async () => {
    const db = await openDuckdb(join(dir, "campaign.duckdb"));
    await seed(db.writer, "duckdb", { households: 1500 });
    await db.close();
    const opened = await openConfig(
      configSchema.parse({ sources: { data: { url: `duckdb:${join(dir, "campaign.duckdb")}` } }, packs: [{ pack: `${campaign}pack.yaml`, source: "data", now: "2026-09-01T00:00:00Z" }], store: { kind: "memory" } }),
      dir,
    );
    close = opened.close;
    const inner = opened.hosts[0]!.connector;
    host = {
      ...opened.hosts[0]!,
      connector: {
        kind: inner.kind,
        capabilities: inner.capabilities,
        compile: (b, p) => inner.compile(b, p),
        execute: async (plan, o) => {
          const d = await inner.execute(plan, o);
          return data.factor === 1 ? d : { ...d, rows: d.rows.map((r) => ({ ...r, value: r.value === null ? null : Math.round(r.value * data.factor) })) };
        },
      },
    };
    const builder = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        script.calls++;
        const next = script.steps.shift() ?? sayStep("Done.");
        return stream(typeof next === "function" ? await next(prompt) : next);
      },
      doGenerate: async () => {
        script.reviews++;
        const v = script.verdicts.shift() ?? { findings: [] };
        return { content: [{ type: "text", text: JSON.stringify(v) }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
      },
    });
    const small = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        router.calls++;
        const system = prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("");
        const user = JSON.stringify(prompt.filter((m) => m.role === "user"));
        router.seen.push(system.slice(0, 40));
        const answer = router.answers.shift()?.(system, user) ?? '{"match": null}';
        return { content: [{ type: "text", text: answer }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
      },
    });
    registerLlmAdapter({ kind: "reuse-builder", defaultBaseUrl: "mock:", build: () => builder });
    registerLlmAdapter({ kind: "reuse-router", defaultBaseUrl: "mock:", build: () => small });
    const providers: Provider[] = [
      { ...buildProvider({ name: "builder", kind: "reuse-builder", model: "big", pricing: { input: 10, output: 50 } }), available: true },
      { ...buildProvider({ name: "router", kind: "reuse-router", model: "small", pricing: { input: 1, output: 5 } }), available: true },
    ];
    reuse = reuseLayer({ store: join(dir, "state", "reuse.json"), settings: () => ({ ...CACHE_DEFAULTS, on: true, ...settings }), now: () => clock.now, timer: false });
    // Who asks: x-user names them; user "north" may only see the Northern province.
    const access = (req: { headers: Record<string, unknown> }) => {
      const user = String(req.headers["x-user"] ?? "a");
      return { user, edit: true, maintain: true, ...(user === "north" ? { scope: [{ dimension: "province", op: "eq" as const, value: "Northern" }] } : {}) };
    };
    appOptions = { providers, roles: { router: "router" }, reuse, access: access as never };
    const server = createServer(createApp([host], appOptions));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${host.name}`;
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    await close();
  });
  beforeEach(() => {
    settings = {};
    data.factor = 1;
    script.steps = [];
    script.verdicts = [];
    router.answers = [];
    clock.now = new Date(clock.now.getTime() + 86_400_000);
  });

  let boards = 0;
  const newBoard = async () => {
    const id = `b${++boards}`;
    await host.store.create({ id, pack: host.pack, title: "Campaign" });
    return id;
  };
  const ask = async (board: string, text: string, o: { user?: string; fresh?: boolean; history?: string[]; language?: string; base?: string; query?: string } = {}) => {
    const before = { calls: script.calls, reviews: script.reviews, router: router.calls };
    const messages = [...(o.history ?? []).flatMap((h, i) => [{ id: `h${i}`, role: "user", parts: [{ type: "text", text: h }] }, { id: `a${i}`, role: "assistant", parts: [{ type: "text", text: "ok" }] }]), { id: "u", role: "user", parts: [{ type: "text", text }] }];
    const res = await fetch(`${o.base ?? base}/${board}/chat?model=builder${o.query ?? ""}`, { method: "POST", headers: { "x-user": o.user ?? "a" }, body: JSON.stringify({ messages, ...(o.fresh ? { fresh: true } : {}), ...(o.language ? { language: o.language } : {}) }) });
    const parts = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)) as Part);
    const reply = parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");
    return { parts, reply, saved: parts.find((p) => p.type === "data-reuse")?.data, model: script.calls - before.calls, reviews: script.reviews - before.reviews, router: router.calls - before.router };
  };
  /** The builder answers "how many households were delivered …" with one value query. */
  const answers = (filters = "", time: Record<string, unknown> = {}, words = (n: number) => `${n.toLocaleString("en-US")} households were delivered.`) => {
    script.steps.push(toolStep("query", { query_kind: "value", measure: "households_delivered", filters, ...time }), (prompt) => sayStep(words(lastValue(prompt))));
  };

  it("T1: the same question again is answered from the saved answer, with no model and no query", async () => {
    const b = await newBoard();
    answers();
    const first = await ask(b, "How many households were delivered?");
    expect(first.model).toBe(2);
    expect(first.saved).toBeUndefined();
    const n = Number(first.reply.match(/[\d,]+/)![0].replace(/,/g, ""));
    expect(n).toBeGreaterThan(100);
    // Another case, punctuation and spacing: the same question.
    const again = await ask(b, "how many   households were delivered");
    expect(again.model).toBe(0);
    expect(again.saved).toMatchObject({ tier: "t1", kind: "answer" });
    expect(again.reply).toBe(first.reply);
    // The plan's query shows as a step, with its result.
    expect(again.parts.find((p) => p.type === "tool-input-available")?.toolName).toBe("query");
    // The audit-facing usage line says no model ran.
    expect(again.parts.find((p) => p.type === "data-usage")?.data.total.calls).toBe(0);
  });

  it("T2: on older data the queries run again and the numbers are swapped in by template", async () => {
    const b = await newBoard();
    answers();
    const first = await ask(b, "How many households were delivered?");
    const n = Number(first.reply.match(/[\d,]+/)![0].replace(/,/g, ""));
    clock.now = new Date(clock.now.getTime() + 30 * 60_000);
    data.factor = 2;
    const again = await ask(b, "How many households were delivered?");
    expect(again.model).toBe(0);
    expect(again.router).toBe(0);
    expect(again.saved).toMatchObject({ tier: "t2" });
    expect(again.saved.how).toMatch(/^template/);
    expect(again.reply).toBe(`${(n * 2).toLocaleString("en-US")} households were delivered.`);
    // The queries it ran again are explained, as in a full turn ("How this was worked out").
    expect(again.parts.find((p) => p.type === "data-answer-card")?.data).toMatchObject({ calls: [expect.anything()] });
    // The fresh answer is now the saved one: asked again at once, it is T1.
    const third = await ask(b, "How many households were delivered?");
    expect(third.saved.tier).toBe("t1");
    expect(third.reply).toBe(again.reply);
  });

  it("T2 refuses a template when a number in the reply is not in the results, and one small call rewrites it", async () => {
    const b = await newBoard();
    answers("", {}, (n) => `${n.toLocaleString("en-US")} households were delivered, about 17 per team.`);
    await ask(b, "How many households were delivered?");
    clock.now = new Date(clock.now.getTime() + 30 * 60_000);
    data.factor = 3;
    router.answers.push((system) => (system.startsWith("You update a reply") ? "Rewritten with the fresh numbers." : "?"));
    const again = await ask(b, "How many households were delivered?");
    expect(again.model).toBe(0);
    expect(again.router).toBe(1);
    expect(again.saved.tier).toBe("t2");
    expect(again.saved.how).toContain('"17" is not a number in the results');
    expect(again.reply).toBe("Rewritten with the fresh numbers.");
  });

  it("T3: another district (a slot) runs the same plan with the value swapped, no model", async () => {
    const b = await newBoard();
    answers("district = Mansa", {}, (n) => `Mansa: ${n} households delivered.`);
    const first = await ask(b, "How many households were delivered in Mansa?");
    expect(first.model).toBe(2);
    const other = await ask(b, "how many households were delivered in Chipata");
    expect(other.model).toBe(0);
    expect(other.saved.tier).toBe("t3");
    const q = other.parts.find((p) => p.type === "tool-input-available") as unknown as { input: { filters: string } };
    expect(q.input.filters).toBe("district = Chipata");
    const v = (other.parts.find((p) => p.type === "tool-output-available")?.output as { rows: { value: number }[] }).rows[0]!.value;
    expect(other.reply).toBe(`Chipata: ${v} households delivered.`);
    // A value the data does not have is no slot: the full assistant answers.
    answers("district = Atlantis");
    const unknown = await ask(b, "How many households were delivered in Atlantis?");
    expect(unknown.model).toBe(2);
    expect(unknown.saved).toBeUndefined();
  });

  it("T3 with another time period re-runs the plan and has the small model rewrite the dates", async () => {
    const b = await newBoard();
    answers("", { time_period: "last_month" }, (n) => `${n} households were delivered last month.`);
    await ask(b, "How many households were delivered last month?");
    router.answers.push((system, user) => (system.startsWith("You update a reply") && user.includes("this month") ? "Fresh: households delivered this month." : "?"));
    const other = await ask(b, "How many households were delivered this month?");
    expect(other.model).toBe(0);
    expect(other.saved.tier).toBe("t3");
    const q = other.parts.find((p) => p.type === "tool-input-available") as unknown as { input: Record<string, unknown> };
    expect(q.input.time_period).toBe("this_month");
    expect(other.reply).toBe("Fresh: households delivered this month.");
  });

  it("T4: the router pairs a different wording with a saved question; no match runs the full assistant", async () => {
    const b = await newBoard();
    answers();
    const first = await ask(b, "How many households were delivered?");
    router.answers.push((_s, user) => {
      const id = /id: ([a-z0-9]+)/.exec(user)![1];
      return JSON.stringify({ match: id, slots: {} });
    });
    const routed = await ask(b, "Count of households that got their nets delivered");
    expect(routed.model).toBe(0);
    expect(routed.router).toBe(1);
    expect(routed.saved.tier).toBe("t4");
    expect(routed.reply).toBe(first.reply);
    // In another language: the saved question shares no words with it, but is still offered to the router,
    // and the reply is rewritten in the question's language.
    router.answers.push(
      (_s, user) => JSON.stringify({ match: /id: ([a-z0-9]+)/.exec(user)![1], slots: {} }),
      (system, user) => (system.startsWith("You update a reply") && user.includes("language: fr") ? "Des ménages ont été livrés." : "?"),
    );
    const fr = await ask(b, "Combien de ménages ont été livrés ?");
    expect(fr).toMatchObject({ model: 0, router: 2, reply: "Des ménages ont été livrés.", saved: { tier: "t4" } });
    // The router says none: the full assistant answers.
    router.answers.push(() => '{"match": null}');
    answers();
    const missed = await ask(b, "Households delivered, how many were there in total by the teams");
    expect(missed.router).toBe(1);
    expect(missed.model).toBe(2);
    // Router off: no router call at all.
    settings = { router: "off" };
    answers();
    const off = await ask(b, "Number of households delivered by the distribution teams overall");
    expect(off.router).toBe(0);
    expect(off.model).toBe(2);
  });

  it("Ask fresh always runs the full assistant, and its answer replaces the saved one", async () => {
    const b = await newBoard();
    answers();
    await ask(b, "How many households were delivered?");
    answers("", {}, (n) => `Now ${n} households.`);
    const fresh = await ask(b, "How many households were delivered?", { fresh: true });
    expect(fresh.model).toBe(2);
    expect(fresh.saved).toBeUndefined();
    const after = await ask(b, "How many households were delivered?");
    expect(after.saved.tier).toBe("t1");
    expect(after.reply).toMatch(/^Now \d+ households\.$/);
  });

  it("never serves across access scopes", async () => {
    const b = await newBoard();
    answers();
    const a = await ask(b, "How many households were delivered?", { user: "a" });
    // Someone with the same access gets it.
    const c = await ask(b, "How many households were delivered?", { user: "c" });
    expect(c.saved?.tier).toBe("t1");
    expect(c.reply).toBe(a.reply);
    // Someone who may see only one province does not: the assistant answers, under their scope.
    answers();
    const north = await ask(b, "How many households were delivered?", { user: "north" });
    expect(north.saved).toBeUndefined();
    expect(north.model).toBe(2);
    expect(north.reply).not.toBe(a.reply);
    // The suggestions follow the same rule.
    const sug = async (user: string) => (await (await fetch(`${base}/${b}/suggestions`, { headers: { "x-user": user } })).json()).suggestions;
    expect(await sug("a")).toEqual(["How many households were delivered?"]);
    expect(await sug("north")).toEqual([]);
  });

  it("invalidates on a board filter change, the language rules, the prompt or pack version, and the TTL", async () => {
    const b = await newBoard();
    answers();
    await ask(b, "How many households were delivered?");
    const unfiltered = new Set((await reuse.store.entries()).map((x) => x.id));
    // A board filter added: the board's answers are not reused.
    await host.store.patch({ id: b, ops: [{ op: "add_filter", filter: { id: "f_province", field: "province", label: "Province", type: "select", applies: ["*"] } } as never], catalogue: catalogueFrom(host.pack), source: "ops" });
    answers();
    expect((await ask(b, "How many households were delivered?")).model).toBe(2);
    // Another language picked for the reply: not the same answer.
    answers();
    expect((await ask(b, "How many households were delivered?", { language: "fr" })).model).toBe(2);
    // An entry made under another pack or prompt version (a restart after either changed) is never served.
    const e = (await reuse.store.entries()).find((x) => x.board === b && x.replyLang === "auto" && !unfiltered.has(x.id))!;
    const version = e.version;
    await reuse.store.put({ ...e, version: "older" });
    answers();
    expect((await ask(b, "How many households were delivered?")).model).toBe(2);
    expect((await reuse.store.get(e.id))!.version).toBe(version);
    // Past the TTL the entry is dropped and the assistant answers again.
    settings = { ttlHours: 1 };
    clock.now = new Date(clock.now.getTime() + 2 * 3_600_000);
    answers();
    expect((await ask(b, "How many households were delivered?")).model).toBe(2);
  });

  it("a renamed assistant starts afresh: saved answers never replay across a name change, and the prompt names it", async () => {
    let brand = DEFAULT_BRAND;
    const named = await serverWith({ brand: () => brand });
    const b = await newBoard();
    const systems: string[] = [];
    const seeing = () => script.steps.push((prompt) => (systems.push((prompt as { role: string; content: unknown }[]).filter((m) => m.role === "system").map((m) => String(m.content)).join("")), toolStep("query", { query_kind: "value", measure: "households_delivered" })), (prompt) => sayStep(`${lastValue(prompt).toLocaleString("en-US")} households were delivered.`));
    seeing();
    expect((await ask(b, "How many households were delivered?", { base: named })).model).toBe(2);
    expect(systems.pop()).toContain("You are Lenspack, a dashboard assistant.");
    expect((await ask(b, "How many households were delivered?", { base: named })).saved).toMatchObject({ tier: "t1" });
    // Renamed on the settings page: read on the next turn, no restart; the answer saved under the old name is not served.
    brand = resolveBrand({ name: "Campaign assistant" });
    seeing();
    const renamed = await ask(b, "How many households were delivered?", { base: named });
    expect(renamed.model).toBe(2);
    expect(renamed.saved).toBeUndefined();
    expect(systems.pop()).toContain("You are Campaign assistant, a dashboard assistant.");
    expect((await ask(b, "How many households were delivered?", { base: named })).saved).toMatchObject({ tier: "t1" });
  });

  it("a follow-up that leans on the turn before is neither served nor kept", async () => {
    const b = await newBoard();
    answers();
    await ask(b, "How many households were delivered?");
    answers();
    const follow = await ask(b, "and that for Mansa", { history: ["How many households were delivered?"] });
    expect(follow.model).toBe(2);
    // A standalone question later in a conversation is still served.
    const later = await ask(b, "How many households were delivered?", { history: ["something else entirely"] });
    expect(later.saved?.tier).toBe("t1");
  });

  it("dashboards settle: an accepted edit replays without the model, and the same edits skip the reviewer", async () => {
    const b = await newBoard();
    const kpi = { kind: "kpi", title: "Households delivered", query_kind: "value", measure: "households_delivered", place: "top", width: "quarter" };
    script.steps.push(toolStep("add_widget", { id: "hh", ...kpi }), sayStep("I added the households delivered KPI at the top."));
    const first = await ask(b, "Add a KPI of households delivered at the top");
    expect(first.model).toBe(2);
    expect(first.reviews).toBe(1);
    expect(Object.keys((await host.store.get(b))!.config.widgets)).toEqual(["hh"]);
    // Back to the board as it was: the same request replays the accepted edit, no model, no reviewer.
    await host.store.revertTo(b, 1);
    const replay = await ask(b, "add a KPI of households delivered at the top");
    expect(replay.model).toBe(0);
    expect(replay.reviews).toBe(0);
    expect(replay.saved).toMatchObject({ tier: "t1", kind: "edit" });
    expect(Object.keys((await host.store.get(b))!.config.widgets)).toEqual(["hh"]);
    // Asked fresh, the model makes the same edits on the same board content: the reviewer is skipped.
    await host.store.revertTo(b, 1);
    script.steps.push(toolStep("add_widget", { id: "hh", ...kpi }), sayStep("I added the households delivered KPI at the top."));
    const freshEdit = await ask(b, "Add a KPI of households delivered at the top", { fresh: true });
    expect(freshEdit.model).toBe(2);
    expect(freshEdit.reviews).toBe(0);
    // Edits are counted per board, for "settled" boards.
    await new Promise((r) => setTimeout(r, 20));
    expect((await reuse.boards()).find((x) => x.board === b)).toMatchObject({ settled: false });
    expect((await reuse.boards()).find((x) => x.board === b)!.edits7d).toBeGreaterThanOrEqual(3);
  });

  it("frequent questions become suggestions, and those no chart answers become chart candidates", async () => {
    const b = await newBoard();
    answers();
    for (let i = 0; i < 3; i++) await ask(b, "How many households were delivered?");
    expect(await reuse.suggestions({ board: b, scope: null })).toEqual(["How many households were delivered?"]);
    const candidates = (await reuse.chartCandidates()).filter((c) => c.board === b);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ question: "How many households were delivered?", asks: 3, query: { kind: "value", measure: "households_delivered" } });
    // Once the board has a chart of it, it is no longer a candidate.
    await host.store.patch({ id: b, ops: [{ op: "add_widget", id: "k", widget: { kind: "kpi", title: "HH", query: { kind: "value", measure: "households_delivered" } }, placement: { place: "top", width: "quarter" } } as never], catalogue: catalogueFrom(host.pack), source: "ops" });
    answers();
    await ask(b, "something unrelated to refresh the board view", {});
    expect((await reuse.chartCandidates()).filter((c) => c.board === b)).toHaveLength(0);
  });

  it("the store survives a restart, bounded with LRU and pinning", async () => {
    const file = join(dir, "lru", "reuse.json");
    const one = reuseLayer({ timer: false, store: file, settings: () => ({ ...CACHE_DEFAULTS, on: true, maxEntries: 10 }), now: () => clock.now });
    const entry = (i: number) => ({
      id: `e${i}`, kind: "answer" as const, pack: "p", board: "b", scope: "s", version: "v", lang: "en", replyLang: "auto", question: `q${i}`, norm: `q${i}`, variants: [], plan: [], reply: "r", dataAsOf: clock.now.toISOString(),
      costUsd: 0.01, model: "m", createdAt: new Date(clock.now.getTime() + i).toISOString(), lastHit: null, hits: 0, asked: [], tierCounts: { t1: 0, t2: 0, t3: 0, t4: 0 }, pinned: false,
    });
    await one.store.put(entry(0));
    await one.pin("e0", true);
    for (let i = 1; i <= 12; i++) await one.store.put(entry(i));
    await one.flush();
    const two = reuseLayer({ timer: false, store: file, settings: () => ({ ...CACHE_DEFAULTS, on: true, maxEntries: 10 }), now: () => clock.now });
    const ids = (await two.list()).entries.map((e) => e.id).sort();
    expect(ids).toHaveLength(10);
    // The pinned one stayed, the oldest unpinned went.
    expect(ids).toContain("e0");
    expect(ids).not.toContain("e1");
    expect(ids).not.toContain("e2");
    expect(ids).not.toContain("e3");
    expect((await two.list()).entries.find((e) => e.id === "e0")!.pinned).toBe(true);
  });

  it("the admin API: stats, entries, pin, evict, suggestions, chart candidates, admins only", async () => {
    const b = await newBoard();
    answers();
    await ask(b, "How many households were delivered?");
    await ask(b, "How many households were delivered?");
    const routes = cacheRoutes({ prefix: "/_x", reuse, adminName: "admin" });
    const call = async (method: string, path: string, roles: string[] = ["admin"]) => {
      let status = 0;
      let body: any;
      const res = { headersSent: false, writeHead: (s: number) => ((status = s), res), setHeader: () => undefined, end: (t: string) => (body = JSON.parse(t)) } as never;
      await routes({ method } as never, res, new URL(`http://x${path}`), { user: "u", edit: true, roles } as never);
      return { status, body };
    };
    const list = await call("GET", "/_x/cache");
    expect(list.status).toBe(200);
    expect(list.body.stats).toMatchObject({ since: expect.any(String), turns: expect.any(Number), hits: { t1: expect.any(Number), t2: expect.any(Number), t3: expect.any(Number), t4: expect.any(Number) }, misses: expect.any(Number), savedUsd: expect.any(Number) });
    const e = list.body.entries.find((x: { board: string }) => x.board === b);
    expect(e).toMatchObject({ id: expect.any(String), board: b, question: "How many households were delivered?", variants: [], kind: "answer", hits: 1, lastHit: expect.any(String), createdAt: expect.any(String), pinned: false, tierCounts: { t1: 1, t2: 0, t3: 0, t4: 0 }, dataAsOf: expect.any(String) });
    expect((await call("POST", `/_x/cache/${e.id}/pin`)).body).toEqual({ ok: true, id: e.id, action: "pin" });
    expect((await reuse.store.get(e.id))!.pinned).toBe(true);
    expect((await call("POST", `/_x/cache/${e.id}/unpin`)).status).toBe(200);
    expect((await call("GET", `/_x/cache/suggestions?board=${b}`)).body.suggestions).toEqual(["How many households were delivered?"]);
    expect((await call("GET", "/_x/cache/chart-candidates")).body).toHaveProperty("candidates");
    expect((await call("GET", "/_x/cache/boards")).body).toHaveProperty("boards");
    expect((await call("GET", "/_x/cache", ["viewer"])).status).toBe(403);
    expect((await call("POST", `/_x/cache/${e.id}/evict`)).status).toBe(200);
    expect(await reuse.store.get(e.id)).toBeUndefined();
    expect((await call("POST", `/_x/cache/${e.id}/evict`)).status).toBe(404);
    // The savings are counted: two full turns' average, less what the saved answer spent (nothing).
    expect(list.body.stats.savedUsd).toBeGreaterThan(0);
  });

  it("the viewer's dashboard filter selections are part of the question", async () => {
    const b = await newBoard();
    answers();
    await ask(b, "How many households were delivered?", { query: "&f_province=Northern" });
    expect((await ask(b, "How many households were delivered?", { query: "&f_province=Northern" })).saved?.tier).toBe("t1");
    // Other selections (or none): not the same question.
    answers();
    expect((await ask(b, "How many households were delivered?", { query: "&f_province=Eastern" })).model).toBe(2);
    answers();
    expect((await ask(b, "How many households were delivered?")).model).toBe(2);
  });

  it("a suggested question with a checked query is answered by that query the first time, without the agent", async () => {
    const b = await newBoard();
    const pack = host.pack as { examples: { question: string; query: unknown }[] };
    const was = pack.examples;
    pack.examples = [{ question: "How many households were delivered so far?", query: { kind: "value", measure: "households_delivered" } }];
    try {
      router.answers.push((system, user) => (system.startsWith("You answer a dashboard question") && user.includes("households_delivered") ? "That many households were delivered." : "?"));
      const chip = await ask(b, "How many households were delivered so far?");
      expect(chip).toMatchObject({ model: 0, router: 1, reply: "That many households were delivered.", saved: { tier: "t2" } });
      expect(chip.saved.how).toMatch(/checked query, said by router/);
      expect(chip.parts.find((p) => p.type === "tool-output-available")?.output).toMatchObject({ ok: true, rows: [{ value: expect.any(Number) }] });
      // Kept like any answer: the next ask is T1.
      expect((await ask(b, "how many households were delivered so far")).saved.tier).toBe("t1");
    } finally {
      pack.examples = was;
    }
  });

  it("saved answers skip the queue; a full queue turns a model turn away with the suggestions", async () => {
    const b = await newBoard();
    answers();
    await ask(b, "How many households were delivered?");
    const full: TurnGate = {
      acquire: async () => {
        throw new QueueBusy("full", 60);
      },
      settings: () => QUEUE_DEFAULTS,
      stats: () => ({ running: 8, waiting: 50, editsWaiting: 0, turnSeconds: 10 }),
    };
    const busy = await serverWith({ queue: full });
    const hit = await ask(b, "How many households were delivered?", { base: busy });
    expect(hit.saved?.tier).toBe("t1");
    const turnedAway = await ask(b, "How many households were delivered by province?", { base: busy });
    expect(turnedAway.model).toBe(0);
    expect(turnedAway.parts.find((p) => p.type === "data-queue")?.data).toEqual({ state: "full", why: "full", retryAfterSeconds: 60 });
    expect(turnedAway.reply).toBe(BUSY_TEXT);
  });

  it("edits to one board wait for each other, and the second sees the first's result", async () => {
    const b = await newBoard();
    const gate = localTurnGate(() => ({ maxConcurrent: 8, maxWaiting: 8, maxWaitSeconds: 30 }));
    const busy = await serverWith({ queue: gate });
    let sawFirst: boolean | undefined;
    script.steps.push(
      async () => {
        await new Promise((r) => setTimeout(r, 300));
        return toolStep("add_widget", { id: "hh", kind: "kpi", title: "Households delivered", query_kind: "value", measure: "households_delivered", place: "top", width: "quarter" });
      },
      sayStep("I added the KPI."),
      (prompt) => {
        sawFirst = JSON.stringify(prompt).includes("Households delivered");
        return sayStep("The board already has that KPI.");
      },
    );
    // Worded unlike any edit saved by the tests before, so the model makes it.
    const first = ask(b, "Put a households delivered KPI first on the board", { base: busy });
    // The first holds its place before the second asks.
    for (let i = 0; i < 400 && gate.stats().running === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(gate.stats().running).toBe(1);
    const second = await ask(b, "Add another households delivered KPI please", { base: busy });
    await first;
    expect(second.parts.find((p) => p.type === "data-queue")?.data).toMatchObject({ state: "waiting", reason: "edit", position: 1 });
    expect(sawFirst).toBe(true);
    expect(second.reply).toBe("The board already has that KPI.");
  });

  it("pre-warming refreshes the most-asked answers on schedule, without the model while it can", async () => {
    for (const e of await reuse.store.entries()) await reuse.store.delete(e.id);
    const b = await newBoard();
    answers();
    const first = await ask(b, "How many households were delivered?");
    const n = Number(first.reply.match(/[\d,]+/)![0].replace(/,/g, ""));
    answers("", {}, (v) => `${v.toLocaleString("en-US")} households were delivered, about 17 per team.`);
    await ask(b, "How many households were delivered by the teams?");
    // Off by default: the schedule does nothing.
    data.factor = 2;
    clock.now = new Date(`${clock.now.toISOString().slice(0, 10)}T06:31:00Z`);
    expect(reuse.tick()).toBeNull();
    // On, at 06:30 UTC, with no money for rewrites: the template answer is refreshed, the other waits.
    settings = { prewarm: { enabled: true, times: ["06:30"], timeZone: "UTC", topN: 10, maxUsd: 0 } };
    const calls = router.calls;
    const run = (await reuse.tick())!;
    expect(run).toMatchObject({ reason: "schedule", entries: 2, refreshed: 1, rewritten: 0, skipped: 1, failed: 0, modelCalls: 0 });
    expect(router.calls).toBe(calls);
    expect(script.calls).toBeGreaterThan(0);
    // Once a day per time.
    expect(reuse.tick()).toBeNull();
    const hit = await ask(b, "How many households were delivered?");
    expect(hit).toMatchObject({ model: 0, saved: { tier: "t1" }, reply: `${(n * 2).toLocaleString("en-US")} households were delivered.` });
    // A data change, with a cap that allows a rewrite: the one that needs words rewritten is rewritten by the small model.
    settings = { prewarm: { enabled: true, times: ["06:30"], timeZone: "UTC", topN: 10, maxUsd: 1 } };
    data.factor = 3;
    router.answers.push(() => "Rewritten by the refresh.");
    const changed = (await reuse.dataChanged(null, 0))!;
    expect(changed).toMatchObject({ reason: "data", refreshed: 1, rewritten: 1, modelCalls: 1 });
    expect(changed.spentUsd).toBeGreaterThan(0);
    const words = await ask(b, "How many households were delivered by the teams?");
    expect(words).toMatchObject({ model: 0, router: 0, reply: "Rewritten by the refresh.", saved: { tier: "t1" } });
    // Only the top N per board and access scope.
    settings = { prewarm: { enabled: true, times: ["06:30"], timeZone: "UTC", topN: 1, maxUsd: 0 } };
    expect((await reuse.prewarm())!.entries).toBe(1);
  });

  it("the cache feature switch and settings turn it off", async () => {
    const b = await newBoard();
    answers();
    await ask(b, "How many households were delivered?");
    settings = { on: false };
    answers();
    expect((await ask(b, "How many households were delivered?")).model).toBe(2);
    settings = { enabled: false };
    answers();
    expect((await ask(b, "How many households were delivered?")).model).toBe(2);
  });
});

describe("reuse building blocks", () => {
  it("normalises case, punctuation, spacing and number words, keeping the language", () => {
    expect(normalise("How many  households, TODAY?")).toBe("how many households today");
    expect(normalise("Top five wards")).toBe("top 5 wards");
    expect(normalise("Les cinq dernières semaines")).toBe("les 5 dernieres semaines");
    expect(normalise("पिछले दो हफ्ते")).toBe("पिछले 2 हफ्ते");
    expect(normalise("1,234.5 doses")).toBe("1.234.5 doses");
    expect(guessLanguage("Combien de ménages aujourd'hui ?")).toBe("fr");
    expect(guessLanguage("Quantos agregados hoje?")).toBe("pt");
    expect(guessLanguage("आज कितनी खुराकें")).toBe("hi");
    expect(guessLanguage("anything", "pt")).toBe("pt");
    expect(standalone("and for last week?", false)).toBe(false);
    expect(standalone("show it as a line", false)).toBe(false);
    expect(standalone("doses today by district", false)).toBe(true);
    expect(standalone("and", true)).toBe(true);
  });

  it("finds slots: filter values and time phrases, and fills a pattern", () => {
    const calls = [{ tool: "query", input: { query_kind: "value", measure: "m", filters: "ward = Ward 12", time_period: "today" } }];
    const s = slotsOf("Doses today in Ward 12?", calls)!;
    expect(s.pattern).toBe("doses {1} in {0}");
    expect(s.slots.map((x) => x.kind)).toEqual(["value", "time"]);
    expect(fill(s.pattern, "doses yesterday in ward 7")).toEqual(["ward 7", "yesterday"]);
    expect(fill(s.pattern, "vaccines yesterday in ward 7")).toBeNull();
    const next = slotInto(calls, s.slots, [{ kind: "value", dimension: "ward", text: "ward 7", value: "Ward 7" }, { kind: "time", text: "last 7 days", time: { time_last: "7d" } }]);
    expect(next[0]!.input).toEqual({ query_kind: "value", measure: "m", filters: "ward = Ward 7", time_last: "7d" });
    expect(timePhrase("doses la semaine derniere")).toEqual({ text: "la semaine derniere", time: { time_period: "last_week" } });
    expect(timePhrase("doses last 30 days")).toEqual({ text: "last 30 days", time: { time_last: "30d" } });
    expect(timePhrase("खुराक पिछले हफ्ते")).toEqual({ text: "पिछले हफ्ते", time: { time_period: "last_week" } });
  });

  const rows = (pairs: [string, number][]) => ({ ok: true, query: { kind: "breakdown" }, rows: pairs.map(([group, value]) => ({ group, value, count: value })), records: pairs.reduce((s, [, v]) => s + v, 0) });

  it("templates a reply when every number maps to a cell and the rows kept their order", () => {
    const before = [rows([["Mansa", 1200], ["Samfya", 845.5]])];
    const after = [rows([["Mansa", 1310], ["Samfya", 902.25]])];
    const r = retemplate("Mansa leads with 1,200 doses, then Samfya with 845.5 (2,045.5 in all).", before, after, { question: "doses by district", lang: "en" });
    expect(r).toEqual({ ok: true, text: "Mansa leads with 1,310 doses, then Samfya with 902.3 (2,212.3 in all).", swapped: 3 });
    // French: a space for thousands, a comma for decimals.
    const fr = retemplate("Mansa : 1 200 doses, Samfya : 845,5.", before, after, { question: "doses par district", lang: "fr" });
    expect(fr).toMatchObject({ ok: true, text: "Mansa : 1 310 doses, Samfya : 902,3." });
    // Indian grouping, and a percentage of a share.
    const share = [{ rows: [{ group: "A", value: 123456, share: 0.425 }] }];
    const share2 = [{ rows: [{ group: "A", value: 234567, share: 0.5 }] }];
    expect(retemplate("A: 1,23,456 (42.5%)", share, share2, { question: "", lang: "hi" })).toMatchObject({ ok: true, text: "A: 2,34,567 (50.0%)" });
  });

  it("refuses to template what it cannot swap safely", () => {
    const before = [rows([["Mansa", 1200], ["Samfya", 845]])];
    const why = (reply: string, after: unknown[] = [rows([["Mansa", 1300], ["Samfya", 900]])]) => {
      const r = retemplate(reply, before, after, { question: "top 2 districts", lang: "en" });
      return r.ok ? "ok" : r.why;
    };
    expect(why("Mansa had 1,200, about 37 per team.")).toContain('"37" is not a number in the results');
    expect(why("Mansa had 1,200.", [rows([["Samfya", 1300], ["Mansa", 900]])])).toContain("the rows changed");
    expect(why("Mansa had 1,200 and Samfya 845; three districts are behind.")).toContain("count in words");
    expect(why("Mansa had 1.2k.")).toContain("not a plain number");
    // A number the person asked with is theirs: "top 2" stays.
    expect(why("The top 2 are Mansa (1,200) and Samfya (845).")).toBe("ok");
    // Two cells with the same number that now differ: ambiguous.
    const same = [rows([["A", 50], ["B", 50]])];
    expect(retemplate("A had 50.", same, [rows([["A", 60], ["B", 70]])], { question: "", lang: "en" })).toMatchObject({ ok: false, why: expect.stringContaining("several results") });
    // A small count that changed may be a count of rows, not a cell.
    expect(retemplate("4 visits.", [rows([["A", 4]])], [rows([["A", 6]])], { question: "", lang: "en" })).toMatchObject({ ok: false, why: expect.stringContaining("small count") });
    expect(shapeOf({ query: { x: 1 }, rows: [{ group: "A", value: 2 }], sql: "select 3" })).toEqual({ cells: [{ path: "rows[0].value", value: 2 }], labels: ["A"] });
  });

  it("cache settings: checked, and an admin's change kept in settings.json", () => {
    const saved: Record<string, unknown> = {};
    const store = { path: "x", get: <T>(k: string) => saved[k] as T, set: (k: string, v: unknown) => void (v === undefined ? delete saved[k] : (saved[k] = v)) };
    const s = cacheSettings(store, { ttlHours: 24 });
    expect(s.get()).toEqual({ ...CACHE_DEFAULTS, ttlHours: 24 });
    expect(s.update({ router: "off", maxEntries: 50 })).toEqual({ ok: true });
    expect(s.get()).toMatchObject({ router: "off", maxEntries: 50, ttlHours: 24 });
    expect(s.update({ maxEntries: 3 })).toMatchObject({ ok: false });
    expect(s.update({ colour: "red" })).toMatchObject({ ok: false });
    expect(s.update({ router: null })).toEqual({ ok: true });
    expect(s.view(true)).toMatchObject({ router: "on", source: "settings", writable: true, defaults: { ttlHours: 24 } });
  });
});

describe("prompt caching", () => {
  const cfg = { name: "claude-haiku-5-5", kind: "anthropic", model: "claude-haiku-5-5" };

  it("keeps tools and the stable system prompt for an hour, and a tool loop's tail for five minutes", () => {
    const tools = { a: { description: "a", inputSchema: {} }, b: { description: "b", inputSchema: {} } } as never;
    const call = anthropicAdapter.prepare!({ system: ["stable", "board"], messages: [], tools, loop: true }, cfg) as { system: { providerOptions?: unknown }[]; tools: Record<string, { providerOptions?: unknown }>; providerOptions: unknown };
    const hour = { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } };
    expect(call.system[0]!.providerOptions).toEqual(hour);
    expect(call.system[1]!.providerOptions).toBeUndefined();
    expect(call.tools.b!.providerOptions).toEqual(hour);
    expect(call.tools.a!.providerOptions).toBeUndefined();
    expect(call.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    // cacheTtl 5m: every breakpoint is short-lived.
    const short = anthropicAdapter.prepare!({ system: ["stable", "board"], messages: [], tools }, { ...cfg, anthropic: { cacheTtl: "5m" } }) as { system: { providerOptions?: unknown }[] };
    expect(short.system[0]!.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });

  it("prices hour-long cache writes at 2x input, short ones at 1.25x, reads at the read rate", () => {
    const pricing = anthropicAdapter.pricing!(cfg)!;
    expect(pricing).toEqual({ input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 });
    const t = anthropicTokens({ inputTokens: { total: 10_000, noCache: 1000, cacheRead: 6000, cacheWrite: 3000 }, outputTokens: { total: 200 }, raw: { cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 1000 } } }, cfg);
    expect(t).toMatchObject({ inputTokens: 10_000, cachedInputTokens: 6000, cacheWriteTokens: 3000, cacheWrite1hTokens: 2000 });
    // 1000 plain × 0.1 + 6000 read × 0.01 + 1000 short write × 0.125 + 2000 hour write × 0.2 + 200 out × 0.5, per million.
    expect(costOf(t, pricing)).toBeCloseTo((100 + 60 + 125 + 400 + 100) / 1e6, 12);
    // Without the breakdown (an older proxy) every write is taken to be the stable prefix's: an hour, unless set to 5m.
    const bare = { inputTokens: { total: 10, cacheWrite: 5 }, outputTokens: {} };
    expect(anthropicTokens(bare, cfg).cacheWrite1hTokens).toBe(5);
    expect(anthropicTokens(bare, { ...cfg, anthropic: { cacheTtl: "5m" } }).cacheWrite1hTokens).toBeUndefined();
  });
});
