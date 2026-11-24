import { type BoundPlan, type Capabilities, type Connector, type Plan, type Row, shapeBound } from "@lenspack/engine";
import type { Pack } from "@lenspack/spec";

import type { Binding } from "./catalogue";
import type { SupersetClient } from "./client";
import { sourceError } from "./source-errors";
import { BUCKET, type Metric, N, columnOf, metricLabel, queryObjects } from "./query";

// Superset computes every number: the engine resolves a query against the
// pack (keys, windows, refusals), this turns the bound plan into Superset query
// objects and runs them through /api/v1/chart/data, as Superset's own charts do.
// So a metric means one thing in both, and Superset's row-level security
// applies to whatever the service account may see.

export const SUPERSET_CAPABILITIES: Capabilities = { joins: false, exactDistinct: true, exactPercentiles: true, percentiles: false, twoStage: false, zonedBuckets: false, timeHeatmap: false, points: true };

type Native = { datasetId: number; queries: ReturnType<typeof queryObjects>["queries"]; metric: Metric | null };

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
    compile(bound: BoundPlan, _pack: Pack): Plan {
      const { queries, datasetId, metric } = queryObjects(bound, binding);
      const native: Native = { datasetId, queries, metric };
      return { text: JSON.stringify({ datasource: { id: datasetId, type: "table" }, queries }, null, 2), native, bound };
    },
    async execute(plan: Plan) {
      const { datasetId, queries, metric } = plan.native as Native;
      const bound = plan.bound;
      const q = bound.query;
      const res = await client
        .post<{ result: { data: Row[] }[] }>("/api/v1/chart/data", { datasource: { id: datasetId, type: "table" }, force: false, queries, result_format: "json", result_type: "full" })
        .catch((e: unknown) => {
          throw sourceError(e, opts.log);
        });
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
