// "How this was worked out" under a chat answer, end to end on a SQL source: the stub model asks
// one breakdown and one computed value; the turn's stream carries one data-explain part with each
// call in plain words, the SQL that ran with its values, and the first rows; the turn's audit line
// keeps the same record, bounded. The switches: explain off, explain.sql: false, and a caller not
// shown compiled statements.
import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDuckdb } from "@lenspack/sql/duckdb";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seed } from "../../../../examples/commerce/seed";
import {
  type AppOptions,
  type AuditEvent,
  EXPLAIN_LIMITS,
  type Explanation,
  type ExplainedCall,
  type Host,
  type Provider,
  adminSettings,
  boundExplanation,
  buildProvider,
  configSchema,
  createApp,
  explainFrom,
  maskCredentials,
  openConfig,
  registerLlmAdapter,
  savedCall,
  turnRow,
} from "../src";

const commerce = fileURLToPath(new URL("../../../../examples/commerce/", import.meta.url));
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const stream = (parts: unknown[]) => ({
  stream: new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  }),
});
const tool = (calls: [string, unknown][]) => [
  ...calls.map(([toolName, input], i) => ({ type: "tool-call", toolCallId: `c${i}${Math.random().toString(36).slice(2)}`, toolName, input: JSON.stringify(input) })),
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const say = (text: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];

// Two data calls in one step, then the answer.
const TOP = { query_kind: "breakdown", measure: "revenue", dimension: "country", limit: 3, filters: "channel = web", time_from: "2026-08-01T00:00:00Z", time_to: "2026-09-01T00:00:00Z" };
const DAILY = { query_kind: "value", measure: "orders", grain: "day", compute: "mean", time_period: "last_month" };
function scripted() {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => stream([tool([["query", TOP], ["query", DAILY]]), say("India led web revenue in August.")][step++ % 2]!),
    doGenerate: async () => ({ content: [{ type: "text", text: "{}" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
  });
}

type Part = { type: string; data?: any };

describe("how an answer was worked out", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-explain-"));
  const servers: Server[] = [];
  let host: Host;
  let close: () => Promise<void>;
  let n = 0;

  beforeAll(async () => {
    const db = await openDuckdb(join(dir, "commerce.duckdb"));
    await seed(db.writer, "duckdb", { orders: 800 });
    await db.close();
    const opened = await openConfig(configSchema.parse({ sources: { data: { kind: "duckdb", path: join(dir, "commerce.duckdb") } }, packs: [{ pack: `${commerce}pack.yaml`, source: "data", now: "2026-09-01T00:00:00Z" }] }), dir);
    host = opened.hosts[0]!;
    close = opened.close;
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    await close();
  });

  const turn = async (options: Partial<AppOptions> = {}) => {
    const name = `m${++n}`;
    const model = scripted();
    registerLlmAdapter({ kind: `explain-${name}`, defaultBaseUrl: "mock:", build: () => model });
    const providers: Provider[] = [{ ...buildProvider({ name, kind: `explain-${name}`, model: "m", pricing: { input: 1, output: 2 } }), available: true }];
    const audited: AuditEvent[] = [];
    const server = createServer(createApp([host], { providers, review: () => false, audit: (e) => audited.push(e), ...options }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${host.name}`;
    // A signed-in caller asks on a board of their own; the open server's one user on the pack's.
    await host.store.create({ id: name, pack: host.pack, title: "Shop", ...(options.access ? { owner: "someone" } : {}) });
    const res = await fetch(`${base}/${name}/chat`, { method: "POST", body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "top countries for web revenue in August, and orders per day last month" }] }] }) });
    const parts = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)) as Part);
    const line = audited.find((e) => e.action === "chat-turn")!;
    return { parts, explain: parts.find((p) => p.type === "data-explain")?.data as Explanation | undefined, line, detail: JSON.parse(line.detail!) };
  };

  it("streams one explanation: each call in words, the SQL that ran with its values, the first rows", async () => {
    const t = await turn();
    const x = t.explain!;
    expect(x.sql).toBe(true);
    expect(x.calls).toHaveLength(2);
    // The calls ran in one step, so in parallel: each is matched by what it asked, not by position.
    const top = x.calls.find((c) => /grouped by country/.test(c.description))!;
    const daily = x.calls.find((c) => /averaged per day/.test(c.description))!;
    expect(top.description).toBe(
      "Revenue (sum of total_cents / 100.0, the pack's approved measure “revenue”), for Sales channel = web, from 1 to 31 August 2026, grouped by country, top 3 by value.",
    );
    expect(top.statements).toHaveLength(1);
    expect(top.statements![0]).toMatchObject({ language: "sql" });
    expect(top.statements![0]!.text).toMatch(/^SELECT .*FROM/s);
    expect(top.statements![0]!.text).toMatch(/LIMIT/);
    expect(top.statements![0]!.params).toEqual(expect.arrayContaining(["'web'"]));
    expect(top.after).toBeUndefined();
    expect(top.columns.map((c) => c.label)).toEqual(["Country", "Revenue", "Records"]);
    expect(top.rows.length).toBeLessThanOrEqual(3);
    expect(top.total).toBe(top.rows.length);
    expect(typeof top.rows[0]![1]).toBe("number");
    // The computed value: its step in words, and the note that the step ran after the SQL, in Lenspack.
    expect(daily.description).toMatch(/^Orders \(count of rows in orders \(one row per order\), the pack's approved measure “orders”\), last month \(1 to 31 August 2026\)\. Then averaged per day over \d+ days \(/);
    expect(daily.description).toMatch(/with days that had no orders counted as 0\.$/);
    expect(daily.after).toMatch(/ran in Lenspack/);
    expect(daily.columns.map((c) => c.label)).toEqual(["Average daily orders"]);
    expect(daily.rows).toHaveLength(1);
    // The explanation goes out before the turn's cost line.
    const order = t.parts.map((p) => p.type);
    expect(order.indexOf("data-explain")).toBeLessThan(order.indexOf("data-usage"));
  });

  it("is kept in the turn's audit line, and the turn list names what each call asked", async () => {
    const t = await turn();
    expect(t.detail.explain).toEqual(t.explain);
    const row = turnRow(t.line)!;
    expect(row.explained).toHaveLength(2);
    expect(row.explained!.some((w) => w.startsWith("Revenue (sum of total_cents"))).toBe(true);
  });

  it("explain.sql: false keeps the words and the rows, not the SQL", async () => {
    const t = await turn({ explain: () => explainFrom({ sql: false }) });
    expect(t.explain!.sql).toBe(false);
    expect(t.explain!.calls).toHaveLength(2);
    for (const c of t.explain!.calls) {
      expect(c.statements).toBeUndefined();
      expect(c.description).toMatch(/approved measure/);
      expect(c.rows.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(t.detail.explain)).not.toMatch(/SELECT/);
  });

  it("switched off, there is none, in the stream or the audit line", async () => {
    const t = await turn({ explain: () => explainFrom(false) });
    expect(t.explain).toBeUndefined();
    expect(t.detail.explain).toBeUndefined();
    expect(t.parts.some((p) => p.type === "data-usage")).toBe(true);
  });

  it("a caller not shown compiled statements gets no SQL and no definitions", async () => {
    const t = await turn({ access: async () => ({ user: "someone", edit: true, hidden: ["p90_order"] }) });
    for (const c of t.explain!.calls) {
      expect(c.statements).toBeUndefined();
      expect(c.description).not.toMatch(/total_cents|count of rows/);
    }
    expect(t.explain!.calls.some((c) => c.description.startsWith("Revenue (the pack's approved measure “revenue”)"))).toBe(true);
  });
});

describe("the explanation's size and safety", () => {
  const call = (i: number, rows = 20, sql = 500): ExplainedCall => ({
    tool: "query",
    description: `Call ${i}`,
    statements: [{ language: "sql", text: "x".repeat(sql) }],
    columns: [{ key: "group", label: "Group" }, { key: "value", label: "Value" }],
    rows: Array.from({ length: rows }, (_, r) => [`group ${r} ${"y".repeat(150)}`, r]),
    total: 400,
  });
  const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x));

  it("keeps a small turn whole", () => {
    const x = { calls: [call(1, 5, 100)], sql: true };
    expect(boundExplanation(x)).toEqual(x);
  });

  it("stays within its bound: fewer rows, shorter statements, then fewer calls, counted", () => {
    const x = boundExplanation({ calls: Array.from({ length: 14 }, (_, i) => call(i, 20, 5000)), sql: true });
    expect(bytes(x)).toBeLessThanOrEqual(EXPLAIN_LIMITS.bytes);
    expect(x.calls.length + (x.more ?? 0)).toBe(14);
    expect(x.calls.length).toBeLessThanOrEqual(EXPLAIN_LIMITS.calls);
    expect(x.calls[0]!.description).toBe("Call 0");
    // Rows are dropped whole, never cut mid-row.
    for (const c of x.calls) for (const r of c.rows) expect(r).toHaveLength(2);
  });

  it("masks anything in a statement that looks like a credential", () => {
    expect(maskCredentials("SELECT * FROM remote('postgres://reader:s3cret@db:5432/x') WHERE password = 'hunter2'")).toBe("SELECT * FROM remote('postgres://***@db:5432/x') WHERE password = ***");
    expect(maskCredentials("SELECT a FROM t WHERE b = $1")).toBe("SELECT a FROM t WHERE b = $1");
  });

  it("a saved answer's call says when its data was read", () => {
    expect(savedCall(call(1, 1), new Date("2026-09-01T06:00:00Z")).saved).toEqual({ asOf: "2026-09-01T06:00:00.000Z" });
  });
});

describe("the explain switches", () => {
  it("the config: on unless false; SQL unless sql: false", () => {
    expect(explainFrom(undefined)).toEqual({ on: true, sql: true });
    expect(explainFrom(false)).toEqual({ on: false, sql: true });
    expect(explainFrom({ sql: false })).toEqual({ on: true, sql: false });
    expect(configSchema.parse({ sources: { d: { url: "duckdb::memory:" } }, packs: [{ pack: "p.yaml", source: "d" }], explain: { sql: false } }).explain).toEqual({ sql: false });
    expect(() => configSchema.parse({ sources: { d: { url: "duckdb::memory:" } }, packs: [{ pack: "p.yaml", source: "d" }], explain: { sql: "no" } })).toThrow();
  });

  it("the feature switch (settings page, env) turns it off; the config's sql: false holds either way", () => {
    const dir = mkdtempSync(join(tmpdir(), "lenspack-explain-admin-"));
    const a = adminSettings(dir, { explain: { sql: false } }, {});
    expect(a.app.explain()).toEqual({ on: true, sql: false });
    expect(a.features.update({ explain: false }).ok).toBe(true);
    expect(a.app.explain()).toEqual({ on: false, sql: false });
    expect(adminSettings(mkdtempSync(join(tmpdir(), "lenspack-explain-env-")), {}, { LENSPACK_FEATURES: "-explain" }).app.explain().on).toBe(false);
  });
});
