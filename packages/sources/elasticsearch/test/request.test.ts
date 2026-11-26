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

it("buckets calendar dates as they are, and reads a window as the dates in the pack's zone", () => {
  const dated = parsePack({ ...pack, timeZone: "America/New_York", entities: { visits: { source: "visits", time: { field: "on_day", type: "date" } } } });
  // 22:00 on 9 November in New York, already the 10th in UTC.
  const bound = resolve({ kind: "series", measure: "visits", grain: "day", time: { last: "7d" } }, dated, { now: new Date("2025-11-10T03:00:00Z") }, ELASTICSEARCH_CAPABILITIES);
  const request = toRequest(bound, dated, { typeOf: () => "date", version: { major: 8, minor: 0 } });
  expect(request.body.aggs).toEqual({ t: expect.objectContaining({ date_histogram: { field: "on_day", calendar_interval: "day", min_doc_count: 1 } }) });
  expect(JSON.stringify(request.body.query)).toContain('{"range":{"on_day":{"gte":"2025-11-03","lt":"2025-11-10","format":"yyyy-MM-dd"}}}');
  const rows = request.decode({ aggregations: { t: { buckets: [{ key: Date.parse("2025-11-03T00:00:00Z"), doc_count: 3 }] } } });
  expect(bucketLabel(rows[0]!.bucket, "day")).toBe("2025-11-03");
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

// Terms aggregations stop at their size and count the documents past it as
// sum_other_doc_count. Where every group was asked for, more there is a cut.
describe("groups past the size the request asked for", () => {
  const group = (key: string, other = 0) => ({ key, doc_count: 1, s: { buckets: [{ key: "a", doc_count: 1 }], sum_other_doc_count: other } });

  it("a split breakdown with more groups, or more splits in a group, says it was cut", () => {
    const bound = resolve({ kind: "breakdown", dimension: "region", by: "kind", measure: "visits", limit: 2, sort: "desc" }, regions, {}, ELASTICSEARCH_CAPABILITIES);
    const req = toRequest(bound, regions, env);
    const shaped = (response: object) => shapeBound(req.decode(response), bound, req.cut?.(response));
    expect(shaped({ aggregations: { g: { buckets: [group("north")], sum_other_doc_count: 0 } } }).truncated).toBeUndefined();
    expect(shaped({ aggregations: { g: { buckets: [group("north")], sum_other_doc_count: 4 } } })).toMatchObject({ truncated: true, notes: [expect.stringMatching(/^groups are ranked on part of the data/)] });
    expect(shaped({ aggregations: { g: { buckets: [group("north", 2)], sum_other_doc_count: 0 } } }).truncated).toBe(true);
  });

  it("a breakdown that asks for its top groups only is not cut by the rest", () => {
    const bound = resolve({ kind: "breakdown", dimension: "region", measure: "visits", limit: 2, sort: "desc" }, regions, {}, ELASTICSEARCH_CAPABILITIES);
    const req = toRequest(bound, regions, env);
    expect(req.cut?.({ aggregations: { g: { buckets: [{ key: "north", doc_count: 3 }], sum_other_doc_count: 40 } } }) ?? false).toBe(false);
  });

  it("a computed query's base with more series than it may read says it was cut, and compute refuses it", () => {
    const bound = { ...resolve({ kind: "series", measure: "visits", grain: "day", by: "region" }, regions, {}, ELASTICSEARCH_CAPABILITIES), base: { rows: 20_000 } };
    const req = toRequest(bound, regions, env);
    const response = { aggregations: { s: { buckets: [{ key: "north", doc_count: 1, t: { buckets: [{ key: Date.parse("2026-01-01T00:00:00Z"), doc_count: 1 }] } }], sum_other_doc_count: 9 } } };
    expect(req.cut?.(response)).toBe(true);
    // A plain split series asks for its top series only; the rest are not a cut.
    const plain = resolve({ kind: "series", measure: "visits", grain: "day", by: "region" }, regions, {}, ELASTICSEARCH_CAPABILITIES);
    expect(toRequest(plain, regions, env).cut?.(response) ?? false).toBe(false);
  });
});

describe("a not_in filter", () => {
  it("keeps rows with a value that is none of the values, and leaves out rows with no value, as SQL's NOT IN does", () => {
    const bound = resolve({ kind: "value", measure: "visits", filters: [{ dimension: "region", op: "not_in", value: ["north", "east"] }] }, regions, {}, ELASTICSEARCH_CAPABILITIES);
    const query = JSON.stringify(toRequest(bound, regions, env).body.query);
    expect(query).toContain('{"exists":{"field":"region"}}');
    expect(query).toContain('"must_not":[{"terms":{"region":["north","east"]}}]');
  });
});
