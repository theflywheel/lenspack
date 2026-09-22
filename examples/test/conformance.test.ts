import type { Query } from "@lenspack/core";
import { applyOps, emptyBoard } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/spec";
import { ResolveError, type WidgetData, compile, resolveBoard, run } from "@lenspack/sql";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { openPostgres } from "@lenspack/sql/pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ExampleName, SMALL, buildBoard, contextFor, examples } from "../index";

// The genericity proof, parts two and four: one test suite runs over every
// pack, and every dimension × measure × shape either compiles or fails with a
// documented reason. Part one (two engines agree) runs per board below when a
// Postgres is reachable.

const NAMES = Object.keys(examples) as ExampleName[];
const PG_URL = process.env.LENSPACK_PG_URL ?? "postgres://localhost:5432/lenspack_test";
const REFUSALS = new Set(["FANOUT_REFUSED", "NO_JOIN_PATH", "TIME_DIMENSION", "NO_TIME"]);

const duck: Partial<Record<ExampleName, Awaited<ReturnType<typeof openDuckdb>>>> = {};
let pg: Awaited<ReturnType<typeof openPostgres>> | null = null;

beforeAll(async () => {
  for (const name of NAMES) {
    const db = await openDuckdb();
    await examples[name].seed(db.writer, "duckdb", SMALL[name] as never);
    duck[name] = db;
  }
  try {
    pg = await openPostgres(PG_URL);
    await pg.pool.query("SELECT 1");
    for (const name of NAMES) await examples[name].seed(pg.writer, "postgres", SMALL[name] as never);
  } catch (e) {
    pg = null;
    console.warn(`[conformance] Postgres not reachable at ${PG_URL}; two-engine checks skipped (${String(e).slice(0, 80)})`);
  }
});
afterAll(async () => {
  for (const db of Object.values(duck)) await db.close();
  await pg?.close();
});

function normalise(data: WidgetData) {
  const round = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6);
  return {
    rows: data.rows.map((r) => ({ ...r, value: round(r.value) })).sort((a, b) => `${a.group}|${a.series ?? ""}`.localeCompare(`${b.group}|${b.series ?? ""}`)),
    records: data.records,
    total: data.total,
    format: data.format,
    compare: data.compare ? { previous: round(data.compare.previous), delta: round(data.compare.delta) } : undefined,
    error: data.error,
  };
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
            compile(query, pack, { dialect: "duckdb", ctx });
          } catch (e) {
            if (e instanceof ResolveError && REFUSALS.has(e.code)) {
              outcomes[label] = e.code;
              return;
            }
            throw e;
          }
          const data = await run(query, { pack, executor, ctx });
          expect(data.error, `${label}: ${data.error}`).toBeUndefined();
          outcomes[label] = "ok";
        };
        for (const d of dims) await attempt(`breakdown:${d.key}`, { kind: "breakdown", dimension: d.key, measure: m.key, limit: 5, sort: "desc" });
        await attempt("value", { kind: "value", measure: m.key });
        await attempt("series", { kind: "series", measure: m.key, grain: "week" });
        await attempt("value:compare", { kind: "value", measure: m.key, compare: "previous_period", time: { last: "30d" } });
        // Something must be answerable for every measure, or the pack is wrong.
        expect(Object.values(outcomes).filter((o) => o === "ok").length).toBeGreaterThan(0);
      });
    }
    it("rows on every entity with its own dimensions", async () => {
      for (const [entity] of Object.entries(pack.entities)) {
        const cols = pack.dimensions.filter((d) => d.entity === entity && d.type !== "time").map((d) => d.key);
        if (cols.length === 0) continue;
        const data = await run({ kind: "rows", entity, columns: cols, limit: 3 }, { pack, executor: duck[name]!.executor, ctx });
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
        const data = await resolveBoard(config, { pack, executor: duck[name]!.executor, ctx });
        const errors = Object.entries(data).filter(([, d]) => d.error).map(([id, d]) => `${id}: ${d.error}`);
        expect(errors).toEqual([]);
        const widgets = Object.entries(config.widgets).filter(([, w]) => w.kind !== "text");
        for (const [id] of widgets) expect(data[id], id).toBeDefined();
      });

      it(`board ${board.id}: postgres agrees with duckdb`, async ({ skip }) => {
        if (!pg) return skip();
        const config = buildBoard(name, board.id);
        const a = await resolveBoard(config, { pack, executor: duck[name]!.executor, ctx });
        const b = await resolveBoard(config, { pack, executor: pg.executor, ctx });
        for (const id of Object.keys(a)) expect(normalise(b[id]!), id).toEqual(normalise(a[id]!));
      });
    }
  });
}
