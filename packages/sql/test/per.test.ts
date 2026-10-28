import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Query } from "@lenspack/core";
import { ResolveError, check, run } from "@lenspack/engine";
import { parsePack } from "@lenspack/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Executor, type Writer, sqlConnector } from "../src/executor";
import { openDuckdb } from "../src/executors/duckdb";
import { openSqlite } from "../src/executors/sqlite";

// Two-stage measures, run on DuckDB and SQLite, against the same numbers
// written by hand as SQL over the same rows.

const pack = parsePack({
  pack: "turns",
  version: 1,
  entities: { turns: { source: "turns", time: "ts" } },
  dimensions: [{ key: "channel", entity: "turns", field: "channel" }],
  measures: [
    { key: "users", entity: "turns", agg: "count_distinct", field: "user_id" },
    { key: "turns_per_session", entity: "turns", agg: "avg", per: { key: "session_id", agg: "count" } },
    { key: "median_turns_per_session", entity: "turns", agg: "median", per: { key: "session_id", agg: "count" } },
    { key: "askers", entity: "turns", agg: "count", per: { key: "user_id", agg: "count", where: [{ field: "role", op: "eq", value: "user" }], having: { op: "gte", value: 3 } } },
    { key: "returning", entity: "turns", agg: "count", per: { key: "user_id", agg: "count_distinct", sql: { duckdb: "CAST(ts AS DATE)", sqlite: "date(ts)" }, having: { op: "gte", value: 2 } } },
    { key: "returning_share", entity: "turns", derived: "returning / users" },
  ],
});

// 60 sessions of 1 to 6 turns by 18 users over three months, each session on one channel, so
// most users have sessions on both.
function turns(): unknown[][] {
  let a = 7;
  const next = () => ((a = (a * 1103515245 + 12345) % 2147483648), a / 2147483648);
  const out: unknown[][] = [];
  for (let s = 1; s <= 60; s++) {
    const user = 1 + Math.floor(next() * 18);
    const channel = next() < 0.5 ? "web" : "app";
    const start = Date.UTC(2025, 11, 1) + Math.floor(next() * 90) * 86400e3 + 9 * 3600e3;
    const n = 1 + Math.floor(next() * 6);
    for (let i = 0; i < n; i++) out.push([out.length + 1, s, user, channel, i % 2 ? "assistant" : "user", new Date(start + i * 60e3).toISOString().slice(0, 19).replace("T", " ")]);
  }
  return out;
}

async function seed(writer: Writer, type: string) {
  await writer.exec(`CREATE TABLE turns (id INTEGER, session_id INTEGER, user_id INTEGER, channel VARCHAR, role VARCHAR, ts ${type})`);
  const values = turns().map((r) => `(${r.map((v) => (typeof v === "number" ? v : `'${v}'`)).join(", ")})`);
  await writer.exec(`INSERT INTO turns VALUES ${values.join(", ")}`);
}

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "lenspack-per-"));
const ENGINES = [
  { name: "duckdb", open: () => openDuckdb(), type: "TIMESTAMP", day: "CAST(ts AS DATE)", week: "date_trunc('week', ts)" },
  { name: "sqlite", open: () => openSqlite(join(dir, "turns.db")), type: "TEXT", day: "date(ts)", week: "date(ts, '-' || ((CAST(strftime('%w', ts) AS INTEGER) + 6) % 7) || ' days')" },
];
const dbs: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const db of dbs) await db.close();
  rmSync(dir, { recursive: true, force: true });
});

const jan = { from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" };
const inJan = "ts >= '2026-01-01 00:00:00' AND ts < '2026-02-01 00:00:00'";
const inDec = "ts >= '2025-12-01 00:00:00' AND ts < '2026-01-01 00:00:00'";

for (const engine of ENGINES) {
  describe(engine.name, () => {
    let executor: Executor;
    beforeAll(async () => {
      const db = await engine.open();
      dbs.push(db);
      await seed(db.writer, engine.type);
      executor = db.executor;
    });
    const ask = (query: Query) => run(query, { pack, connector: sqlConnector(executor) });
    // The first row of a hand-written answer, as numbers.
    const hand = async (sql: string) => Object.values((await executor.query(sql, []))[0]!).map(Number);

    it("averages the per-session counts", async () => {
      const data = await ask({ kind: "value", measure: "turns_per_session" });
      const [mean, sessions] = await hand("SELECT avg(n), count(*) FROM (SELECT session_id, count(*) AS n FROM turns GROUP BY session_id) s");
      expect(data.rows[0]!.value).toBeCloseTo(mean!, 9);
      expect(data.rows[0]!.count).toBe(sessions);
    });

    it("counts keys that pass having, a key in two groups counting in each", async () => {
      const data = await ask({ kind: "breakdown", dimension: "channel", measure: "askers", limit: 10, sort: "desc" });
      const expected = await executor.query(
        "SELECT channel AS g, count(*) AS v FROM (SELECT channel, user_id FROM turns WHERE role = 'user' GROUP BY channel, user_id HAVING count(*) >= 3) s GROUP BY channel ORDER BY channel",
        [],
      );
      expect(data.rows.map((r) => [r.group, r.value]).sort()).toEqual(expected.map((r) => [r.g, Number(r.v)]));
    });

    it("groups by key within each series bucket, after the window", async () => {
      const data = await ask({ kind: "series", measure: "turns_per_session", grain: "week", time: jan });
      const expected = await executor.query(`SELECT avg(n) AS v FROM (SELECT session_id, ${engine.week} AS w, count(*) AS n FROM turns WHERE ${inJan} GROUP BY 1, 2) s GROUP BY w ORDER BY w`, []);
      expect(data.rows.map((r) => r.value)).toEqual(expected.map((r) => expect.closeTo(Number(r.v), 9)));
    });

    it("compares with the previous period, each period grouped on its own", async () => {
      const data = await ask({ kind: "value", measure: "askers", compare: "previous_period", time: jan });
      const askers = (window: string) => `SELECT count(*) FROM (SELECT user_id FROM turns WHERE role = 'user' AND ${window} GROUP BY user_id HAVING count(*) >= 3) s`;
      const [now] = await hand(askers(inJan));
      const [before] = await hand(askers(inDec));
      expect([data.rows[0]!.value, data.compare!.previous]).toEqual([now, before]);
    });

    it("divides a two-stage measure by a plain one, each computed on its own", async () => {
      const data = await ask({ kind: "value", measure: "returning_share" });
      const [returning] = await hand(`SELECT count(*) FROM (SELECT user_id FROM turns GROUP BY user_id HAVING count(DISTINCT ${engine.day}) >= 2) s`);
      const [users] = await hand("SELECT count(DISTINCT user_id) FROM turns");
      expect(data.rows[0]!.value).toBeCloseTo(returning! / users!, 9);
    });

    it(engine.name === "duckdb" ? "takes the median of the per-session counts" : "refuses a median it cannot compute", async () => {
      const data = await ask({ kind: "value", measure: "median_turns_per_session" });
      if (engine.name === "sqlite") return expect(data.error).toMatch(/has no percentile function/);
      const [median] = await hand("SELECT quantile_cont(n, 0.5) FROM (SELECT session_id, count(*) AS n FROM turns GROUP BY session_id) s");
      expect(data.rows[0]!.value).toBeCloseTo(median!, 9);
    });
  });
}

it("is refused by a source that cannot aggregate in two stages", () => {
  const caps = { joins: false, exactDistinct: false, exactPercentiles: false, twoStage: false };
  expect(() => check({ kind: "value", measure: "askers" }, pack, { capabilities: caps })).toThrow(ResolveError);
  expect(() => check({ kind: "value", measure: "returning_share" }, pack, { capabilities: caps })).toThrow(/cannot aggregate in two stages/);
});
