import { type BoundPlan, type Capabilities, type Connector, type Format, type Plan, type Row, shapeRows } from "@lenspack/engine";
import type { Pack } from "@lenspack/spec";

import type { Binding } from "./catalogue";
import type { SupersetClient } from "./client";
import { BUCKET, type Metric, N, columnOf, queryObjects } from "./query";

// Superset computes every number: the engine resolves a query against the
// pack (keys, windows, refusals), this turns the bound plan into Superset query
// objects and runs them through /api/v1/chart/data, as Superset's own charts do.
// So a metric means one thing in both, and Superset's row-level security
// applies to whatever the service account may see.

export const SUPERSET_CAPABILITIES: Capabilities = { joins: false, exactDistinct: true, exactPercentiles: true, percentiles: false, twoStage: false, zonedBuckets: false };

type Native = { datasetId: number; queries: ReturnType<typeof queryObjects>["queries"]; metric: Metric | null };

const labelOf = (m: Metric) => (typeof m === "string" ? m : m.label);

export function supersetConnector(client: SupersetClient, binding: Binding): Connector {
  return {
    kind: "superset",
    capabilities: SUPERSET_CAPABILITIES,
    compile(bound: BoundPlan, _pack: Pack): Plan {
      const { queries, datasetId, metric } = queryObjects(bound, binding);
      const native: Native = { datasetId, queries, metric };
      return { text: JSON.stringify({ datasource: { id: datasetId, type: "table" }, queries }, null, 2), native, bound };
    },
    async execute(plan: Plan) {
      const { datasetId, queries, metric } = plan.native as Native;
      const bound = plan.bound;
      const q = bound.query;
      const res = await client.post<{ result: { data: Row[] }[] }>("/api/v1/chart/data", { datasource: { id: datasetId, type: "table" }, force: false, queries, result_format: "json", result_type: "full" });
      const [current = [], previous] = res.result.map((r) => r.data ?? []);
      const value = metric ? labelOf(metric) : "";
      const format = (bound.measure?.def.format ?? "number") as Format;
      let raw: Row[];
      switch (q.kind) {
        case "value":
          raw = [{ value: current[0]?.[value] ?? null, n: current[0]?.[N] ?? 0, ...(previous ? { previous: previous[0]?.[value] ?? null } : {}) }];
          break;
        case "breakdown": {
          const g = columnOf(bound.dimension!.def);
          const s = bound.split ? columnOf(bound.split.def) : null;
          const before = new Map((previous ?? []).map((r) => [`${r[g]}\u0000${s ? r[s] : ""}`, r[value]]));
          raw = current.map((r) => ({ group: r[g], ...(s ? { series: r[s] } : {}), value: r[value], n: r[N], ...(previous ? { previous: before.get(`${r[g]}\u0000${s ? r[s] : ""}`) ?? null } : {}) }));
          if (s) {
            // The top groups by their total, every split inside them.
            const totals = new Map<unknown, number>();
            for (const r of raw) totals.set(r.group, (totals.get(r.group) ?? 0) + (Number(r.value) || 0));
            const keep = new Set([...totals].sort((a, b) => (q.sort === "asc" ? a[1] - b[1] : b[1] - a[1])).slice(0, q.limit).map(([k]) => k));
            raw = raw.filter((r) => keep.has(r.group));
          }
          break;
        }
        case "series": {
          const by = bound.dimension ? columnOf(bound.dimension.def) : null;
          raw = current.map((r) => ({ bucket: r[BUCKET], ...(by ? { series: r[by] } : {}), value: r[value], n: r[N] })).sort((a, b) => Number(a.bucket) - Number(b.bucket));
          break;
        }
        case "rows": {
          const names = bound.columns.map((c) => [c.def.key, columnOf(c.def)] as const);
          raw = current.map((r) => Object.fromEntries(names.map(([k, c]) => [k, r[c]])));
          break;
        }
      }
      return shapeRows(raw, q, format, bound.measure?.def.key);
    },
  };
}
