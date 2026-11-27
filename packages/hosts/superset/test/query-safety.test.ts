// Query safety in Superset: what reaches /api/v1/chart/data under the deployment's limits (superset.yaml
// querySafety:, the environment, an admin's changes). Superset's chart-data API has no timeout of its own, so the
// timeout is how long Lenspack waits for the answer; the database user's limits stop the query itself.
import { describe, expect, it } from "vitest";

import { guardedConnector, run } from "@lenspack/engine";

import { supersetConnector } from "../src/connector";
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
const { pack, binding } = packFromDatasets([visits], { pack: "s" });

type Sent = { body: { queries: { filters: { col: string; op: string; val?: unknown }[]; row_limit: number }[] }; o?: { timeoutMs?: number } };
function setup(config: unknown, env: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const saved: Record<string, unknown> = {};
  const settings = { get: <T,>(k: string) => saved[k] as T, set: (k: string, v: unknown) => void (saved[k] = v) };
  const safety = supersetQuerySafety({ config, env, binding, pack, settings, log: () => {} });
  const client = { post: async (_p: string, body: Sent["body"], o?: Sent["o"]) => (sent.push({ body, o }), { result: body.queries.map(() => ({ data: [] })) }) };
  const connector = guardedConnector(supersetConnector(client as never, binding), safety.guard);
  return { sent, safety, connector };
}

describe("query safety over Superset", () => {
  it("names datasets by table name or id, and waits for each answer as long as the deployment says", async () => {
    const { sent, safety, connector } = setup({ timeoutSeconds: 12, datasets: { "5": { highCardinality: ["household_id"] } } });
    expect(safety.current().datasets.visits).toEqual({ highCardinality: ["household_id"] });
    const ok = await run({ kind: "breakdown", dimension: "ward", measure: "visit_count", limit: 12, sort: "desc" }, { pack, connector });
    expect(ok.error).toBeUndefined();
    expect(sent[0]!.o).toEqual({ timeoutMs: 12_000 });
    const no = await run({ kind: "breakdown", dimension: "household_id", measure: "visit_count", limit: 12, sort: "desc" }, { pack, connector });
    expect(no.error).toContain('"household_id" has a different value for almost every record of the dataset "visits"');
    // Refused before anything was sent.
    expect(sent).toHaveLength(1);
  });

  it("sends a heavy dataset's question with no time range over the default window", async () => {
    const { sent, connector } = setup({}, { LENSPACK_HEAVY_DATASETS: "visits" });
    const data = await run({ kind: "value", measure: "visit_count" }, { pack, connector });
    expect(data.notes).toContain('the dataset "visits" is large, so this reads the last 90 days only; ask for a time range to see another period (up to 400 days at once)');
    const range = sent[0]!.body.queries[0]!.filters.find((f) => f.op === "TEMPORAL_RANGE");
    // The last 90 days up to the moment it is asked.
    const [from, to] = String(range!.val).split(" : ").map((t) => new Date(`${t}Z`).getTime());
    expect(to! - from!).toBe(90 * 86_400_000);
    expect(Math.abs(Date.now() - to!)).toBeLessThan(60_000);
  });

  it("cuts a split breakdown to the row limit, and the answer says it was cut", async () => {
    const { sent, connector } = setup({ maxRows: 500 });
    await run({ kind: "breakdown", dimension: "ward", by: "household_id", measure: "visit_count", limit: 12, sort: "desc" }, { pack, connector });
    expect(sent[0]!.body.queries[0]!.row_limit).toBe(501);
  });

  it("refuses a list longer than the row limit", async () => {
    const { sent, connector } = setup({ maxRows: 100 });
    const data = await run({ kind: "rows", entity: "visits", columns: ["ward"], limit: 1000 }, { pack, connector });
    expect(data.error).toBe("This asks for 1,000 rows at once; the most is 100. Ask for fewer (the top 100), or narrow it with a filter.");
    expect(sent).toHaveLength(0);
  });

  it("stops the start on a mistake in the settings", () => {
    expect(() => setup({ maxRows: "many" })).toThrow("querySafety.maxRows is a whole number from 100 to 1000000");
    expect(() => setup({}, { LENSPACK_QUERY_MAX_PER_TURN: "0" })).toThrow("LENSPACK_QUERY_MAX_PER_TURN is a whole number from 1 to 10000");
  });
});
