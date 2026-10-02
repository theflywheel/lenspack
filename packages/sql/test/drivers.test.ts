import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type WidgetData, run } from "@lenspack/engine";
import { parsePack } from "@lenspack/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Connection, type Driver, driverFor, drivers, filePath, openSource, registerDriver, schemeOf } from "../src/driver";
import { capabilitiesFor } from "../src/dialects";
import { type Executor, type Writer, sqlConnector } from "../src/executor";
import { openClickhouse } from "../src/executors/clickhouse";
import { openDuckdb } from "../src/executors/duckdb";
import { openMysql } from "../src/executors/mysql";
import { openPostgres } from "../src/executors/pg";
import { openSqlite } from "../src/executors/sqlite";
import { postgresRules } from "../src/print/postgres";
import { runSql } from "../src/run-sql";
import { GOLDEN_QUERIES, ctx, goldenPackInput } from "./golden-pack";

// Every driver, end to end: the URL picks it, the golden queries (every node
// the planner emits) return DuckDB's numbers or the documented refusal, and
// the guards hold in the driver whatever the caller sends: a write is
// refused, so is a second statement, the timeout stops a statement, and a
// result over the row cap is an error rather than a silently shorter answer.
//
// DuckDB and SQLite need nothing; the others run when their URL is set.

describe("the registry", () => {
  it("picks a driver by scheme", () => {
    expect(driverFor("postgres://u:p@h/db").name).toBe("postgres");
    expect(driverFor("postgresql://h/db").name).toBe("postgres");
    expect(driverFor("duckdb:///data/x.duckdb").name).toBe("duckdb");
    expect(driverFor("duckdb::memory:").name).toBe("duckdb");
    expect(driverFor("sqlite:./x.db").name).toBe("sqlite");
    expect(driverFor("mysql://h/db").name).toBe("mysql");
    expect(driverFor("mariadb://h/db").name).toBe("mysql");
    expect(driverFor("ClickHouse://h:8123/db").name).toBe("clickhouse");
    expect(drivers().map((d) => d.name).sort()).toEqual(["clickhouse", "duckdb", "mysql", "postgres", "sqlite"]);
  });

  it("names the known schemes when it has no driver", () => {
    expect(() => driverFor("bigquery://project/dataset")).toThrow(/No driver for "bigquery:".*postgres:.*clickhouse:/);
    expect(() => driverFor("/just/a/path")).toThrow(/No driver for this URL/);
    expect(schemeOf("elasticsearch://x")).toBe("elasticsearch");
  });

  it("reads file paths from file-database URLs", () => {
    expect(filePath("duckdb:///data/shop.duckdb")).toBe("/data/shop.duckdb");
    expect(filePath("duckdb::memory:")).toBe(":memory:");
    expect(filePath("sqlite:./shop.db", "/srv/app")).toBe("/srv/app/shop.db");
    expect(filePath("sqlite://shop.db", "/srv/app")).toBe("/srv/app/shop.db");
    expect(filePath("sqlite:///abs/my%20shop.db?mode=ro")).toBe("/abs/my shop.db");
  });

  it("takes a third-party driver without touching core, dialect and all", async () => {
    let seen: { sql: string; params: unknown[] } | null = null;
    const fake: Driver = {
      name: "acme",
      schemes: ["acme"],
      dialect: { ...postgresRules, dialect: "acme", param: () => "?", capabilities: { percentiles: false } },
      async connect(): Promise<Connection> {
        const executor: Executor = { dialect: "acme", query: async (sql, params) => ((seen = { sql, params }), [{ value: 3, n: 3 }]) };
        return { executor, introspect: async () => ({ collections: [] }), close: async () => undefined };
      },
    };
    registerDriver(fake);
    const { connector } = await openSource("acme://anywhere");
    expect(connector.kind).toBe("acme");
    expect(connector.capabilities.percentiles).toBe(false);
    const pack = parsePack({
      pack: "p",
      version: 1,
      entities: { rows: { source: "rows" } },
      measures: [{ key: "n", entity: "rows", agg: "count", filter: { acme: "flag = 1", postgres: "flag" } }],
    });
    const data = await run({ kind: "value", measure: "n" }, { pack, connector });
    expect(data.rows[0]?.value).toBe(3);
    // Its own fragment, its own placeholders.
    expect(seen!.sql).toContain("(flag = 1)");
    expect(capabilitiesFor("acme").percentiles).toBe(false);
  });
});

// The golden pack over unqualified tables, so every database can hold it.
const pack = parsePack({
  ...goldenPackInput,
  entities: Object.fromEntries(Object.entries(goldenPackInput.entities).map(([k, e]) => [k, { ...e, source: `drv_${k}` }])),
});

type Col = [name: string, type: "int" | "bigint" | "text" | "double" | "bool" | "ts" | "json"];
const TABLES: Record<string, Col[]> = {
  drv_things: [["id", "int"], ["tenant_id", "text"], ["owner_id", "int"], ["colour", "text"], ["size", "int"], ["weight_g", "int"], ["status", "text"], ["attrs", "json"], ["path", "text"], ["kind", "text"], ["label", "text"], ["note", "text"], ["deleted", "bool"], ["made_at", "ts"]],
  drv_owners: [["id", "int"], ["tier", "text"]],
  drv_parts: [["id", "int"], ["tenant_id", "text"], ["thing_id", "int"], ["kind", "text"], ["added_ms", "bigint"]],
  drv_logs: [["id", "int"], ["level", "text"], ["at_s", "bigint"]],
  drv_events: [["id", "int"], ["t", "bigint"]],
};
const TYPES: Record<string, Record<Col[1], string>> = {
  postgres: { int: "INTEGER", bigint: "BIGINT", text: "VARCHAR", double: "DOUBLE PRECISION", bool: "BOOLEAN", ts: "TIMESTAMP", json: "JSONB" },
  duckdb: { int: "INTEGER", bigint: "BIGINT", text: "VARCHAR", double: "DOUBLE", bool: "BOOLEAN", ts: "TIMESTAMP", json: "JSON" },
  sqlite: { int: "INTEGER", bigint: "INTEGER", text: "TEXT", double: "REAL", bool: "BOOLEAN", ts: "TEXT", json: "TEXT" },
  // A binary collation: MySQL's default one folds case, so "Red" and "red" would be one group (see below).
  mysql: { int: "INT", bigint: "BIGINT", text: "VARCHAR(255) COLLATE utf8mb4_bin", double: "DOUBLE", bool: "BOOLEAN", ts: "DATETIME(3)", json: "JSON" },
  clickhouse: { int: "Int32", bigint: "Int64", text: "String", double: "Float64", bool: "Bool", ts: "DateTime64(3, 'UTC')", json: "String" },
};

function rows(): Record<string, unknown[][]> {
  let a = 17;
  const next = () => ((a = (a * 1103515245 + 12345) % 2147483648), a / 2147483648);
  const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]!;
  const ts = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
  const base = new Date("2025-11-01T00:00:00Z").getTime();
  const span = new Date("2026-02-15T12:00:00Z").getTime() - base;
  const things = Array.from({ length: 240 }, (_, i) => {
    const grade = pick(["a", "b", null]);
    return [
      i + 1,
      pick(["ke_1", "ke_1", "ke_1.north", "ke_10", "keX1", "ug"]),
      pick([1, 2, 3, 4]),
      pick(["red", "Red", "blue", "green", "RED-ED", null]),
      Math.floor(next() * 100),
      Math.floor(next() * 9000),
      pick(["ok", "ok", "broken"]),
      JSON.stringify(grade ? { origin: pick(["north", "south"]), meta: { grade } } : { origin: pick(["east", "west"]) }),
      pick(["A|B%1|C", "A|B|C", "a_b", "a_b.x", "aXb.y", "C", null]),
      pick(["test", "real", null]),
      pick(["x", null]),
      pick(["y", null]),
      next() < 0.1,
      ts(new Date(base + Math.floor(next() * span / 1000) * 1000)),
    ];
  });
  return {
    drv_things: things,
    drv_owners: [[1, "gold"], [2, "silver"], [3, "gold"], [4, null]],
    drv_parts: Array.from({ length: 300 }, (_, i) => [i + 1, pick(["ke_1", "ke_1.north", "ug"]), 1 + Math.floor(next() * 240), pick(["bolt", "nut"]), base + Math.floor(next() * span)]),
    drv_logs: Array.from({ length: 200 }, (_, i) => [i + 1, pick(["info", "warn", "error"]), Math.floor((base + next() * span) / 1000)]),
    drv_events: Array.from({ length: 200 }, (_, i) => [i + 1, Math.floor((base + next() * span) / 1000)]),
  };
}

async function seed(writer: Writer, dialect: string) {
  const data = rows();
  const q = dialect === "mysql" ? (s: string) => `\`${s}\`` : (s: string) => `"${s}"`;
  for (const [table, cols] of Object.entries(TABLES)) {
    await writer.exec(`DROP TABLE IF EXISTS ${table}`);
    const defs = cols.map(([c, t]) => `${q(c)} ${dialect === "clickhouse" && c !== "id" ? `Nullable(${TYPES[dialect]![t]})` : TYPES[dialect]![t]}`);
    await writer.exec(`CREATE TABLE ${table} (${defs.join(", ")})${dialect === "clickhouse" ? " ENGINE = MergeTree ORDER BY id" : ""}`);
    const values = data[table]!.map((r) => r.map((v) => (typeof v === "number" && Math.abs(v) > 2_147_483_647 && dialect === "duckdb" ? BigInt(v) : v)));
    if (writer.insert) await writer.insert(table, cols.map(([c]) => q(c)), values);
    else for (const r of values) await writer.exec(`INSERT INTO ${table} VALUES (${r.map((_, i) => `$${i + 1}`).join(", ")})`, r);
  }
}

type Engine = { name: string; dialect: string; url?: string; open(): Promise<{ writer: Writer; close(): Promise<void> }> };
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "lenspack-drivers-"));
const ENGINES: Engine[] = [
  { name: "postgres", dialect: "postgres", url: process.env.LENSPACK_PG_URL ?? "postgres://localhost:5432/lenspack_test", open: () => openPostgres(ENGINES[0]!.url!) },
  { name: "sqlite", dialect: "sqlite", url: `sqlite://${join(dir, "golden.db")}`, open: () => openSqlite(join(dir, "golden.db")) },
  { name: "duckdb file", dialect: "duckdb", url: `duckdb://${join(dir, "golden.duckdb")}`, open: () => openDuckdb(join(dir, "golden.duckdb")) },
  { name: "mysql", dialect: "mysql", url: process.env.LENSPACK_MYSQL_URL, open: () => openMysql(process.env.LENSPACK_MYSQL_URL!) },
  { name: "mariadb", dialect: "mysql", url: process.env.LENSPACK_MARIADB_URL, open: () => openMysql(process.env.LENSPACK_MARIADB_URL!) },
  { name: "clickhouse", dialect: "clickhouse", url: process.env.LENSPACK_CLICKHOUSE_URL, open: () => openClickhouse(process.env.LENSPACK_CLICKHOUSE_URL!) },
];

// A statement each database takes well over the timeout to finish.
const SLOW: Record<string, string> = {
  postgres: "SELECT pg_sleep(5)",
  duckdb: "SELECT sum(a.range * b.range) AS s FROM range(100000000) a, range(1000) b",
  sqlite: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT max(x) AS m FROM c",
  mysql: "SELECT count(*) AS n FROM information_schema.columns a, information_schema.columns b, information_schema.columns c",
  clickhouse: "SELECT count() AS n FROM numbers(1000000000000)",
};

let reference: Awaited<ReturnType<typeof openDuckdb>>;
const live = new Map<string, { executor: Executor; capped: Executor; close(): Promise<void> }>();

beforeAll(async () => {
  reference = await openDuckdb();
  await seed(reference.writer, "duckdb");
  await Promise.all(
    ENGINES.map(async (engine) => {
      if (!engine.url) return;
      try {
        const db = await engine.open();
        await seed(db.writer, engine.dialect);
        await db.close();
        // Queried as a source is: through its URL, read-only.
        const { connection } = await openSource(engine.url);
        const capped = await driverFor(engine.url).connect(engine.url, { maxRows: 5 });
        live.set(engine.name, { executor: connection.executor, capped: capped.executor, close: async () => (await connection.close(), await capped.close()) });
      } catch (e) {
        console.warn(`[drivers] ${engine.name} not reachable; skipped (${String(e).slice(0, 160)})`);
      }
    }),
  );
}, 120_000);
afterAll(async () => {
  await reference.close();
  for (const e of live.values()) await e.close();
  rmSync(dir, { recursive: true, force: true });
});

const close = (a: unknown, b: unknown): boolean => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object")
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  return a === b;
};
const sorted = (d: WidgetData) => ({ ...d, rows: [...d.rows].sort((x, y) => `${x.group}|${x.series ?? ""}`.localeCompare(`${y.group}|${y.series ?? ""}`)) });

for (const engine of ENGINES) {
  describe(engine.name, () => {
    it("answers every golden query as DuckDB does, or refuses a percentile it cannot compute", async ({ skip }) => {
      const e = live.get(engine.name);
      if (!e) return skip();
      const mine = sqlConnector(e.executor);
      const theirs = sqlConnector(reference.executor);
      let refused = 0;
      for (const query of GOLDEN_QUERIES) {
        const a = await run(query, { pack, connector: theirs, ctx });
        const b = await run(query, { pack, connector: mine, ctx });
        expect(a.error, JSON.stringify(query)).toBeUndefined();
        if (b.error && mine.capabilities.percentiles === false && /has no percentile function/.test(b.error)) {
          expect(["median_size", "p90_size"]).toContain((query as { measure: string }).measure);
          refused++;
          continue;
        }
        if (!close(sorted(b), sorted(a))) expect(sorted(b), JSON.stringify(query)).toEqual(sorted(a));
      }
      expect(refused).toBe(mine.capabilities.percentiles === false ? 2 : 0);
    });

    it("refuses a write, and a second statement, whatever the caller sends", async ({ skip }) => {
      const e = live.get(engine.name);
      if (!e) return skip();
      const count = async () => Number((await e.executor.query("SELECT count(*) AS n FROM drv_owners", []))[0]!.n);
      expect(await count()).toBe(4);
      await expect(e.executor.query("DELETE FROM drv_owners", [])).rejects.toThrow();
      await expect(e.executor.query("INSERT INTO drv_owners (id, tier) VALUES (9, 'x')", [])).rejects.toThrow();
      await expect(e.executor.query("DROP TABLE drv_owners", [])).rejects.toThrow();
      await expect(e.executor.query("SELECT 1 AS one; DELETE FROM drv_owners", [])).rejects.toThrow();
      // run_sql's own rules still hold, on top of the driver's.
      await expect(runSql("SELECT 1 AS one; SELECT 2 AS two", e.executor)).rejects.toThrow(/One statement/);
      await expect(runSql("WITH x AS (SELECT 1 AS one) SELECT one FROM x", e.executor)).resolves.toMatchObject({ rowCount: 1 });
      expect(await count()).toBe(4);
    });

    it("stops a statement at the timeout, and keeps working after", async ({ skip }) => {
      const e = live.get(engine.name);
      if (!e) return skip();
      const started = Date.now();
      await expect(e.executor.query(SLOW[engine.dialect]!, [], { timeoutMs: 300 })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(4000);
      expect(Number((await e.executor.query("SELECT count(*) AS n FROM drv_owners", []))[0]!.n)).toBe(4);
    });

    it("refuses a result over the row cap rather than cutting it short", async ({ skip }) => {
      const e = live.get(engine.name);
      if (!e) return skip();
      await expect(e.capped.query("SELECT id FROM drv_things", [])).rejects.toThrow(/more than 5 rows, the row cap/);
      expect(await e.capped.query("SELECT id FROM drv_owners", [])).toHaveLength(4);
    });

    if (engine.dialect === "mysql")
      it("groups text by the column's collation: a case-insensitive one folds case, as documented", async ({ skip }) => {
        const e = live.get(engine.name);
        if (!e) return skip();
        const rows = await e.executor.query("SELECT CAST(tier AS CHAR) COLLATE utf8mb4_0900_ai_ci AS g, count(*) AS n FROM (SELECT 'Gold' AS tier UNION ALL SELECT 'gold') q GROUP BY g".replace("utf8mb4_0900_ai_ci", engine.name === "mariadb" ? "utf8mb4_general_ci" : "utf8mb4_0900_ai_ci"), []);
        expect(rows).toHaveLength(1);
        expect(Number(rows[0]!.n)).toBe(2);
      });

    it("describes itself: tables, columns, types and row counts", async ({ skip }) => {
      if (!live.has(engine.name)) return skip();
      const { connection } = await openSource(engine.url!);
      try {
        const schema = await connection.introspect();
        const owners = schema.collections.find((c) => c.name === "drv_owners");
        expect(owners?.fields.map((f) => f.path)).toEqual(["id", "tier"]);
        expect(owners?.fields[0]?.type).toMatch(/int/i);
        const things = schema.collections.find((c) => c.name === "drv_things");
        expect(things?.fields).toHaveLength(14);
        // Row counts are the database's own estimate where it keeps one (Postgres before ANALYZE has none).
        if (things?.rows !== undefined) expect(things.rows).toBeGreaterThanOrEqual(0);
        if (engine.dialect !== "postgres" && engine.dialect !== "mysql") expect(things?.rows).toBe(240);
      } finally {
        await connection.close();
      }
    });
  });
}
