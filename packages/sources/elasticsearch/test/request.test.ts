import { bucketLabel, resolve, shapeBound } from "@lenspack/engine";
import { parsePack } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import { ELASTICSEARCH_CAPABILITIES, toRequest } from "../src";

const pack = parsePack({
  pack: "visits",
  version: 1,
  timeZone: "Asia/Kolkata",
  entities: { visits: { source: "visits", time: "at" } },
  measures: [{ key: "visits", entity: "visits", agg: "count" }],
});

it("buckets a series at local midnight in the pack's zone and labels it with the local date", () => {
  const bound = resolve({ kind: "series", measure: "visits", grain: "day" }, pack, {}, ELASTICSEARCH_CAPABILITIES);
  const request = toRequest(bound, pack, { typeOf: () => "date", version: { major: 8, minor: 0 } });
  expect(request.body.aggs).toMatchObject({ t: { date_histogram: { field: "at", calendar_interval: "day", time_zone: "Asia/Kolkata" } } });
  // A bucket is keyed by the instant its local day starts: 5 January in Kolkata starts at 18:30 UTC on the 4th.
  const rows = request.decode({ aggregations: { t: { buckets: [{ key: Date.parse("2026-01-04T18:30:00Z"), doc_count: 3 }] } } });
  expect(bucketLabel(rows[0]!.bucket, "day")).toBe("2026-01-05");
});

// The search request for a compared breakdown, decoded from a canned
// response: the live parity suite (examples/test/elasticsearch.test.ts) checks
// the numbers against DuckDB when a search engine is running.

const regions = parsePack({
  pack: "stub",
  version: 1,
  entities: { visits: { source: "visits", time: "at" } },
  dimensions: [
    { key: "region", entity: "visits", field: "region" },
    { key: "kind", entity: "visits", field: "kind" },
  ],
  measures: [{ key: "visits", entity: "visits", agg: "count" }],
});
const env = { version: { major: 8, minor: 10 }, typeOf: (p: string) => (p === "at" ? "date" : "keyword") };

describe("a compared breakdown", () => {
  it("reads each group's two windows, keeps the current period's groups, and sorts them here", () => {
    const query = { kind: "breakdown", dimension: "region", measure: "visits", limit: 2, sort: "asc", compare: "previous_period", time: { from: "2026-02-01T00:00:00Z", to: "2026-03-01T00:00:00Z" } } as const;
    const bound = resolve(query, regions, {}, ELASTICSEARCH_CAPABILITIES);
    const req = toRequest(bound, regions, env);
    expect(Object.keys((req.body as { aggs: { g: { aggs: object } } }).aggs.g.aggs)).toEqual(["cur", "prev"]);
    const bucket = (key: string, cur: number, prev: number) => ({ key, doc_count: cur + prev, cur: { doc_count: cur }, prev: { doc_count: prev } });
    const rows = req.decode({ aggregations: { g: { buckets: [bucket("north", 5, 1), bucket("east", 0, 7), bucket("south", 2, 2), bucket("west", 3, 0)] } } });
    expect(rows.map((r) => r.group)).toEqual(["south", "west", "north"]);
    // The engine keeps the first `limit` groups, as it does for every source.
    expect(shapeBound(rows, bound).rows).toEqual([
      { group: "south", value: 2, count: 2, compare: { previous: 2, delta: 0 } },
      { group: "west", value: 3, count: 3, compare: { previous: 0, delta: null } },
    ]);
  });
});

describe("a split breakdown", () => {
  it("keeps the top groups by their total, every split inside them, not the top rows", () => {
    const query = { kind: "breakdown", dimension: "region", by: "kind", measure: "visits", limit: 2, sort: "desc" } as const;
    const bound = resolve(query, regions, {}, ELASTICSEARCH_CAPABILITIES);
    const req = toRequest(bound, regions, env);
    const group = (key: string, ...kinds: [string, number][]) => ({ key, doc_count: 0, s: { buckets: kinds.map(([k, n]) => ({ key: k, doc_count: n })) } });
    // north has the largest single cell; south and east have the largest totals.
    const response = { aggregations: { g: { buckets: [group("north", ["a", 9]), group("south", ["a", 6], ["b", 5]), group("east", ["a", 4], ["b", 4], ["c", 4])] } } };
    const { rows } = shapeBound(req.decode(response), bound);
    expect(rows.map((r) => `${r.group}/${r.series}`)).toEqual(["south/a", "south/b", "east/a", "east/b", "east/c"]);
  });
});
