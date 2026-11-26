import { type BoundPlan, type Capabilities, type Connector, type ExecuteOptions, type Plan, type Row, type SourceStatement, shapeBound } from "@lenspack/engine";
import type { Pack } from "@lenspack/pack";

import type { Binding } from "./catalogue";
import type { SupersetClient } from "./client";
import { sourceError } from "./source-errors";
import { BUCKET, type Metric, N, columnOf, computeRefusalForSuperset, metricLabel, queryObjects } from "./query";

// Superset computes every number: the engine resolves a query against the
// pack (keys, windows, refusals), this turns the bound plan into Superset query
// objects and runs them through /api/v1/chart/data, as Superset's own charts do.
// So a metric means one thing in both, and Superset's row-level security
// applies to whatever the service account may see.

// A widget with compute is kept as a Superset chart only where Superset recomputes it the same
// way: with its advanced analytics, or as a pivot table (computeForm). Reading through this
// connector, the steps are not sent as Superset post-processing: the engine asks for the base rows
// and computes them, as for every source, so a chat answer follows the same rules for zeros and
// gaps whatever the source (docs/compute.md).
export const SUPERSET_CAPABILITIES: Capabilities = {
  joins: false,
  exactDistinct: true,
  exactPercentiles: true,
  percentiles: false,
  twoStage: false,
  zonedBuckets: false,
  timeHeatmap: false,
  points: true,
  savedCompute: computeRefusalForSuperset,
};

type Native = { datasetId: number; queries: ReturnType<typeof queryObjects>["queries"]; metric: Metric | null };

/** One query's part of a chart-data answer: its rows, and (result_type "full", Superset 5.0 and 6.1 alike) the SQL it ran. */
type ChartResult = { data?: Row[]; query?: string; is_cached?: boolean; cached_dttm?: string | null };

/** Superset writes its cache time in UTC without a zone ("2026-11-20T09:12:03"); said as UTC. */
const utc = (t: string) => (/^\d{4}-\d\d-\d\dT[\d:.]+$/.test(t) ? `${t}Z` : t);

/**
 * What Superset ran for each query object, told to `ran`: the SQL in each result's `query` field. A
 * response without it (a proxy that trims it, a guest token's answer) is asked again with
 * `result_type: "query"`, which compiles the same SQL without running it; failing that, the request
 * itself is told, saying so. Never throws: an answer is never lost to its explanation.
 */
async function reportSql(client: SupersetClient, body: Record<string, unknown>, queries: unknown[], results: ChartResult[], ran: NonNullable<ExecuteOptions["ran"]>) {
  const sql = queries.map((_, i) => (typeof results[i]?.query === "string" && results[i]!.query!.trim() ? results[i]!.query! : null));
  if (sql.some((s) => s === null)) {
    try {
      const compiled = await client.post<{ result: { query?: string }[] }>("/api/v1/chart/data", { ...body, result_type: "query" });
      compiled.result.forEach((r, i) => (sql[i] ??= typeof r.query === "string" && r.query.trim() ? r.query : null));
    } catch {
      /* the request below stands in for the SQL */
    }
  }
  queries.forEach((q, i) => {
    const r = results[i];
    const cached = r?.is_cached && r.cached_dttm ? { cachedAt: utc(r.cached_dttm) } : {};
    const said: SourceStatement = sql[i]
      ? { language: "sql", text: sql[i]!, ...cached }
      : { language: "json", text: JSON.stringify({ datasource: body.datasource, queries: [q] }, null, 2), note: "Superset did not return the SQL it ran; this is the request it was sent.", ...cached };
    ran(said);
  });
}

/**
 * `capabilities` narrows what the connector offers at the moment (a deployment's off switches), read on every check.
 * `log` gets a failed query's raw error; the error handed on names no hosts or ports (see source-errors).
 */
export function supersetConnector(client: SupersetClient, binding: Binding, opts: { capabilities?: () => Partial<Capabilities>; log?: (line: string) => void } = {}): Connector {
  return {
    kind: "superset",
    get capabilities(): Capabilities {
      return opts.capabilities ? { ...SUPERSET_CAPABILITIES, ...opts.capabilities() } : SUPERSET_CAPABILITIES;
    },
    compile(bound: BoundPlan, pack: Pack): Plan {
      const { queries, datasetId, metric } = queryObjects(bound, binding, pack.timeZone);
      const native: Native = { datasetId, queries, metric };
      return { text: JSON.stringify({ datasource: { id: datasetId, type: "table" }, queries }, null, 2), native, bound };
    },
    async execute(plan: Plan, o?: ExecuteOptions) {
      const { datasetId, queries, metric } = plan.native as Native;
      const bound = plan.bound;
      const q = bound.query;
      const body = { datasource: { id: datasetId, type: "table" }, force: false, queries, result_format: "json", result_type: "full" };
      const res = await client.post<{ result: ChartResult[] }>("/api/v1/chart/data", body).catch((e: unknown) => {
        throw sourceError(e, opts.log);
      });
      // Only when asked (a chat answer's explanation): the SQL Superset compiled and ran, from this same answer.
      if (o?.ran) await reportSql(client, body, queries, res.result, o.ran);
      const [current = [], previous] = res.result.map((r) => r.data ?? []);
      const value = metric ? metricLabel(metric) : "";
      let raw: Row[];
      switch (q.kind) {
        case "value":
          raw = [{ value: current[0]?.[value] ?? null, n: current[0]?.[N] ?? 0, ...(previous ? { previous: previous[0]?.[value] ?? null } : {}) }];
          break;
        case "breakdown": {
          const g = columnOf(bound.dimension!.def);
          const s = bound.split ? columnOf(bound.split.def) : null;
          const key = (r: Row) => `${r[g]}\u0000${s ? r[s] : ""}`;
          const before = new Map((previous ?? []).map((r) => [key(r), r[value]]));
          // Split, the engine keeps the top groups, every split inside them.
          raw = current.map((r) => ({ group: r[g], ...(s ? { series: r[s] } : {}), value: r[value], n: r[N], ...(previous ? { previous: before.get(key(r)) ?? null } : {}) }));
          break;
        }
        case "series": {
          const by = bound.dimension ? columnOf(bound.dimension.def) : null;
          raw = current.map((r) => ({ bucket: r[BUCKET], ...(by ? { series: r[by] } : {}), value: r[value], n: r[N] }));
          break;
        }
        case "rows": {
          const names = bound.columns.map((c) => [c.def.key, columnOf(c.def)] as const);
          raw = current.map((r) => Object.fromEntries(names.map(([k, c]) => [k, r[c]])));
          break;
        }
        case "points": {
          const named = (key: string | undefined) => (key ? columnOf(bound.columns.find((c) => c.def.key === key)!.def) : null);
          const color = named(q.color);
          const label = named(q.label);
          raw = current.map((r) => ({ lat: r[bound.geo!.lat], lon: r[bound.geo!.lon], ...(color ? { color: r[color] } : {}), ...(label ? { label: r[label] } : {}), ...(metric ? { size: r[value] } : {}) }));
          break;
        }
      }
      return shapeBound(raw, bound);
    },
  };
}
