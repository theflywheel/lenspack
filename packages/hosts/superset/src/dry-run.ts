import { type Connector, ResolveError, explain } from "@lenspack/engine";
import type { Pack } from "@lenspack/pack";
import { type DatasetFacts, type PackRisk, type QuerySafety, type SqlFinding, dryRunQueries, packRisks, sqlRisks } from "@lenspack/policy";

import type { Binding, SupersetDataset } from "./catalogue";
import type { SupersetClient } from "./client";

// The dry run, for operators before go-live (docs/operating/query-safety.md#the-dry-run): every query shape the pack
// allows (each measure as one value, by each dimension, over time at each grain, a list and a map, up to a cap), put
// through the same limits as a live question, then sent to Superset's chart-data API with result_type "query", which
// compiles the SQL and returns it WITHOUT running it. The SQL is read for what is risky: no LIMIT, a GROUP BY over a
// per-record column or many columns, no time condition on a heavy dataset. No data query is ever executed.

export type DryRunFinding = { what: string; entity: string; level: SqlFinding["level"]; message: string; sql: string };
export type DryRunReport = {
  /** Query shapes tried. */
  shapes: number;
  /** Statements Superset compiled (a shape can be several: each measure of a ratio, the previous period). */
  compiled: number;
  /** Shapes Lenspack itself refuses under the limits: never sent, in a live question either. */
  refused: { what: string; message: string }[];
  /** Shapes the pack cannot answer at all (a key it lacks on this dataset): not a safety matter, listed for completeness. */
  unanswerable: number;
  findings: DryRunFinding[];
  /** Shapes Superset failed to compile, with its message. */
  errors: { what: string; message: string }[];
  /** Risky definitions in the pack (packRisks). */
  pack: PackRisk[];
};

/** A dataset's columns as policy's pack checks read them: no query, only Superset's own description. */
export function datasetFacts(datasets: SupersetDataset[], binding: Binding): DatasetFacts[] {
  return datasets.flatMap((d) => {
    const entity = binding.entityOf.get(d.id);
    if (!entity) return [];
    const time = binding.datasets.get(entity)?.time ?? null;
    const type = d.columns.find((c) => c.column_name === time)?.type ?? "";
    return [
      {
        entity,
        label: `the dataset "${d.table_name}"`,
        timeColumn: time,
        dated: /^\s*(nullable\(\s*)?date(32)?\s*\)?\s*$/i.test(type),
        geo: binding.geo.has(entity),
        columns: d.columns.map((c) => ({ name: c.column_name, type: c.type ?? null, groupable: c.groupby !== false })),
      },
    ];
  });
}

type Compiled = { datasetId: number; queries: unknown[]; entity: string };

/**
 * The dry run itself. `connector` is the guarded Superset connector a live question goes through (so refusals are
 * the live ones); its compile is captured, and its execute is never called. Superset is asked only with
 * result_type "query".
 */
export async function dryRun(o: { client: SupersetClient; pack: Pack; binding: Binding; connector: Connector; safety: QuerySafety; datasets: SupersetDataset[]; cap?: number; timeoutMs?: number }): Promise<DryRunReport> {
  const report: DryRunReport = { shapes: 0, compiled: 0, refused: [], unanswerable: 0, findings: [], errors: [], pack: packRisks(o.pack, o.safety, datasetFacts(o.datasets, o.binding)) };
  for (const { what, query } of dryRunQueries(o.pack, o.cap ?? 300)) {
    report.shapes++;
    const compiled: Compiled[] = [];
    const capture: Connector = {
      ...o.connector,
      get capabilities() {
        return o.connector.capabilities;
      },
      async compile(bound, pack) {
        const plan = await o.connector.compile(bound, pack);
        const native = plan.native as { datasetId: number; queries: unknown[] };
        compiled.push({ datasetId: native.datasetId, queries: native.queries, entity: bound.root });
        return plan;
      },
      execute: () => Promise.reject(new Error("the dry run never runs a query")),
    };
    try {
      await explain(query, { pack: o.pack, connector: capture });
    } catch (e) {
      if (e instanceof ResolveError && e.code === "TOO_HEAVY") report.refused.push({ what, message: e.message });
      else if (e instanceof ResolveError) report.unanswerable++;
      else report.errors.push({ what, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    for (const c of compiled) {
      const body = { datasource: { id: c.datasetId, type: "table" }, force: false, queries: c.queries, result_format: "json", result_type: "query" as const };
      // The one guarantee of the dry run: Superset is only ever asked to compile.
      if (body.result_type !== "query") throw new Error("the dry run only asks Superset to compile");
      let sqls: string[];
      try {
        const r = await o.client.post<{ result: { query?: string }[] }>("/api/v1/chart/data", body, { timeoutMs: o.timeoutMs ?? 30_000 });
        sqls = r.result.map((x) => (typeof x.query === "string" ? x.query : ""));
      } catch (e) {
        report.errors.push({ what, message: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
        continue;
      }
      const ds = o.binding.datasets.get(c.entity);
      const own = o.safety.datasets[c.entity] ?? {};
      for (const sql of sqls) {
        report.compiled++;
        if (!sql.trim()) {
          report.errors.push({ what, message: "Superset compiled no SQL for this query" });
          continue;
        }
        for (const f of sqlRisks(sql, { timeColumn: ds?.time ?? null, heavy: !!own.heavy, highCardinality: own.highCardinality }))
          report.findings.push({ what, entity: c.entity, level: f.level, message: f.message, sql });
      }
    }
  }
  return report;
}

/** The report as lines for a terminal: the summary, then each finding and refusal. */
export function dryRunText(r: DryRunReport): string {
  const danger = r.findings.filter((f) => f.level === "danger");
  const lines = [
    `query safety dry run: ${r.shapes} query shapes, ${r.compiled} statements compiled by Superset (none run)`,
    `  ${danger.length} dangerous, ${r.findings.length - danger.length} warnings, ${r.refused.length} refused by the query limits, ${r.errors.length} errors, ${r.unanswerable} not answerable from the pack`,
  ];
  for (const p of r.pack) lines.push(`pack ${p.level}: ${p.message}`);
  for (const f of r.findings) lines.push(`${f.level === "danger" ? "DANGER" : "warning"}: ${f.what}: ${f.message}\n    ${f.sql.replace(/\s+/g, " ").slice(0, 400)}`);
  for (const x of r.refused) lines.push(`refused (as a live question would be): ${x.what}: ${x.message}`);
  for (const e of r.errors) lines.push(`error: ${e.what}: ${e.message}`);
  return lines.join("\n");
}

/**
 * The pack's example questions that the limits would refuse: each is compiled through the guarded connector (no
 * query runs), at start-up and each time the pack changes. A refused example is a warning: the chip would answer
 * with a refusal, so it should be changed.
 */
export async function exampleRefusals(pack: Pack, connector: Connector): Promise<PackRisk[]> {
  const out: PackRisk[] = [];
  const compileOnly: Connector = { ...connector, get capabilities() { return connector.capabilities; }, execute: () => Promise.reject(new Error("never run")) };
  for (const e of pack.examples ?? []) {
    try {
      await explain(e.query, { pack, connector: compileOnly });
    } catch (err) {
      if (err instanceof ResolveError && err.code === "TOO_HEAVY") out.push({ level: "warning", message: `The example question "${e.question}" would be refused by the query limits: ${err.message} Change the example (overlay.examples) so its chip answers.` });
    }
  }
  return out;
}
