import { parsePack } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import { type DatasetFacts, dryRunQueries, packRisks, sizeHint, sqlRisks } from "../src/query-checks";
import { querySafety } from "../src/query-safety";

const pack = parsePack({
  pack: "p",
  version: 1,
  entities: {
    visits: { source: "visits", grain: "one row per visit", time: "visited_at", geo: { lat: "lat", lon: "lon" } },
    daily: { source: "daily", grain: "one row per day and district", time: { field: "day", type: "date" } },
    people: { source: "people", grain: "one row per person" },
  },
  dimensions: [
    { key: "district", entity: "visits", field: "district", also: { daily: { field: "district" } } },
    { key: "village", entity: "visits", field: "village" },
    { key: "household_id", entity: "visits", field: "household_id" },
    { key: "age", entity: "people", field: "age", type: "number" },
  ],
  measures: [
    { key: "visits", entity: "visits", agg: "count" },
    { key: "households", entity: "visits", agg: "count_distinct", field: "household_id" },
    { key: "doses", entity: "daily", agg: "sum", field: "doses" },
    { key: "people", entity: "people", agg: "count" },
  ],
  hierarchies: { place: ["district", "village", "household_id"] },
});
const facts: DatasetFacts[] = [
  { entity: "visits", label: "visits", timeColumn: "visited_at", dated: false, geo: true, columns: [{ name: "household_id", groupable: true }, { name: "district", groupable: true }] },
  { entity: "daily", label: "daily", timeColumn: "day", dated: true, geo: false, columns: [{ name: "district", groupable: true }] },
  { entity: "people", label: "people", timeColumn: null, dated: false, geo: false, columns: [{ name: "age", groupable: true }] },
];

describe("query checks: the pack", () => {
  it("guesses what one row is from the columns alone", () => {
    expect(sizeHint(facts[0]!)).toMatchObject({ hint: "rows" });
    expect(sizeHint(facts[1]!)).toMatchObject({ hint: "summary" });
    expect(sizeHint(facts[2]!)).toMatchObject({ hint: "unknown" });
  });

  it("warns about risky definitions under the limits, and changes nothing", () => {
    const s = querySafety({ requireTime: false, datasets: { visits: { heavy: true, requireTime: false, highCardinality: ["household_id"] }, people: { heavy: true }, nowhere: { heavy: true } } });
    const risks = packRisks(pack, s, facts);
    const said = risks.map((r) => r.message).join("\n");
    expect(said).toContain('"household_id" is a dimension of visits, but the deployment says it has a value for almost every record');
    expect(said).toContain('"households" counts distinct values over visits, which is marked heavy, without a time range required');
    expect(said).toContain("people is marked heavy but has no time column");
    expect(said).toContain('The hierarchy "place" drills down to "household_id"');
    expect(said).toContain('querySafety.datasets names "nowhere"');
    // Without the deployment's word, an id-like dimension and a row-level dataset are notes, not warnings.
    const plain = packRisks(pack, querySafety(), facts);
    expect(plain.filter((r) => r.level === "warning")).toEqual([]);
    expect(plain.map((r) => r.message).join("\n")).toContain('"household_id" reads like one value per record');
    expect(plain.map((r) => r.message).join("\n")).toContain("visits looks like one row per record");
  });
});

describe("query checks: the dry run's reading of SQL", () => {
  const safe = "SELECT district AS district, count(*) AS n FROM visits WHERE visited_at >= '2026-01-01' AND visited_at < '2026-02-01' GROUP BY district ORDER BY n DESC LIMIT 13";
  it("finds nothing in a bounded, time-narrowed statement", () => {
    expect(sqlRisks(safe, { timeColumn: "visited_at", heavy: true })).toEqual([]);
  });
  it("flags no LIMIT, a per-record GROUP BY, many group columns, and no time condition on a heavy dataset", () => {
    expect(sqlRisks("SELECT * FROM visits", { timeColumn: "visited_at", heavy: false })).toEqual([{ level: "danger", message: "no LIMIT: the database would return every row" }]);
    expect(sqlRisks("SELECT household_id, count(*) FROM visits WHERE visited_at > now() - 1 GROUP BY household_id LIMIT 10", { timeColumn: "visited_at", heavy: true, highCardinality: ["household_id"] })).toEqual([{ level: "danger", message: "GROUP BY household_id, which has a value for almost every record" }]);
    expect(sqlRisks("SELECT a, b, c, d, count(*) FROM t GROUP BY a, b, toStartOfDay(c, 'UTC'), d LIMIT 5", { timeColumn: null, heavy: false })).toEqual([{ level: "warning", message: "GROUP BY over 4 columns: groups multiply" }]);
    expect(sqlRisks("SELECT count(*) FROM visits WHERE district = 'x' LIMIT 1", { timeColumn: "visited_at", heavy: true })).toEqual([{ level: "danger", message: 'no condition on the time column "visited_at" on a heavy dataset: it reads every row' }]);
  });
});

describe("query checks: the shapes the dry run tries", () => {
  it("covers each measure as a value, by each dimension, over time, and lists and maps, up to a cap", () => {
    const all = dryRunQueries(pack, 1000);
    const whats = all.map((q) => q.what);
    expect(whats).toContain("visits, one value, no time range");
    expect(whats).toContain("visits by household_id");
    expect(whats).toContain("visits by hour, last 90 days");
    expect(whats).toContain("doses by district");
    expect(whats).toContain("visits by district split by village");
    expect(whats).toContain("a list of visits rows");
    expect(whats).toContain("a map of visits");
    // No series on a dataset with no time.
    expect(whats.some((w) => w.startsWith("people by hour"))).toBe(false);
    expect(dryRunQueries(pack, 5)).toHaveLength(5);
  });
});
