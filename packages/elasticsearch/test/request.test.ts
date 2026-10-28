import { bucketLabel, resolve } from "@lenspack/engine";
import { parsePack } from "@lenspack/spec";
import { expect, it } from "vitest";

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
