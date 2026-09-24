import { memoryStore } from "@lenspack/core";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pack, seedFixture } from "../../sql/test/fixture-pack";
import { memoryProposals } from "../src/proposals";
import { type Tool, boardTools } from "../src/tools";

let db: Awaited<ReturnType<typeof openDuckdb>>;
let tools: Record<string, Tool>;
const proposals = memoryProposals();

beforeAll(async () => {
  db = await openDuckdb();
  await seedFixture(db.writer, "duckdb");
  const store = memoryStore();
  await store.create({ id: "b", pack, title: "Test board" });
  tools = Object.fromEntries(
    boardTools({ pack, executor: db.executor, store, boardId: "b", ctx: { tenant: "t1", now: new Date("2026-02-15T00:00:00Z") }, proposals }).map((t) => [t.name, t]),
  );
});
afterAll(async () => db.close());

const call = (name: string, args: Record<string, unknown> = {}) => tools[name]!.execute(tools[name]!.inputSchema.parse(args) as never);

describe("board tools", () => {
  it("lists only verified metrics and narrows by text", async () => {
    const all = (await call("list_metrics")) as { measures: { key: string }[] };
    expect(all.measures.map((m) => m.key)).toContain("weight");
    const narrowed = (await call("list_metrics", { q: "broken" })) as { measures: { key: string }[] };
    expect(narrowed.measures.map((m) => m.key).sort()).toEqual(["broken", "broken_rate"]);
  });

  it("assembles a breakdown from flat scalars and runs it", async () => {
    const r = (await call("query", { query_kind: "breakdown", measure: "things", dimension: "colour" })) as { ok: boolean; rows: { group: string; value: number }[]; sql: string };
    expect(r.ok).toBe(true);
    expect(r.rows.find((x) => x.group === "red")?.value).toBe(2);
    expect(r.sql).toContain("GROUP BY");
  });

  it("passes sort through for a breakdown", async () => {
    const r = (await call("explain", { query_kind: "breakdown", measure: "things", dimension: "colour", sort: "asc" })) as { ok: boolean; query: { sort: string }; sql: string };
    expect(r.ok).toBe(true);
    expect(r.query.sort).toBe("asc");
    expect(r.sql).toContain("ASC NULLS LAST");
  });

  it("explains without running and names the entities joined", async () => {
    const r = (await call("explain", { query_kind: "breakdown", measure: "things", dimension: "tier" })) as { ok: boolean; entities: string[] };
    expect(r.ok).toBe(true);
    expect(r.entities).toEqual(["things", "owners"]);
  });

  it("returns a refusal with a suggestion rather than throwing", async () => {
    const r = (await call("query", { query_kind: "breakdown", measure: "thngs", dimension: "colour" })) as { ok: boolean; error: string; didYouMean?: string };
    expect(r.ok).toBe(false);
    expect(r.didYouMean).toBe("things");
    const fan = (await call("query", { query_kind: "breakdown", measure: "things", dimension: "part_kind" })) as { ok: boolean; error: string };
    expect(fan.error).toContain("multiply");
  });

  it("adds, moves and removes widgets through the store", async () => {
    const added = (await call("add_widget", { id: "by_colour", kind: "chart", title: "By colour", query_kind: "breakdown", measure: "things", dimension: "colour", place: "top", width: "half" })) as { applied: boolean; board: string; version: number };
    expect(added.applied).toBe(true);
    expect(added.board).toContain("by_colour (bar, 6/12 wide) things by colour");
    const kpi = (await call("add_widget", { id: "total", kind: "kpi", title: "Total", query_kind: "value", measure: "things", time_last: "30d", compare: true, width: "quarter" })) as { applied: boolean };
    expect(kpi.applied).toBe(true);
    const bad = (await call("add_widget", { id: "oops", kind: "chart", title: "x", query_kind: "breakdown", measure: "things", dimension: "colr" })) as { applied: boolean; didYouMean?: string };
    expect(bad.applied).toBe(false);
    expect(bad.didYouMean).toBe("colour");
    const moved = (await call("move_widget", { id: "total", place: "top", width: "full" })) as { applied: boolean; board: string };
    expect(moved.applied).toBe(true);
    const removed = (await call("remove_widget", { id: "by_colour" })) as { applied: boolean; board: string };
    expect(removed.board).not.toContain("by_colour");
    const filtered = (await call("add_filter", { field: "colour" })) as { applied: boolean; board: string };
    expect(filtered.board).toContain("Filters: Colour [colour]");
    const renamed = (await call("rename_board", { title: "Renamed" })) as { applied: boolean; board: string; version: number };
    expect(renamed.board).toContain("Renamed");
    expect(renamed.version).toBeGreaterThan(4);
  });

  it("serialises parallel edits so none is lost", async () => {
    const store = memoryStore();
    await store.create({ id: "p", pack, title: "Parallel" });
    const t = Object.fromEntries(boardTools({ pack, executor: db.executor, store, boardId: "p", ctx: { tenant: "t1" } }).map((x) => [x.name, x]));
    const go = (name: string, args: Record<string, unknown>) => t[name]!.execute(t[name]!.inputSchema.parse(args) as never);
    await Promise.all([
      go("rename_board", { title: "Renamed" }),
      go("add_widget", { id: "k1", kind: "kpi", title: "K1", query_kind: "value", measure: "things" }),
      go("add_widget", { id: "k2", kind: "kpi", title: "K2", query_kind: "value", measure: "weight" }),
    ]);
    const board = (await store.get("p"))!;
    expect(board.config.title).toBe("Renamed");
    expect(Object.keys(board.config.widgets).sort()).toEqual(["k1", "k2"]);
    expect(board.version).toBe(4);
  });

  it("refuses a fan-out widget at edit time, not render time", async () => {
    const r = (await call("add_widget", { id: "fan", kind: "chart", title: "x", query_kind: "breakdown", measure: "things", dimension: "part_kind" })) as { applied: boolean; error: string };
    expect(r.applied).toBe(false);
    expect(r.error).toContain("multiply");
    const board = (await call("get_board")) as { board: string };
    expect(board.board).not.toContain("fan");
  });

  it("does not expose run_sql unless asked", async () => {
    expect(tools.run_sql).toBeUndefined();
    const store = memoryStore();
    await store.create({ id: "c", pack, title: "x" });
    const withSql = Object.fromEntries(boardTools({ pack, executor: db.executor, store, boardId: "c", ctx: { tenant: "t1" }, runSql: true }).map((t) => [t.name, t]));
    const r = (await withSql.run_sql!.execute({ sql: "select count(*) as n from things" } as never)) as { ok: boolean; rows: { n: unknown }[] };
    expect(r.ok).toBe(true);
    expect(Number(r.rows[0]!.n)).toBe(6);
    const refused = (await withSql.run_sql!.execute({ sql: "delete from things" } as never)) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
  });

  it("records a proposal without touching the pack", async () => {
    const r = (await call("propose_measure", { key: "heavy_rate", entity: "things", agg: "avg", sql: "(weight_g > 3000)::int", format: "percent", rationale: "share of heavy things" })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect((await proposals.list())[0]?.verified).toBe(false);
    expect(pack.measures.some((m) => m.key === "heavy_rate")).toBe(false);
  });
});
