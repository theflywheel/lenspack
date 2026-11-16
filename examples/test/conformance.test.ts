import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Query } from "@lenspack/core";
import { applyOps, emptyBoard } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/spec";
import { type Connector, type Executor, ResolveError, type WidgetData, type Writer, check, compile, openSource, resolveBoard, run, sqlConnector } from "@lenspack/sql";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Dialect } from "../_shared/seed-util";
import { type ExampleName, SMALL, buildBoard, contextFor, examples } from "../index";

// The genericity proof, parts one, two and four. One test suite runs over
// every pack; every dimension × measure × shape either compiles or fails with
// a documented reason; and every driver returns DuckDB's numbers for every
// board and every one of those queries, from the same seeded rows. A number a
// dialect cannot compute (a percentile on MySQL or SQLite) must come back as
// the documented refusal, never as a different number.
//
// DuckDB runs in-process and is the reference. The others run when their URL
// is set (CI starts each as a service); SQLite needs nothing.

const NAMES = Object.keys(examples) as ExampleName[];
const REFUSALS = new Set(["FANOUT_REFUSED", "NO_JOIN_PATH", "TIME_DIMENSION", "NO_TIME"]);
const PERCENTILE_REFUSAL = /has no percentile function/;

type Engine = { name: string; dialect: Dialect; url?: string; seed(): Promise<{ writer: Writer; close(): Promise<void> }> };
const sqliteDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "lenspack-conformance-"));
const ENGINES: Engine[] = [
  { name: "postgres", dialect: "postgres", url: process.env.LENSPACK_PG_URL ?? "postgres://localhost:5432/lenspack_test", seed: async () => (await import("@lenspack/sql/pg")).openPostgres(ENGINES[0]!.url!) },
  { name: "mysql", dialect: "mysql", url: process.env.LENSPACK_MYSQL_URL, seed: async () => (await import("@lenspack/sql/mysql")).openMysql(process.env.LENSPACK_MYSQL_URL!) },
  { name: "mariadb", dialect: "mysql", url: process.env.LENSPACK_MARIADB_URL, seed: async () => (await import("@lenspack/sql/mysql")).openMysql(process.env.LENSPACK_MARIADB_URL!) },
  { name: "sqlite", dialect: "sqlite", url: `sqlite://${join(sqliteDir, "examples.db")}`, seed: async () => (await import("@lenspack/sql/sqlite")).openSqlite(join(sqliteDir, "examples.db")) },
  { name: "clickhouse", dialect: "clickhouse", url: process.env.LENSPACK_CLICKHOUSE_URL, seed: async () => (await import("@lenspack/sql/clickhouse")).openClickhouse(process.env.LENSPACK_CLICKHOUSE_URL!) },
];

const duck: Partial<Record<ExampleName, Awaited<ReturnType<typeof openDuckdb>>>> = {};
// Engines that were reachable and seeded, each opened through its URL as a source would be.
const live = new Map<string, { connector: Connector & { executor: Executor }; close(): Promise<void> }>();

beforeAll(async () => {
  for (const name of NAMES) {
    const db = await openDuckdb();
    await examples[name].seed(db.writer, "duckdb", SMALL[name] as never);
    duck[name] = db;
  }
  await Promise.all(
    ENGINES.map(async (engine) => {
      if (!engine.url) return;
      let seeded: Awaited<ReturnType<Engine["seed"]>> | null = null;
      try {
        seeded = await engine.seed();
        for (const name of NAMES) await examples[name].seed(seeded.writer, engine.dialect, SMALL[name] as never);
        const { connector, connection } = await openSource(engine.url);
        live.set(engine.name, { connector, close: connection.close });
      } catch (e) {
        console.warn(`[conformance] ${engine.name} not reachable or not seeded; its checks are skipped (${String(e).slice(0, 160)})`);
      } finally {
        await seeded?.close();
      }
    }),
  );
}, 600_000);
afterAll(async () => {
  for (const db of Object.values(duck)) await db.close();
  for (const e of live.values()) await e.close();
  rmSync(sqliteDir, { recursive: true, force: true });
});

// Numbers agree to a part in a billion: a float sum and an exact one differ
// past that, and nothing a chart draws depends on it.
function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => (a as Record<string, unknown>)[k] !== undefined || (b as Record<string, unknown>)[k] !== undefined));
    return [...keys].every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

function normalise(data: WidgetData) {
  return {
    rows: [...data.rows].sort((a, b) => `${a.group}|${a.series ?? ""}`.localeCompare(`${b.group}|${b.series ?? ""}`)),
    records: data.records,
    total: data.total,
    format: data.format,
    compare: data.compare,
    error: data.error,
  };
}

/** The engine's answer is DuckDB's, or the documented refusal of a percentile it cannot compute. */
function agrees(engine: string, label: string, mine: WidgetData, reference: WidgetData, refusesPercentiles: boolean) {
  if (refusesPercentiles && mine.error && PERCENTILE_REFUSAL.test(mine.error)) return "refused";
  const a = normalise(reference);
  const b = normalise(mine);
  if (!same(b, a)) expect(b, `${engine}: ${label}`).toEqual(a);
  return "same";
}

const usesPercentile = (pack: (typeof examples)[ExampleName]["pack"], key: string): boolean => {
  const m = pack.measures.find((x) => x.key === key);
  if (!m) return false;
  if (m.agg === "median" || m.agg === "p90") return true;
  return !!m.derived && pack.measures.some((o) => m.derived!.includes(o.key) && o.key !== m.key && usesPercentile(pack, o.key));
};

/** Every query the "compiles or refuses" sweep asks of a measure. */
function sweep(pack: (typeof examples)[ExampleName]["pack"], measure: string): [string, Query][] {
  const dims = pack.dimensions.filter((d) => d.type !== "time");
  return [
    ...dims.map((d): [string, Query] => [`breakdown:${d.key}`, { kind: "breakdown", dimension: d.key, measure, limit: 5, sort: "desc" }]),
    ["value", { kind: "value", measure }],
    ["series", { kind: "series", measure, grain: "week" }],
    ["value:compare", { kind: "value", measure, compare: "previous_period", time: { last: "30d" } }],
  ];
}

for (const name of NAMES) {
  const { pack } = examples[name];
  const catalogue = catalogueFrom(pack);
  const ctx = contextFor[name];

  describe(`${name}: the core ops suite holds for this catalogue`, () => {
    const dims = catalogue.dimensions.filter((d) => d.type !== "time");
    const m0 = catalogue.measures.find((m) => catalogue.entities.find((e) => e.key === m.entity)?.hasTime)!;

    it("adds, filters, removes without a domain word in the core", () => {
      let config = emptyBoard(pack, "T");
      const add = applyOps(
        config,
        [
          { op: "add_widget", id: "a", widget: { kind: "kpi", title: "K", query: { kind: "value", measure: m0.key }, aggregate: "last" }, placement: { place: "top", width: "third" } },
          { op: "add_widget", id: "b", widget: { kind: "chart", chart: "line", title: "S", query: { kind: "series", measure: m0.key, grain: "day" }, options: { legend: true, colorScheme: "default" } } },
          { op: "add_filter", filter: { id: "f", type: "select", label: dims[0]!.label, field: dims[0]!.key, applies: ["*"] } },
        ],
        catalogue,
      );
      expect(add.ok, JSON.stringify(add)).toBe(true);
      if (!add.ok) return;
      config = add.config;
      expect(applyOps(config, [{ op: "add_widget", id: "a", widget: config.widgets.a! }], catalogue).ok).toBe(false);
      const bad = applyOps(config, [{ op: "add_filter", filter: { id: "g", type: "select", label: "x", field: `${dims[0]!.key}x`, applies: ["*"] } }], catalogue);
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.hint).toBe(dims[0]!.key);
      const removed = applyOps(config, [{ op: "remove_widget", id: "a" }, { op: "remove_widget", id: "b" }], catalogue);
      expect(removed.ok && Object.keys(removed.config.widgets).length).toBe(0);
      // A filter that applies to "*" is not pinned to any widget, so it stays.
      expect(removed.ok && removed.config.filters.length).toBe(1);
    });
  });

  describe(`${name}: every dimension × measure × shape compiles or refuses with a reason`, () => {
    const dims = pack.dimensions.filter((d) => d.type !== "time");
    for (const m of pack.measures) {
      it(`measure ${m.key}`, async () => {
        const executor = duck[name]!.executor;
        const outcomes: Record<string, string> = {};
        const attempt = async (label: string, query: Query) => {
          try {
            check(query, pack, { ctx });
          } catch (e) {
            if (e instanceof ResolveError && REFUSALS.has(e.code)) {
              outcomes[label] = e.code;
              return;
            }
            throw e;
          }
          const data = await run(query, { pack, connector: sqlConnector(executor), ctx });
          expect(data.error, `${label}: ${data.error}`).toBeUndefined();
          outcomes[label] = "ok";
        };
        for (const [label, query] of sweep(pack, m.key)) await attempt(label, query);
        // Something must be answerable for every measure, or the pack is wrong.
        expect(Object.values(outcomes).filter((o) => o === "ok").length).toBeGreaterThan(0);
      });
    }
    it("rows on every entity with its own dimensions", async () => {
      for (const [entity] of Object.entries(pack.entities)) {
        const cols = pack.dimensions.filter((d) => d.entity === entity && d.type !== "time").map((d) => d.key);
        if (cols.length === 0) continue;
        const data = await run({ kind: "rows", entity, columns: cols, limit: 3 }, { pack, connector: sqlConnector(duck[name]!.executor), ctx });
        expect(data.error).toBeUndefined();
        expect(data.records!.length).toBeGreaterThan(0);
      }
    });
    if (pack.entities[Object.keys(pack.entities)[0]!]!.tenant || Object.values(pack.entities).some((e) => e.tenant)) {
      it("refuses to run without a tenant", () => {
        const m = pack.measures.find((x) => pack.entities[x.entity]!.tenant)!;
        expect(() => compile({ kind: "value", measure: m.key }, pack, { dialect: "duckdb", ctx: {} })).toThrow(/tenant/);
      });
    }
  });

  describe(`${name}: the example boards build and resolve`, () => {
    for (const board of examples[name].boards) {
      it(`board ${board.id} on duckdb`, async () => {
        const config = buildBoard(name, board.id);
        const data = await resolveBoard(config, { pack, connector: sqlConnector(duck[name]!.executor), ctx });
        const errors = Object.entries(data).filter(([, d]) => d.error).map(([id, d]) => `${id}: ${d.error}`);
        expect(errors).toEqual([]);
        const widgets = Object.entries(config.widgets).filter(([, w]) => w.kind !== "text");
        for (const [id] of widgets) expect(data[id], id).toBeDefined();
      });

      for (const engine of ENGINES) {
        it(`board ${board.id}: ${engine.name} agrees with duckdb`, async ({ skip }) => {
          const other = live.get(engine.name);
          if (!other) return skip();
          const config = buildBoard(name, board.id);
          const a = await resolveBoard(config, { pack, connector: sqlConnector(duck[name]!.executor), ctx });
          const b = await resolveBoard(config, { pack, connector: other.connector, ctx });
          const refuses = other.connector.capabilities.percentiles === false;
          for (const id of Object.keys(a)) {
            const widget = config.widgets[id] as { query: { measure?: string } };
            if (agrees(engine.name, id, b[id]!, a[id]!, refuses) === "refused") expect(usesPercentile(pack, widget.query.measure ?? ""), `${engine.name}: ${id} refused: ${b[id]!.error}`).toBe(true);
          }
        });
      }
    }
  });

  describe(`${name}: every driver answers every query as duckdb does`, () => {
    for (const engine of ENGINES) {
      it(`${engine.name}`, async ({ skip }) => {
        const other = live.get(engine.name);
        if (!other) return skip();
        const refuses = other.connector.capabilities.percentiles === false;
        const reference = sqlConnector(duck[name]!.executor);
        let refused = 0;
        for (const m of pack.measures) {
          for (const [label, query] of sweep(pack, m.key)) {
            try {
              check(query, pack, { ctx });
            } catch (e) {
              if (e instanceof ResolveError && REFUSALS.has(e.code)) continue;
              throw e;
            }
            const mine = await run(query, { pack, connector: other.connector, ctx });
            if (agrees(engine.name, `${m.key} ${label}`, mine, await run(query, { pack, connector: reference, ctx }), refuses) === "refused") {
              // Only a percentile may be refused, and only where the dialect says it has none.
              expect(usesPercentile(pack, m.key), `${engine.name}: ${m.key} ${label} refused: ${mine.error}`).toBe(true);
              refused++;
            }
          }
        }
        for (const [entity] of Object.entries(pack.entities)) {
          const cols = pack.dimensions.filter((d) => d.entity === entity && d.type !== "time").map((d) => d.key);
          if (cols.length === 0) continue;
          const query: Query = { kind: "rows", entity, columns: cols, limit: 3, orderBy: { key: cols[0]!, dir: "asc" } };
          agrees(engine.name, `rows ${entity}`, await run(query, { pack, connector: other.connector, ctx }), await run(query, { pack, connector: reference, ctx }), false);
        }
        if (!refuses) expect(refused).toBe(0);
      });
    }
  });
}
