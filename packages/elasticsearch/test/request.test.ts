import { bucketLabel, resolve } from "@lenspack/engine";
import { parsePack } from "@lenspack/spec";
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
  dimensions: [{ key: "region", entity: "visits", field: "region" }],
  measures: [{ key: "visits", entity: "visits", agg: "count" }],
});
const env = { version: { major: 8, minor: 10 }, typeOf: (p: string) => (p === "at" ? "date" : "keyword") };

describe("a compared breakdown", () => {
  it("reads each group's two windows, keeps the current period's groups, and sorts them here", () => {
    const query = { kind: "breakdown", dimension: "region", measure: "visits", limit: 2, sort: "asc", compare: "previous_period", time: { from: "2026-02-01T00:00:00Z", to: "2026-03-01T00:00:00Z" } } as const;
    const req = toRequest(resolve(query, regions, {}, ELASTICSEARCH_CAPABILITIES), regions, env);
    expect(Object.keys((req.body as { aggs: { g: { aggs: object } } }).aggs.g.aggs)).toEqual(["cur", "prev"]);
    const bucket = (key: string, cur: number, prev: number) => ({ key, doc_count: cur + prev, cur: { doc_count: cur }, prev: { doc_count: prev } });
    const rows = req.decode({ aggregations: { g: { buckets: [bucket("north", 5, 1), bucket("east", 0, 7), bucket("south", 2, 2), bucket("west", 3, 0)] } } });
    expect(rows).toEqual([
      { group: "south", value: 2, n: 2, previous: 2 },
      { group: "west", value: 3, n: 3, previous: 0 },
    ]);
  });
});
