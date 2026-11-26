import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePackText } from "@lenspack/pack";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { sqlConnector } from "@lenspack/sql";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { type AuditEvent, type DigestTurn, type Provider, adminSettings, buildProvider, compareReadings, parseReport, planReview, registerLlmAdapter, reviewSystem, scheduler, slots } from "../src";

const tmp = () => mkdtempSync(join(tmpdir(), "lp-daily-"));
const usage = (i: number, o: number) => ({ inputTokens: { total: i, noCache: i, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: o, text: o, reasoning: 0 } });

describe("the daily review's schedule", () => {
  it("works out the last and next slot in a time zone", () => {
    const s = slots("06:00", "Asia/Kolkata", new Date("2026-11-26T02:00:00Z"));
    expect(s.last.toISOString()).toBe("2026-11-26T00:30:00.000Z");
    expect(s.next.toISOString()).toBe("2026-11-27T00:30:00.000Z");
  });

  it("with a fake clock: no run while off or on the first start, one catch-up after a missed slot, never twice", async () => {
    let clock = Date.parse("2026-11-20T05:00:00Z");
    let enabled = false;
    let last: string | null = null;
    const ran: string[] = [];
    const timers: { fn: () => void; at: number }[] = [];
    const s = scheduler({
      now: () => new Date(clock),
      setTimer: (fn, ms) => (timers.push({ fn, at: clock + ms }), timers.length),
      clearTimer: () => undefined,
      enabled: () => enabled,
      when: () => ({ time: "06:00", timeZone: "UTC" }),
      lastSlot: { get: () => last, set: (v) => void (last = v) },
      run: async (slot) => void ran.push(slot.toISOString()),
    });
    await s.start();
    // First ever start: the slot that passed is not owed.
    expect(ran).toEqual([]);
    expect(last).toBe("2026-11-19T06:00:00.000Z");
    // Off: slots pass without a run.
    clock = Date.parse("2026-11-21T07:00:00Z");
    await s.check();
    expect(ran).toEqual([]);
    expect(last).toBe("2026-11-21T06:00:00.000Z");
    // On, and the server was down over the next two slots: one catch-up, the latest.
    enabled = true;
    clock = Date.parse("2026-11-23T09:00:00Z");
    await s.check();
    expect(ran).toEqual(["2026-11-23T06:00:00.000Z"]);
    await s.check();
    expect(ran).toHaveLength(1);
    // The next slot comes: it runs once.
    clock = Date.parse("2026-11-24T06:00:30Z");
    await s.check();
    expect(ran).toEqual(["2026-11-23T06:00:00.000Z", "2026-11-24T06:00:00.000Z"]);
    expect(s.next()?.toISOString()).toBe("2026-11-25T06:00:00.000Z");
    // A timer is armed at most an hour ahead, so a changed setting is picked up.
    expect(Math.max(...timers.map((t) => t.at - clock))).toBeLessThanOrEqual(3_600_000);
    s.stop();
  });
});

const turn = (n: number, flagged: boolean, len = 400): DigestTurn => ({ n, at: `2026-11-25T0${n % 10}:00:00Z`, user: `u${n % 3}`, question: `Question ${n} ${"x".repeat(len)}`, tools: ["query(value sales)"], refused: flagged ? ["no such key"] : [], findings: [], answer: "y".repeat(len), usd: 0.01, flagged });

describe("the cost cap", () => {
  const pricing = { input: 4, output: 20 };
  it("keeps every turn when they fit, and the worst case under the cap", () => {
    const plan = planReview({ turns: [1, 2, 3].map((n) => turn(n, false)), fixed: "rules", pricing, maxUsd: 1, thinkingAllowance: 4096 });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.included).toEqual([1, 2, 3]);
    expect(plan.worstUsd).toBeLessThanOrEqual(1);
  });
  it("shortens, then leaves out, turns to fit, flagged ones first; never over the cap", () => {
    const turns = Array.from({ length: 300 }, (_, i) => turn(i + 1, i % 50 === 0, 1500));
    const plan = planReview({ turns, fixed: "rules", pricing, maxUsd: 0.5, thinkingAllowance: 4096 });
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.dropped).toBeGreaterThan(0);
    expect(plan.worstUsd).toBeLessThanOrEqual(0.5);
    for (const t of turns.filter((x) => x.flagged)) expect(plan.included).toContain(t.n);
  });
  it("refuses a cap too small for the instructions", () => {
    expect(planReview({ turns: [turn(1, false)], fixed: "x".repeat(60_000), pricing, maxUsd: 0.05, thinkingAllowance: 4096 })).toHaveProperty("error");
  });
});

describe("the report's JSON", () => {
  it("keeps the good items, leaves out bad ones and says why", () => {
    const raw = `Here it is: ${JSON.stringify({
      summary: "Two readings of 'this month' gave different figures.",
      findings: [{ title: "Month read two ways", why: "turns 1 and 4", severity: "bad", turns: [1, 4] }, { why: "no title" }],
      proposals: [{ kind: "definition", when: "this month", text: "calendar month to date", rationale: "people meant the calendar month", turns: [1] }, { kind: "rewrite", text: "?" }],
      questions: [{ pattern: "sales this month", readings: [{ label: "Calendar month", explanation: "1st to today" }, { label: "30 days", explanation: "rolling" }], turns: [1] }, { pattern: "one reading", readings: [{ label: "only" }] }],
      chartCandidates: [{ question: "Sales by region", count: 4, query: { query_kind: "breakdown", dimension: "region", measure: "sales" } }],
    })}`;
    const r = parseReport(raw);
    if ("error" in r) throw new Error(r.error);
    expect(r.report.findings).toHaveLength(1);
    expect(r.report.proposals).toHaveLength(1);
    expect(r.report.questions).toHaveLength(1);
    expect(r.report.chartCandidates).toHaveLength(1);
    expect(r.problems).toHaveLength(3);
    expect(parseReport("not json")).toHaveProperty("error");
  });
});

const PACK_YAML = `pack: shop
version: 1
timeZone: UTC
entities:
  sales: { source: sales, grain: one row per sale, time: sold_at }
dimensions:
  - { key: region, entity: sales, sql: region, label: Region }
  - { key: sold, entity: sales, sql: sold_at, type: time, label: Sold }
measures:
  - { key: sales, entity: sales, agg: count, label: Sales }
  - { key: paid_sales, entity: sales, agg: count, filter: "paid", label: Paid sales }
`;
async function shop() {
  const db = await openDuckdb(":memory:");
  await db.writer.exec("CREATE TABLE sales (region VARCHAR, sold_at TIMESTAMP, paid BOOLEAN)");
  await db.writer.exec("INSERT INTO sales VALUES ('north', '2026-11-02', true), ('north', '2026-11-10', false), ('south', '2026-11-12', true), ('south', '2026-10-20', true)");
  return { db, pack: parsePackText(PACK_YAML), connector: sqlConnector(db.executor) };
}
const readings = [
  { id: "r1", label: "Every sale", explanation: "paid or not", query: { query_kind: "value", measure: "sales" } },
  { id: "r2", label: "Paid sales only", explanation: "", query: { query_kind: "value", measure: "paid_sales" } },
  { id: "r3", label: "By region", explanation: "", query: { query_kind: "breakdown", dimension: "region", measure: "sales" } },
];

describe("compare readings", () => {
  it("runs each reading's query on the data, with no model, and says how they differ", async () => {
    const { db, pack, connector } = await shop();
    const c = await compareReadings({ readings }, { pack, connector, ctx: {} });
    expect(c.readings.map((r) => r.error ?? r.ok)).toEqual([true, true, true]);
    expect(c.readings[0]!.value).toBe(4);
    expect(c.readings[1]!.value).toBe(3);
    expect(c.readings[2]!.rows?.length).toBe(2);
    expect(c.headline).toMatch(/Every sale/);
    // A reading with a key the pack lacks fails on its own.
    const bad = await compareReadings({ readings: [readings[0]!, { id: "x", label: "Refunds", explanation: "", query: { query_kind: "value", measure: "refunds" } }] }, { pack, connector, ctx: {} });
    expect(bad.readings[1]!.ok).toBe(false);
    await db.close();
  });
});

describe("a review run", () => {
  it("reads the turns, stores the report as JSON, logs questions and proposals, compares readings, stays under the cap, and skips internal turns", async () => {
    const dir = tmp();
    const { db, pack, connector } = await shop();
    const admin = adminSettings(dir, {}, {});
    let calls = 0;
    let sent = "";
    const report = {
      summary: "Sales were counted two ways.",
      findings: [{ title: "Paid or not", why: "turn 1 counted every sale", severity: "bad", turns: [1] }],
      proposals: [{ kind: "instruction", text: "Count every sale unless asked for paid ones.", rationale: "turn 1", turns: [1] }],
      questions: [{ pattern: "how many sales", readings: readings.slice(0, 2).map(({ id: _id, ...r }) => r), turns: [1] }],
      chartCandidates: [],
    };
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        calls += 1;
        sent = JSON.stringify(opts.prompt);
        return { content: [{ type: "text", text: JSON.stringify(report) }], finishReason: { unified: "stop", raw: "stop" }, usage: usage(20_000, 1500), warnings: [] };
      },
    });
    registerLlmAdapter({ kind: "daily-mock", defaultBaseUrl: "mock:", build: () => model });
    const providers: Provider[] = [{ ...buildProvider({ name: "claude-opus-5-5", kind: "daily-mock", model: "m", pricing: { input: 4, output: 20 } }), available: true }];
    const events: AuditEvent[] = [
      { at: "2026-11-25T09:00:00Z", user: "ana@example.org", pack: "shop", board: "b1", action: "chat-turn", outcome: "ok", detail: JSON.stringify({ instruction: "how many sales?", answer: "4", calls: [{ tool: "query", input: { measure: "sales" }, ok: true }], refusals: [] }) },
      { at: "2026-11-25T10:00:00Z", user: "ana@example.org", pack: "usage", board: "overview", action: "chat-turn", outcome: "ok", internal: true, detail: JSON.stringify({ instruction: "SECRET-INTERNAL which board cost most?", answer: "b1", calls: [], refusals: [] }) },
      { at: "2026-11-25T11:00:00Z", user: "ana@example.org", pack: "shop", board: "b1", action: "chat-turn", outcome: "ok", internal: true, detail: JSON.stringify({ instruction: "SECRET-INTERNAL too", answer: "x", calls: [], refusals: [] }) },
    ];
    const r = reviewSystem({ stateDir: dir, hosts: [{ name: "shop", pack, connector, ctx: {} }], features: admin.features, settings: admin.settings, providers: () => providers, events: () => events, now: () => new Date("2026-11-25T12:00:00Z") });
    r.updateSettings({ maxUsd: 0.5 }, "admin");
    const est = await r.estimate();
    expect(est.packs[0]).toMatchObject({ pack: "shop", turns: 1 });
    expect((est.packs[0] as { worstUsd: number }).worstUsd).toBeLessThanOrEqual(0.5);
    const run = await r.runNow("admin");
    expect(calls).toBe(1);
    expect(sent).toContain("how many sales?");
    expect(sent).not.toContain("SECRET-INTERNAL");
    expect(sent).not.toContain("ana@example.org");
    expect(run.status).toBe("ok");
    expect(run.usd).toBeCloseTo(20_000 * 4e-6 + 1500 * 20e-6, 6);
    expect(run.usd).toBeLessThanOrEqual(0.5);
    expect(run.packs[0]!.report?.summary).toBe(report.summary);
    // Stored as JSON, one file per run.
    const files = readdirSync(join(dir, "review-runs"));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "review-runs", files[0]!), "utf8")).packs[0].report.findings).toHaveLength(1);
    // A proposal waits; accepting it writes the overlay, which the next turn reads.
    const [p] = r.proposals("pending");
    expect(p).toBeDefined();
    const v0 = r.definitionsVersion("shop");
    r.acceptProposal(p!.id, "admin");
    expect(r.definitionsVersion("shop")).not.toBe(v0);
    expect(r.overlay("shop").entries()[0]!.text).toContain("Count every sale");
    // The question was logged, and compared on the data (review.compare is on with the review).
    const [q] = r.questions("shop").list("open");
    expect(q?.compared?.readings.map((x) => x.value)).toEqual([4, 3]);
    // Answering it writes a definition.
    const answered = r.answer("shop", q!.id, q!.readings[1]!.id, "admin", "finance counts paid ones");
    expect(answered.entry.kind).toBe("definition");
    expect(r.overlay("shop").entries()).toHaveLength(2);
    await db.close();
  });

  it("refuses a model with no price, so the cap is never unenforced", async () => {
    const dir = tmp();
    const { db, pack, connector } = await shop();
    const admin = adminSettings(dir, {}, {});
    const providers: Provider[] = [{ ...buildProvider({ name: "claude-opus-5-5", kind: "daily-mock", model: "m" }), available: true, pricing: undefined }];
    const events: AuditEvent[] = [{ at: "2026-11-25T09:00:00Z", user: "a", pack: "shop", action: "chat-turn", outcome: "ok", detail: JSON.stringify({ instruction: "q", answer: "a", calls: [], refusals: [] }) }];
    const r = reviewSystem({ stateDir: dir, hosts: [{ name: "shop", pack, connector, ctx: {} }], features: admin.features, settings: admin.settings, providers: () => providers, events: () => events, now: () => new Date("2026-11-25T12:00:00Z") });
    const run = await r.runNow("admin");
    expect(run.status).toBe("failed");
    expect(run.reason).toMatch(/no price/);
    await db.close();
  });
});
