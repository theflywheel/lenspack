import type { Query } from "@lenspack/core";
import { type SourceCall, run, tracedConnector } from "@lenspack/engine";
import { describe, expect, it } from "vitest";

import { supersetConnector } from "../src/connector";
import { packFromDatasets, type SupersetDataset } from "../src/index";

// The SQL under a chat answer, over Superset, is the SQL Superset compiled and ran: the `query`
// field of each result in the chart-data answer (result_type "full"). Superset 5.0 and 6.1 both
// send it (6.1 adds queried_dttm); a guest token's answer, or a proxy, may leave it out, and then
// one result_type "query" call compiles the same SQL without running it. Nothing runs twice.

const dataset: SupersetDataset = {
  id: 7,
  table_name: "visits",
  main_dttm_col: "visited_at",
  columns: [
    { column_name: "visited_at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "area", groupby: true, type: "TEXT", verbose_name: "Area" },
  ],
  metrics: [{ metric_name: "visits", expression: "COUNT(*)", verbose_name: "Visits" }],
};
const { pack, binding } = packFromDatasets([dataset], { pack: "v", entities: { "7": "visit" } });
const query: Query = { kind: "breakdown", dimension: "area", measure: "visits", limit: 5, sort: "desc", compare: "previous_period", time: { from: "2026-09-01T00:00:00Z", to: "2026-09-08T00:00:00Z" } };
const rows = [{ area: "North", visits: 12 }, { area: "South", visits: 7 }];
const SQL = (n: number) => `SELECT area AS area, COUNT(*) AS visits\nFROM public.visits\nWHERE visited_at >= '2026-0${n}-01 00:00:00'\nGROUP BY area\nLIMIT 5`;

type Body = { result_type: string; queries: unknown[] };
function superset(answer: (body: Body) => unknown) {
  const sent: Body[] = [];
  const post = async (_path: string, body: Body) => {
    sent.push(body);
    return answer(body);
  };
  return { sent, connector: supersetConnector({ post } as never, binding) };
}
const traced = async (s: ReturnType<typeof superset>) => {
  const calls: SourceCall[] = [];
  const data = await run(query, { pack, connector: tracedConnector(s.connector, calls) });
  return { data, calls };
};

describe("the SQL Superset ran, for an answer's explanation", () => {
  it("Superset 6.1: each result's query, from the answer itself; no second call", async () => {
    const s = superset((b) => ({ result: b.queries.map((_, i) => ({ data: rows, query: SQL(9 - i), is_cached: false, cached_dttm: null, queried_dttm: "2026-09-10T08:00:00", rowcount: 2, colnames: ["area", "visits"] })) }));
    const { data, calls } = await traced(s);
    expect(data.rows.map((r) => r.group)).toEqual(["North", "South"]);
    expect(calls).toEqual([{ language: "sql", text: SQL(9) }, { language: "sql", text: SQL(8) }]);
    expect(s.sent.map((b) => b.result_type)).toEqual(["full"]);
  });

  it("Superset 5.0: the same field, without queried_dttm; a cached answer says as of when", async () => {
    const s = superset((b) => ({ result: b.queries.map((_, i) => ({ data: rows, query: SQL(9 - i), is_cached: true, cached_dttm: "2026-09-10T07:30:00", rowcount: 2 })) }));
    const { calls } = await traced(s);
    expect(calls.map((c) => [c.language, c.text, c.cachedAt])).toEqual([
      ["sql", SQL(9), "2026-09-10T07:30:00Z"],
      ["sql", SQL(8), "2026-09-10T07:30:00Z"],
    ]);
    expect(s.sent).toHaveLength(1);
  });

  it("an answer without the SQL is compiled once more, without running, by result_type query", async () => {
    const s = superset((b) => (b.result_type === "query" ? { result: b.queries.map((_, i) => ({ language: "sql", query: SQL(9 - i) })) } : { result: b.queries.map(() => ({ data: rows })) }));
    const { data, calls } = await traced(s);
    expect(data.rows).toHaveLength(2);
    expect(s.sent.map((b) => b.result_type)).toEqual(["full", "query"]);
    expect(calls.map((c) => c.text)).toEqual([SQL(9), SQL(8)]);
  });

  it("when even that fails, the request Lenspack sent stands in, and says so; the answer is kept", async () => {
    const s = superset((b) => {
      if (b.result_type === "query") throw new Error("403 guest");
      return { result: b.queries.map(() => ({ data: rows })) };
    });
    const { data, calls } = await traced(s);
    expect(data.rows).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ language: "json", note: "Superset did not return the SQL it ran; this is the request it was sent." });
    expect(JSON.parse(calls[0]!.text)).toMatchObject({ datasource: { id: 7, type: "table" }, queries: [{ metrics: expect.anything() }] });
  });

  it("asks nothing more when no one is listening", async () => {
    const s = superset((b) => ({ result: b.queries.map(() => ({ data: rows })) }));
    await run(query, { pack, connector: s.connector });
    expect(s.sent.map((b) => b.result_type)).toEqual(["full"]);
  });
});
