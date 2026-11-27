// The dry run against a stand-in Superset: every request is chart-data with result_type "query" (compile, never run),
// the SQL that comes back is read for risks, and shapes the limits refuse are listed and never sent.
import { describe, expect, it } from "vitest";

import { guardedConnector } from "@lenspack/engine";

import { supersetConnector } from "../src/connector";
import { dryRun, dryRunText, exampleRefusals } from "../src/dry-run";
import { type SupersetDataset, packFromDatasets } from "../src/index";
import { supersetQuerySafety } from "../src/query-safety";

const visits: SupersetDataset = {
  id: 5,
  table_name: "visits",
  main_dttm_col: "visited_at",
  columns: [
    { column_name: "visited_at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "ward", groupby: true, type: "TEXT" },
    { column_name: "household_id", groupby: true, type: "TEXT" },
  ],
  metrics: [{ metric_name: "visit_count", expression: "COUNT(*)" }],
};
const examples = [
  { question: "Visits by ward", query: { kind: "breakdown", dimension: "ward", measure: "visit_count" } },
  { question: "Visits per household", query: { kind: "breakdown", dimension: "household_id", measure: "visit_count" } },
];
const { pack, binding } = packFromDatasets([visits], { pack: "s", examples });

function setup(config: unknown, sqlFor: (q: { columns: unknown[]; filters: { op: string }[] }) => string) {
  const bodies: { result_type: string; queries: { columns: unknown[]; filters: { op: string }[] }[] }[] = [];
  const client = {
    post: async (_p: string, body: (typeof bodies)[number]) => {
      bodies.push(body);
      if (body.result_type !== "query") throw new Error("ran a query");
      return { result: body.queries.map((q) => ({ query: sqlFor(q) })) };
    },
  };
  const safety = supersetQuerySafety({ config, env: {}, binding: () => binding, settings: { get: () => undefined, set: () => {} }, log: () => {} });
  const connector = guardedConnector(supersetConnector(client as never, binding), safety.guard);
  return { bodies, client, safety, connector };
}

describe("the dry run", () => {
  it("only ever asks Superset to compile, and reads the SQL for risks", async () => {
    // A stand-in that writes SQL the way a careless dataset might: a GROUP BY with no LIMIT on a list.
    const { bodies, client, safety, connector } = setup({ datasets: { visits: { heavy: true } } }, (q) =>
      q.columns.length ? `SELECT ${q.columns.map(String).join(", ")}, count(*) FROM visits WHERE visited_at >= '2026-01-01' GROUP BY ${q.columns.map(String).join(", ")}` : "SELECT count(*) FROM visits WHERE visited_at >= '2026-01-01' LIMIT 1",
    );
    const r = await dryRun({ client: client as never, pack, binding, connector, safety: safety.current(), datasets: [visits], cap: 50 });
    expect(bodies.length).toBeGreaterThan(5);
    expect(bodies.every((b) => b.result_type === "query")).toBe(true);
    expect(r.shapes).toBeGreaterThan(5);
    expect(r.compiled).toBeGreaterThanOrEqual(bodies.length);
    expect(r.findings.some((f) => f.level === "danger" && f.message.startsWith("no LIMIT"))).toBe(true);
    // An hourly series over 90 days on a heavy dataset is within its 5,000 points; nothing here is refused by the limits.
    expect(r.errors).toEqual([]);
    expect(r.pack.map((p) => p.message).join("\n")).toContain('"household_id" reads like one value per record');
    expect(dryRunText(r)).toMatch(/^query safety dry run: \d+ query shapes, \d+ statements compiled by Superset \(none run\)/);
  });

  it("lists the shapes Lenspack's own limits refuse, and never sends them", async () => {
    const { bodies, client, safety, connector } = setup({ datasets: { visits: { highCardinality: ["household_id"] } } }, () => "SELECT 1 LIMIT 1");
    const r = await dryRun({ client: client as never, pack, binding, connector, safety: safety.current(), datasets: [visits], cap: 50 });
    expect(r.refused.map((x) => x.what)).toContain("visit_count by household_id");
    expect(bodies.some((b) => JSON.stringify(b.queries).includes("household_id") && !JSON.stringify(b.queries).includes("ward"))).toBe(false);
  });

  it("says which example questions the limits would refuse", async () => {
    const { connector } = setup({ datasets: { visits: { highCardinality: ["household_id"] } } }, () => "");
    const risks = await exampleRefusals(pack, connector);
    expect(risks).toEqual([{ level: "warning", message: expect.stringContaining('The example question "Visits per household" would be refused by the query limits') }]);
  });
});
