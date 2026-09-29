import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Query } from "@lenspack/core";
import { type Connector, SQL_CAPABILITIES } from "@lenspack/engine";
import { describe, expect, it } from "vitest";

import { ccrsApi, compileCcrs } from "../src";

// The adapter's request rules, as pgr-services' KpiQueryComposer applies them,
// checked on the queries it sends: a recording connector answers every one
// with a single row and keeps what it was asked.

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => JSON.parse(readFileSync(join(here, "fixtures", f), "utf8"));
const compiled = compileCcrs(read("KpiDefinition.json"), read("DashboardPack.json"), { timeZone: "Africa/Nairobi" });

// Tuesday 2026-09-29, 09:00 in Nairobi (UTC+3).
const NOW = new Date("2026-09-29T06:00:00Z");

function harness() {
  const seen: Query[] = [];
  const connector: Connector = {
    kind: "postgres",
    capabilities: SQL_CAPABILITIES,
    compile: (bound) => ({ text: "", native: null, bound }),
    execute: async (plan) => {
      const q = plan.bound.query;
      // The envelope's asOf is not the reference's own query.
      if (!(q.kind === "value" && q.measure === "facts_built_at")) seen.push(q);
      if (q.kind === "rows") return { rows: [], total: 0, format: "number", records: [], columns: q.columns };
      return { rows: [{ group: q.kind === "value" ? "" : "2026-09-28", ...(q.kind === "breakdown" && q.by ? { series: "X" } : {}), value: 1, count: 1 }], total: 1, format: "number" };
    },
  };
  const boards = compiled.boards.map((b) => ({ id: b.id, public: compiled.skin.packs[b.id]?.public ?? false, requiredActionUrl: compiled.skin.packs[b.id]?.requiredActionUrl, layout: b.layout, tiles: b.layout.map((l) => l.i) }));
  const api = ccrsApi({ pack: compiled.pack, connector, skin: compiled.skin, boards, tenant: "ke", now: () => NOW });
  const ask = async (kpiId: string, params: Record<string, string> = {}) => {
    seen.length = 0;
    const out = (await api("/_query", { queries: { k: { kpiId, params } } })) as { body: { results: { k: Record<string, unknown> } } };
    return { result: out.body.results.k, queries: [...seen] };
  };
  return { ask };
}

const timeOf = (q: Query) => (q as { time?: { from: string; to: string } }).time;

describe("the CCRS analytics API on lenspack", () => {
  const { ask } = harness();

  it("keeps a pinned window's own period whatever range is selected", async () => {
    const today = await ask("cl_created_today_count", { dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    expect(timeOf(today.queries[0]!)).toEqual({ from: "2026-09-28T21:00:00.000Z", to: NOW.toISOString() });
    // compare:prior is the preceding window of equal span: yesterday.
    const prior = await ask("cl_created_today_count", { compare: "prior" });
    expect(timeOf(prior.queries[0]!)).toEqual({ from: "2026-09-27T21:00:00.000Z", to: "2026-09-28T21:00:00.000Z" });
  });

  it("answers a pinned tile outside the selected range with nothing, flagged", async () => {
    const r = await ask("cl_created_today_count", { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    expect(r.result).toMatchObject({ rows: [], rowCount: 0, suppressed: "filter_excludes_window" });
    expect(r.queries).toHaveLength(0);
  });

  it("gives a pinned tile's sparkline a trend axis wider than the pin", async () => {
    const r = await ask("cl_created_today_count", { series: "daily" });
    expect(timeOf(r.queries[0]!)?.from).toBe(new Date(NOW.getTime() - 30 * 86_400_000).toISOString());
  });

  it("reads a live tile at the current state, but its sparkline over the selected range", async () => {
    const base = await ask("rs_breach_total", { dateFrom: "2026-09-01", dateTo: "2026-09-10" });
    expect(timeOf(base.queries[0]!)).toBeUndefined();
    const series = await ask("rs_breach_total", { dateFrom: "2026-09-01", dateTo: "2026-09-10", series: "daily" });
    expect(timeOf(series.queries[0]!)).toEqual({ from: "2026-08-31T21:00:00.000Z", to: "2026-09-10T21:00:00.000Z" });
    expect(series.queries[0]).toMatchObject({ kind: "breakdown", dimension: "created_date", limit: 10 });
  });

  it("rolls complaint types up to any level, dropping the service group", async () => {
    const r = await ask("cl_table_complaint_type_details", { hierLevel: "3" });
    expect(r.queries[0]).toMatchObject({ kind: "breakdown", dimension: "service_type_l3" });
    expect((r.queries[0] as { by?: string }).by).toBeUndefined();
    expect(r.result.columns).not.toContain("service_group");
    expect(r.result.columns).toContain("service_code");
  });

  it("refuses a level outside 1..12 as pgr-services does", async () => {
    const r = await ask("cl_chart_complaints_by_type", { hierLevel: "13" });
    expect(r.result).toMatchObject({ error: "invalid_param" });
  });

  it("keeps every measure of a table split by a second dimension", async () => {
    const r = await ask("cl_table_complaint_type_details");
    expect(r.queries.length).toBeGreaterThan(1); // one query per measure, merged per group
    expect(r.result.columns).toEqual(["service_code", "service_group", "avg_resolution_ms", "ideal_sla_ms", "reopen_rate", "oldest_open_ms", "ontime_rate", "avg_csat"]);
  });

  it("refuses a malformed date range per reference", async () => {
    const r = await ask("cl_chart_complaints_by_type", { dateFrom: "2026-09-10", dateTo: "2026-09-01" });
    expect(r.result).toMatchObject({ error: "invalid_param" });
  });
});
