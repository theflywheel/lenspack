import { describe, expect, it } from "vitest";

import { HEAVY_LIMITS, QUERY_LIMITS, type QueryShape, SERVER_LIMITS, checkQuery, limitsFor, mergeQuerySafety, querySafety, querySafetyEnv, querySafetyFrom, updateQuerySafety } from "../src/query-safety";

const now = new Date("2026-06-30T00:00:00Z");
const days = (n: number) => ({ from: new Date(now.getTime() - n * 86_400_000), to: now });
const shape = (s: Partial<QueryShape>): QueryShape => ({ entity: "visits", kind: "value", groupBy: [], limit: null, split: false, grain: null, window: null, hasTime: true, offset: 0, ...s });

describe("query safety: the limits", () => {
  it("has defaults that refuse nothing an answer used to give", () => {
    const s = querySafety();
    expect(s.limits).toEqual(QUERY_LIMITS);
    expect(s.server).toEqual(SERVER_LIMITS);
    // The largest shapes the engine asks for: a 20,000-row series cap, a 10,000-group base, a 1,000-row list, a 5,000-point map.
    expect(checkQuery(shape({ kind: "series", grain: "hour", window: days(800) }), s, { now })).toMatchObject({ ok: true, rowLimit: 20_000 });
    expect(checkQuery(shape({ kind: "breakdown", groupBy: [{ key: "region" }], limit: 10_000 }), s)).toMatchObject({ ok: true });
    expect(checkQuery(shape({ kind: "rows", limit: 1000, offset: 9000 }), s)).toMatchObject({ ok: true });
    expect(checkQuery(shape({ kind: "points", limit: 5000 }), s)).toMatchObject({ ok: true });
    expect(checkQuery(shape({ kind: "value" }), s)).toEqual({ ok: true, rowLimit: 20_000 });
  });

  it("reads the config, the environment over it, and refuses mistakes by name", () => {
    expect(querySafetyFrom({ maxRows: 5000, datasets: { visits: { heavy: true, highCardinality: ["household_id"] } } })).toEqual({ maxRows: 5000, datasets: { visits: { heavy: true, highCardinality: ["household_id"] } } });
    expect(() => querySafetyFrom({ maxRows: 5 })).toThrow("querySafety.maxRows is a whole number from 100 to 1000000");
    expect(() => querySafetyFrom({ maxRow: 5000 })).toThrow('querySafety: unknown setting "maxRow"');
    expect(() => querySafetyFrom({ datasets: { visits: { heavy: "yes" } } })).toThrow("querySafety.datasets.visits.heavy is true or false");
    expect(() => querySafetyFrom({ heavy: { maxQueriesPerTurn: 3 } })).toThrow('querySafety.heavy: unknown setting "maxQueriesPerTurn"');
    const env = querySafetyEnv({ LENSPACK_QUERY_MAX_PER_TURN: "40", LENSPACK_QUERY_MAX_WINDOW_DAYS: "none", LENSPACK_HEAVY_DATASETS: "visits, stock" });
    expect(env).toEqual({ maxQueriesPerTurn: 40, maxWindowDays: null, datasets: { visits: { heavy: true }, stock: { heavy: true } } });
    expect(() => querySafetyEnv({ LENSPACK_QUERY_TIMEOUT_SECONDS: "0" })).toThrow("LENSPACK_QUERY_TIMEOUT_SECONDS is a whole number from 1 to 3600");
    const merged = querySafety(mergeQuerySafety({ maxRows: 5000, datasets: { visits: { maxWindowDays: 30 } } }, env));
    expect(merged.limits.maxRows).toBe(5000);
    expect(merged.server.maxQueriesPerTurn).toBe(40);
    expect(limitsFor(merged, "visits")).toEqual({ ...HEAVY_LIMITS, maxWindowDays: 30 });
    expect(limitsFor(merged, "other")).toMatchObject({ maxRows: 5000, requireTime: false });
  });
});

describe("query safety: the check", () => {
  const heavy = querySafety({ datasets: { visits: { heavy: true, highCardinality: ["household_id"], cardinality: { ward: 3000, facility: 400 } } } });
  const coarser = (k: string) => ({ household_id: "village", ward: "district" })[k];

  it("never groups by a column with a value for every record, and says what to group by", () => {
    const v = checkQuery(shape({ kind: "breakdown", groupBy: [{ key: "household", column: "household_id" }], limit: 12, window: days(7) }), heavy, { coarser: () => "village", label: 'the dataset "visits"' });
    expect(v).toEqual({ ok: false, key: "household", nearest: "village", message: expect.stringContaining('"household" has a different value for almost every record of the dataset "visits"') });
    expect((v as { message: string }).message).toContain("Group by a coarser level (village)");
  });

  it("puts a default window on a heavy dataset's question with none, and says so", () => {
    const v = checkQuery(shape({}), heavy, { now, label: "visits" });
    expect(v).toMatchObject({ ok: true, rowLimit: 10_000, window: days(90), note: "visits is large, so this reads the last 90 days only; ask for a time range to see another period (up to 400 days at once)" });
    // Without a default window, refused instead; and a dataset with no time column cannot be narrowed (the pack check warns).
    const strict = querySafety({ datasets: { visits: { heavy: true, defaultWindowDays: null } } });
    expect(checkQuery(shape({}), strict, { label: "visits" })).toEqual({ ok: false, message: "visits is large, so a question about it needs a time range, for example the last 30 days; the longest allowed at once is 400 days." });
    expect(checkQuery(shape({ hasTime: false }), strict)).toMatchObject({ ok: true });
  });

  it("refuses a time range longer than allowed", () => {
    expect(checkQuery(shape({ window: days(400) }), heavy)).toMatchObject({ ok: true });
    expect(checkQuery(shape({ window: days(500) }), heavy, { label: "visits" })).toEqual({ ok: false, message: "This asks for 500 days of visits; the most allowed at once is 400 days. Use a shorter time range, or split it into periods." });
  });

  it("refuses a series with too many points: buckets times series", () => {
    expect(checkQuery(shape({ kind: "series", grain: "hour", window: days(180) }), heavy)).toMatchObject({ ok: true });
    expect(checkQuery(shape({ kind: "series", grain: "hour", window: days(300) }), heavy)).toEqual({ ok: false, message: "This series would draw about 7,200 points (7,200 hours); the most is 5,000. Use a coarser grain (day instead of hour) or a shorter time range." });
  });

  it("counts a series' points with its split, when the split's values are known", () => {
    const v = checkQuery(shape({ kind: "series", grain: "day", window: days(30), groupBy: [{ key: "facility" }] }), heavy);
    expect(v).toEqual({ ok: false, message: "This series would draw about 12,000 points (30 days for each of about 400 series); the most is 5,000. Use a coarser grain (week instead of day) or a shorter time range." });
    expect(checkQuery(shape({ kind: "series", grain: "week", window: days(30), groupBy: [{ key: "facility" }] }), heavy)).toMatchObject({ ok: true });
  });

  it("refuses a breakdown times its split past the most groups, when both counts are known", () => {
    const v = checkQuery(shape({ kind: "breakdown", groupBy: [{ key: "ward" }, { key: "facility" }], split: true, limit: 12, window: days(7) }), heavy, { coarser });
    expect(v).toEqual({ ok: false, nearest: "district", message: "This would make about 1,200,000 groups (ward × facility); the most is 10,000. Pick a coarser level (district), drop the split, or filter to fewer values." });
    // One count unknown: not counted, so not refused here (the database user's limits still apply).
    expect(checkQuery(shape({ kind: "breakdown", groupBy: [{ key: "ward" }, { key: "village" }], split: true, limit: 12, window: days(7) }), heavy)).toMatchObject({ ok: true });
  });

  it("refuses a list or a top N past the most rows, and cuts a series or a split to it", () => {
    const tight = querySafety({ maxRows: 500 });
    expect(checkQuery(shape({ kind: "rows", limit: 1000 }), tight)).toEqual({ ok: false, message: "This asks for 1,000 rows at once; the most is 500. Ask for fewer (the top 500), or narrow it with a filter." });
    expect(checkQuery(shape({ kind: "breakdown", groupBy: [{ key: "a" }, { key: "b" }], split: true, limit: 12 }), tight)).toMatchObject({ ok: true, rowLimit: 500 });
  });
});

describe("query safety: an admin's changes", () => {
  const deployment = { maxRows: 10_000, datasets: { visits: { heavy: true } } };
  const entities = ["visits", "stock"];

  it("tightens freely", () => {
    const r = updateQuerySafety({}, { maxRows: 5000, datasets: { stock: { heavy: true } } }, deployment, entities);
    expect(r).toEqual({ ok: true, saved: { maxRows: 5000, datasets: { stock: { heavy: true } } }, looser: [] });
  });

  it("loosens only with confirm, and says what would loosen", () => {
    const r = updateQuerySafety({}, { maxRows: 50_000, datasets: { visits: { heavy: false } } }, deployment, entities);
    expect(r).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('"confirm": true') });
    expect((r as { looser: { field: string }[] }).looser.map((l) => l.field)).toEqual(expect.arrayContaining(["maxRows", "datasets.visits.requireTime", "datasets.visits.maxWindowDays"]));
    const ok = updateQuerySafety({}, { maxRows: 50_000, confirm: true }, deployment, entities);
    expect(ok).toMatchObject({ ok: true, saved: { maxRows: 50_000 }, looser: [{ field: "maxRows", from: 10_000, to: 50_000 }] });
  });

  it("puts a value back with null, and refuses a bad one", () => {
    expect(updateQuerySafety({ maxRows: 5000, maxGroups: 50 }, { maxRows: null }, deployment, entities)).toMatchObject({ ok: true, saved: { maxGroups: 50 } });
    expect(updateQuerySafety({ datasets: { stock: { heavy: true } } }, { datasets: { stock: null } }, deployment, entities)).toMatchObject({ ok: true, saved: {} });
    // A nullable limit: null is "none" (looser than any), "default" puts the deployment's back.
    expect(updateQuerySafety({}, { maxWindowDays: null }, { maxWindowDays: 30 }, entities)).toMatchObject({ ok: false, status: 409 });
    expect(updateQuerySafety({ maxWindowDays: 10 }, { maxWindowDays: "default" }, { maxWindowDays: 30 }, entities)).toMatchObject({ ok: true, saved: {} });
    expect(updateQuerySafety({}, { maxRows: "lots" }, deployment, entities)).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("maxRows") });
  });
});
