// Query safety as the assistant meets it: a guarded connector (the deployment's limits, @lenspack/policy) under the
// board tools, over a real database. A query too heavy is refused in words the model can relay; the rest run.
import { memoryStore } from "@lenspack/core";
import { type QueryGuard, budgetedConnector, guardedConnector, querySlots } from "@lenspack/engine";
import { checkQuery, coarserLevel, querySafety, shapeOf, turnLimitMessage } from "@lenspack/policy";
import { sqlConnector } from "@lenspack/sql";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pack, seedFixture } from "../../../sources/sql/test/fixture-pack";
import { memoryProposals } from "../src/proposals";
import { type Tool, boardTools } from "../src/tools";

const now = new Date("2026-02-15T00:00:00Z");
let db: Awaited<ReturnType<typeof openDuckdb>>;
const store = memoryStore();

// "things" is large: a time range always (the last 30 days when none), and "colour" has a value per record.
const safety = querySafety({ datasets: { things: { heavy: true, defaultWindowDays: 30, highCardinality: ["colour"] } } });
const guard: QueryGuard = (bound, p) => {
  const v = checkQuery(shapeOf(bound), safety, { label: "things", coarser: (k) => coarserLevel(p, k), now });
  return v.ok ? { rowLimit: v.rowLimit, ...(v.window ? { time: v.window } : {}), ...(v.note ? { note: v.note } : {}), timeoutMs: 5000 } : { refuse: v };
};

beforeAll(async () => {
  db = await openDuckdb();
  await seedFixture(db.writer, "duckdb");
  await store.create({ id: "b", pack, title: "Test board" });
});
afterAll(async () => db.close());

const toolsWith = (connector: ReturnType<typeof sqlConnector>) => Object.fromEntries(boardTools({ pack, connector, store, boardId: "b", ctx: { tenant: "t1", now }, proposals: memoryProposals() }).map((t) => [t.name, t])) as Record<string, Tool>;
const call = (tools: Record<string, Tool>, name: string, args: Record<string, unknown>) => tools[name]!.execute(tools[name]!.inputSchema.parse(args) as never) as Promise<any>;

describe("query safety under the board tools", () => {
  it("refuses a breakdown by a per-record column, in words the model can relay", async () => {
    const tools = toolsWith(guardedConnector(sqlConnector(db.executor), guard));
    const r = await call(tools, "query", { query_kind: "breakdown", measure: "things", dimension: "colour", time_last: "30d" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"colour" has a different value for almost every record of things');
    expect(r.error).toContain("Group by a coarser level");
  });

  it("answers a heavy dataset's question with no time range over the default window, and says so", async () => {
    const tools = toolsWith(guardedConnector(sqlConnector(db.executor), guard));
    const r = await call(tools, "query", { query_kind: "value", measure: "things" });
    expect(r.ok).toBe(true);
    // Of tenant t1's five things, three were made in the 30 days before 15 February.
    expect(r.rows[0].value).toBe(3);
    expect(JSON.stringify(r)).toContain("things is large, so this reads the last 30 days only");
    // Asked with a range, the range stands.
    const all = await call(tools, "query", { query_kind: "value", measure: "things", time_last: "90d" });
    expect(all.rows[0].value).toBe(5);
  });

  it("refuses an hourly series over a year on a heavy dataset", async () => {
    const tools = toolsWith(guardedConnector(sqlConnector(db.executor), guard));
    const r = await call(tools, "query", { query_kind: "series", measure: "things", grain: "hour", time_last: "300d" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Use a coarser grain (day instead of hour)");
  });

  it("stops one turn's fan-out past its query budget", async () => {
    const tools = toolsWith(budgetedConnector(sqlConnector(db.executor), 2, turnLimitMessage(2)));
    expect((await call(tools, "query", { query_kind: "value", measure: "things" })).ok).toBe(true);
    expect((await call(tools, "query", { query_kind: "value", measure: "weight" })).ok).toBe(true);
    const third = await call(tools, "query", { query_kind: "value", measure: "broken" });
    expect(third.ok).toBe(false);
    expect(third.error).toBe(turnLimitMessage(2));
  });

  it("runs at most so many queries at once", async () => {
    const slots = querySlots(() => 2);
    let running = 0;
    let most = 0;
    const slow = { ...sqlConnector(db.executor) };
    const inner = slow.execute.bind(slow);
    slow.execute = async (plan, o) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 20));
      try {
        return await inner(plan, o);
      } finally {
        running--;
      }
    };
    const tools = toolsWith(guardedConnector(slow, () => null, { slots }));
    const answers = await Promise.all(["things", "weight", "broken", "distinct_owners", "median_size"].map((m) => call(tools, "query", { query_kind: "value", measure: m, time_last: "90d" })));
    expect(answers.every((a) => a.ok)).toBe(true);
    expect(most).toBe(2);
    expect(slots.running()).toBe(0);
  });
});

describe("query safety's defaults and the repository's examples", () => {
  it("refuses none of the example packs' example questions or board widgets", async () => {
    const { readFileSync, readdirSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { parsePackText } = await import("@lenspack/pack");
    const { SQL_CAPABILITIES, explain, ResolveError } = await import("@lenspack/engine");
    const root = fileURLToPath(new URL("../../../../examples/", import.meta.url));
    const defaults = querySafety();
    const seen: string[] = [];
    // Explain compiles every query a widget sends (each operand, each further measure), through the guard, without running it.
    const stub = { kind: "postgres", capabilities: SQL_CAPABILITIES, compile: (bound: never) => ({ text: "", native: null, bound }), execute: async () => ({ rows: [], total: 0, format: "number" as const }) };
    const connector = guardedConnector(stub as never, (bound) => {
      const v = checkQuery(shapeOf(bound), defaults, { now });
      return v.ok ? null : { refuse: v };
    });
    for (const name of readdirSync(root)) {
      const file = join(root, name, "pack.yaml");
      if (!existsSync(file)) continue;
      const p = parsePackText(readFileSync(file, "utf8"));
      const queries = [...p.examples.map((e) => e.query)];
      const boards = join(root, name, "boards");
      if (existsSync(boards))
        for (const f of readdirSync(boards).filter((x) => x.endsWith(".json")))
          for (const op of (JSON.parse(readFileSync(join(boards, f), "utf8")) as { ops: { op: string; widget?: { query?: unknown } }[] }).ops) if (op.widget?.query) queries.push(op.widget.query as never);
      for (const q of queries) {
        seen.push(name);
        try {
          await explain(q as never, { pack: p, connector: connector as never, ctx: { now, tenant: "t" } });
        } catch (e) {
          if (!(e instanceof ResolveError)) throw e;
          // Only a refusal by the limits fails this; the rest are the example's own business (a tenant, a capability).
          expect(e.code, `${name}: ${JSON.stringify(q)}: ${e.message}`).not.toBe("TOO_HEAVY");
        }
      }
    }
    expect(seen.length).toBeGreaterThan(20);
  });
});
