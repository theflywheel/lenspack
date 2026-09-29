import type { BoardOp, Query } from "@lenspack/core";
import { type Pack, type PackDimension, type PackMeasure, type Where, parsePack } from "@lenspack/spec";
import YAML from "yaml";

// CCRS's analytics describe a dashboard as data already: a KPI is a query
// (grain, measures with filters, ratios, dimensions, sort, limit) plus a
// visual spec, and a pack places KPIs on a 12-column grid. This compiles that
// catalog into lenspack's split — a pack (each number defined once), boards
// (what to draw where), and a skin map that lets CCRS's own components draw
// lenspack's results column for column.

type Scalar = string | number | boolean;
type FilterSpec = Record<string, Scalar | Record<string, unknown>>;
type MeasureSpec = {
  name: string;
  agg: string;
  column?: string;
  filter?: FilterSpec;
  p?: number;
  numerator?: { agg: string; column?: string; filter?: FilterSpec };
  denominator?: { agg: string; column?: string; filter?: FilterSpec };
};
export type KpiQuery = {
  grain?: "facts" | "events" | "daily";
  window?: { name?: string; timeRole?: string; pinned?: boolean };
  dimensions?: string[];
  measures: MeasureSpec[];
  filters?: FilterSpec;
  sort?: { by: string; dir?: "asc" | "desc" }[];
  limit?: number;
};
export type KpiDefinition = {
  id: string;
  version?: string;
  status?: string;
  query: KpiQuery | null;
  viz: Record<string, unknown> & { kind: string; valueKey?: string; measureKey?: string; measureKeys?: string[] | null; dimensionKey?: string | null; delta?: { compare?: string } };
  params?: { name: string; default?: string; allowed?: string[] }[];
  requiredActionUrl?: string;
  public?: boolean;
};
export type DashboardPack = { id: string; description?: string; requiredActionUrl?: string; public?: boolean; tiles: string[]; layout: { kpiId: string; x: number; y: number; w: number; h: number }[] };

/** How one widget's lenspack result maps back onto the columns CCRS's components read. */
export type SkinTile = {
  kpiId: string;
  viz: KpiDefinition["viz"];
  params: KpiDefinition["params"];
  /** Reads the current open state: the board's date range does not narrow it. */
  live: boolean;
  /** lenspack result → CCRS result columns. */
  columns: { group?: string; series?: string; value: string; extras: Record<string, string>; records?: Record<string, string> };
  /** A daily series of the headline number, for sparkline cards. */
  sparkline?: { measure: string; dateColumn: string };
  public: boolean;
  requiredActionUrl?: string;
  /** The widget's lenspack query, before any board filter or request param. */
  query: Query;
  grain: "facts" | "events" | "daily";
  /** The KPI's own window when the request names none (last_7d, mtd, …). */
  window: string | null;
  /** The per-day column a daily series groups by on this grain. */
  seriesDate: string;
  /** Complaint-type level the KPI rolls up to when not overridden ("1", "leaf"). */
  hierLevel: string | null;
  /** The KPI's CCRS dimension names, in order (for result columns). */
  dimensions: string[];
  /** Record fields (rows queries), in the order CCRS returns them. */
  recordColumns?: string[];
  version?: string;
};
export type Skin = { tiles: Record<string, SkinTile>; packs: Record<string, { public: boolean; requiredActionUrl?: string }> };

export type CcrsResult = {
  pack: Pack;
  packYaml: string;
  boards: { id: string; title: string; ops: BoardOp[]; layout: { i: string; x: number; y: number; w: number; h: number }[]; tiles: string[] }[];
  skin: Skin;
  notes: { kpi: string; note: string }[];
};

const GRAIN = {
  facts: { entity: "facts", source: "complaint_facts", time: "created_at" },
  events: { entity: "events", source: "complaint_events", time: "complaint_created_at" },
  daily: { entity: "daily", source: "complaint_open_state_daily", time: "snapshot_date" },
} as const;

const CARD_KINDS = new Set(["number-tile", "number-tile-delta", "number-tile-sparkline", "sparkline-card", "scalar"]);
const DATE_COLUMNS = new Set(["created_date", "occurred_date", "snapshot_date"]);

// The complaint-type level a KPI rolls up to by default (hierLevel "1".."4"):
// the same expression pgr-services uses, as a Postgres fragment.
const hierDimension = (level: number): PackDimension => ({
  key: `service_type_l${level}`,
  entity: "facts",
  sql: { postgres: `coalesce(nullif(split_part(complaint_node_path, '.', least(${level}, complaint_depth)), ''), service_code)` },
  type: "string",
  label: `Complaint type (level ${level})`,
  synonyms: [],
  verified: true,
});

// A tile's stored query carries no window: the request supplies one.
const tilesQuery = (q: Query): Query => {
  const { time: _t, ...rest } = q as Query & { time?: unknown };
  return rest as Query;
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "n_$1") || "measure";
const unwrap = <T>(records: T[] | { data: T }[]): T[] => (records as { data?: T }[]).map((r) => (r && typeof r === "object" && "data" in r ? (r.data as T) : (r as T)));

// A KPI's own default window, kept so a widget stands on its own; on a board
// the date range sets the window instead, as CCRS's page does.
function windowOf(kpi: KpiDefinition): { last: string } | null {
  const name = kpi.params?.find((p) => p.name === "window")?.default || kpi.query?.window?.name;
  const m = /^last_(\d+)d$/.exec(name ?? "");
  if (m) return { last: `${m[1]}d` };
  return { dtd: { last: "1d" }, wtd: { last: "7d" }, mtd: { last: "30d" }, qtd: { last: "90d" }, ytd: { last: "365d" } }[name ?? ""] ?? null;
}

export function compileCcrs(kpiRecords: unknown[], packRecords: unknown[], opts: { tenantMatch?: "exact" | "subtree"; packName?: string; timeZone?: string } = {}): CcrsResult {
  const kpis = unwrap(kpiRecords as KpiDefinition[]).filter((k) => k && k.status !== "retired");
  const packs = unwrap(packRecords as DashboardPack[]);
  const notes: CcrsResult["notes"] = [];

  const entities: Pack["entities"] = {};
  const entityFor = (grain: KpiQuery["grain"] = "facts") => {
    const g = GRAIN[grain];
    entities[g.entity] ??= {
      source: g.source,
      time: grain === "daily" ? g.time : { field: g.time, unit: "epoch_ms" },
      tenant: { field: "tenant_id", match: opts.tenantMatch ?? "subtree" },
      joins: [],
    };
    return g.entity;
  };

  const dimensions = new Map<string, PackDimension>();
  const dimension = (entity: string, column: string): string => {
    if (/^service_type_l\d$/.test(column)) {
      dimensions.set(column, dimensions.get(column) ?? hierDimension(Number(column.slice(-1))));
      return column;
    }
    const known = dimensions.get(column);
    if (!known) dimensions.set(column, { key: column, entity, field: column, type: "string", synonyms: [], verified: true });
    else if (known.entity !== entity && entity === "facts") {
      // Complaint facts are the home grain: the other grains are copies of its
      // columns, recorded as also.
      const { [entity]: _self, ...rest } = known.also ?? {};
      dimensions.set(column, { ...known, entity: "facts", field: column, also: { ...rest, [known.entity]: { field: known.field ?? column } } });
    } else if (known.entity !== entity && !known.also?.[entity]) known.also = { ...(known.also ?? {}), [entity]: { field: column } };
    return column;
  };

  const measures = new Map<string, PackMeasure>();
  const bySig = new Map<string, string>();

  const toWhere = (filters: FilterSpec | undefined, kpi: string): Where[] => {
    const out: Where[] = [];
    for (const [column, spec] of Object.entries(filters ?? {})) {
      if (spec === null || typeof spec !== "object") {
        out.push({ field: column, op: "eq", value: spec as Scalar });
        continue;
      }
      for (const [op, v] of Object.entries(spec)) {
        if (op === "isnull") out.push({ field: column, op: v ? "missing" : "exists" });
        else if (op === "in") out.push({ field: column, op: "in", value: v as Scalar[] });
        else if (op === "ne") out.push({ field: column, op: "neq", value: v as Scalar });
        else if (["eq", "gt", "gte", "lt", "lte"].includes(op)) out.push({ field: column, op: op as Where["op"], value: v as Scalar });
        else notes.push({ kpi, note: `filter ${column}.${op} not translated` });
      }
    }
    return out;
  };

  // A readable key from what a number counts: complaints, open_complaints,
  // avg_rating_resolved_rated … deterministic, so a catalog compiles the same
  // way every time.
  const words = (where: Where[]) =>
    where
      .map((w) => {
        const c = w.field.replace(/^is_|^has_|^was_/, "");
        if (w.op === "eq" && w.value === true) return c;
        if (w.op === "eq" && w.value === false) return `not_${c}`;
        if (w.op === "missing") return `no_${c}`;
        if (w.op === "exists") return `with_${c}`;
        return `${c}_${w.op}_${Array.isArray(w.value) ? w.value.join("_") : String(w.value)}`;
      })
      .join("_");

  const simple = (entity: string, spec: { agg: string; column?: string; p?: number }, where: Where[], kpi: string): string | null => {
    const agg =
      spec.agg === "count" ? "count" : spec.agg === "count_distinct" ? "count_distinct" : ["sum", "avg", "min", "max"].includes(spec.agg) ? spec.agg : spec.agg === "percentile" ? (spec.p === 50 ? "median" : spec.p === 90 ? "p90" : null) : null;
    if (!agg) {
      notes.push({ kpi, note: `aggregate ${spec.agg}${spec.p ? ` p${spec.p}` : ""} not translated` });
      return null;
    }
    const sig = JSON.stringify([entity, agg, spec.column ?? null, [...where].map((w) => [w.field, w.op, w.value ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
    const known = bySig.get(sig);
    if (known) return known;
    const stem = agg === "count" ? "complaints" : `${agg}_${spec.column}`;
    const base = slug([entity === "facts" ? "" : entity, stem, words(where)].filter(Boolean).join("_")).slice(0, 60);
    let key = base;
    for (let i = 2; measures.has(key) || dimensions.has(key); i++) key = `${base}_${i}`;
    measures.set(key, {
      key,
      entity,
      agg: agg as PackMeasure["agg"],
      ...(spec.column ? { field: spec.column } : {}),
      ...(where.length ? { where } : {}),
      format: "number",
      synonyms: [],
      verified: true,
    });
    bySig.set(sig, key);
    return key;
  };

  const measureFor = (entity: string, kpi: KpiDefinition, m: MeasureSpec, base: Where[]): string | null => {
    if (m.agg !== "ratio") return simple(entity, m, [...base, ...toWhere(m.filter, kpi.id)], kpi.id);
    const n = m.numerator && simple(entity, m.numerator, [...base, ...toWhere(m.numerator.filter, kpi.id)], kpi.id);
    const d = m.denominator && simple(entity, m.denominator, [...base, ...toWhere(m.denominator.filter, kpi.id)], kpi.id);
    if (!n || !d) return null;
    const sig = JSON.stringify(["ratio", n, d]);
    const known = bySig.get(sig);
    if (known) return known;
    const stem = slug(`${kpi.id.replace(/^(cl|rs|ep)_/, "").replace(/_count$/, "")}${m.name === "pct" || m.name === "rate" || m.name === "ratio" ? "" : `_${m.name}`}`);
    let key = stem;
    for (let i = 2; measures.has(key) || dimensions.has(key); i++) key = `${stem}_${i}`;
    measures.set(key, { key, entity, derived: `${n} / ${d}`, label: String(kpi.viz.title ?? kpi.id), format: "percent", synonyms: [], verified: true });
    bySig.set(sig, key);
    return key;
  };

  const tiles: Skin["tiles"] = {};
  const widgetOps = new Map<string, BoardOp>();

  for (const kpi of kpis) {
    const q = kpi.query;
    if (!q) {
      notes.push({ kpi: kpi.id, note: "composed on the server from other KPIs; not translated" });
      continue;
    }
    const entity = entityFor(q.grain);
    const base = toWhere(q.filters, kpi.id);
    const live = q.filters?.is_open === true && !q.window?.timeRole;
    const names = new Map<string, string>(); // CCRS measure name → lenspack key
    for (const m of q.measures) {
      const key = measureFor(entity, kpi, m, base);
      if (key) names.set(m.name, key);
    }
    if (names.size === 0) continue;

    // The complaint-type level a chart reads by default.
    const hier = kpi.params?.find((p) => p.name === "hierLevel")?.default;
    const dims = (q.dimensions ?? []).map((c) => (c === "service_code" && hier && /^\d$/.test(hier) ? `service_type_l${hier}` : c));
    dims.forEach((c) => dimension(entity, c));

    const viz = kpi.viz;
    const valueName = viz.valueKey && names.has(viz.valueKey) ? viz.valueKey : viz.measureKey && names.has(viz.measureKey) ? viz.measureKey : [...names.keys()][0]!;
    const primary = names.get(valueName)!;
    const extras = Object.fromEntries([...names].filter(([n]) => n !== valueName).map(([n, k]) => [k, n]));
    const sortSpec = q.sort?.[0];
    const limit = Math.max(2, Math.min(500, q.limit ?? 12));
    let query: Query;
    let kind: "kpi" | "chart" | "table";
    const colMap: SkinTile["columns"] = { value: valueName, extras };

    if (CARD_KINDS.has(viz.kind) || dims.length === 0) {
      kind = "kpi";
      query = { kind: "value", measure: primary, ...(viz.delta?.compare === "prior" && !live ? { compare: "previous_period" } : {}), ...(Object.keys(extras).length ? { measures: Object.keys(extras) } : {}) } as Query;
    } else if (viz.kind === "sla-risk-table" || viz.kind === "table" && dims.includes("service_request_id")) {
      kind = "table";
      // One row per complaint: the dimensions and the per-complaint numbers
      // are columns of the entity itself.
      const cols = [...dims, ...[...names.keys()].map((n) => q.measures.find((m) => m.name === n)?.column).filter((c): c is string => !!c)];
      cols.forEach((c) => dimension(entity, c));
      for (const w of base) dimension(entity, w.field);
      query = {
        kind: "rows",
        entity,
        columns: cols,
        limit: Math.min(1000, q.limit ?? 50),
        filters: base.filter((w) => w.op === "eq" || w.op === "in").map((w) => ({ dimension: w.field, op: w.op as "eq" | "in", value: w.value as Scalar })),
      } as Query;
      colMap.records = Object.fromEntries(cols.map((c) => [c, c]));
    } else {
      kind = ["data-table", "table", "xtable"].includes(viz.kind) ? "table" : "chart";
      const [group, split] = dims;
      colMap.group = q.dimensions?.[0];
      if (split) colMap.series = q.dimensions?.[1];
      const byGroup = !!sortSpec && sortSpec.by === q.dimensions?.[0];
      query = {
        kind: "breakdown",
        dimension: group!,
        ...(split ? { by: split } : {}),
        measure: primary,
        ...(!split && Object.keys(extras).length ? { measures: Object.keys(extras).slice(0, 11) } : {}),
        limit,
        sort: sortSpec?.dir ?? (byGroup || DATE_COLUMNS.has(group!) ? "asc" : "desc"),
        // No declared sort means the database's own order, as CCRS returns it.
        // CCRS sorts on exactly what the KPI names: a measure alone (ties as
        // the database leaves them), a dimension, or nothing (its own order).
        ...(byGroup || DATE_COLUMNS.has(group!) ? { sortBy: "group" } : !sortSpec ? { sortBy: "none" } : { sortBy: "measure" }),
      } as Query;
      if (split && Object.keys(extras).length) notes.push({ kpi: kpi.id, note: "split by a second dimension: extra measures dropped" });
    }

    // Every non-live KPI reads a window: its own default until a board's
    // date range narrows it.
    const own = live ? null : windowOf(kpi);
    if (own && query.kind !== "rows") query = { ...query, time: own } as Query;
    else if (!live && query.kind !== "rows") query = { ...query, time: { last: "30d" } } as Query;
    const title = String(viz.title ?? kpi.id);
    const widget =
      kind === "kpi"
        ? { kind: "kpi", title, query, aggregate: "last" }
        : kind === "table"
          ? { kind: "table", title, query, pageSize: 50 }
          : { kind: "chart", chart: viz.kind === "line" ? "line" : viz.kind === "pie" ? "pie" : "bar", title, query, options: { legend: true, colorScheme: "default" } };
    widgetOps.set(kpi.id, { op: "add_widget", id: kpi.id, widget, placement: { place: "bottom", width: "half" } } as unknown as BoardOp);

    const sparkDate = typeof viz.dateKey === "string" && DATE_COLUMNS.has(viz.dateKey) ? (q.grain === "daily" ? "snapshot_date" : "created_date") : null;
    if (sparkDate) dimension(entity, sparkDate);
    tiles[kpi.id] = {
      kpiId: kpi.id,
      viz,
      params: kpi.params,
      live,
      columns: colMap,
      ...(kind === "kpi" && sparkDate && /sparkline/.test(viz.kind) ? { sparkline: { measure: names.get(String(viz.sparklineMeasureKey ?? valueName)) ?? primary, dateColumn: sparkDate } } : {}),
      public: kpi.public === true,
      ...(kpi.requiredActionUrl ? { requiredActionUrl: kpi.requiredActionUrl } : {}),
      query: tilesQuery(query),
      grain: q.grain ?? "facts",
      window: live ? null : (kpi.params?.find((p) => p.name === "window")?.default || q.window?.name || null),
      seriesDate: q.grain === "daily" ? "snapshot_date" : q.grain === "events" ? "occurred_date" : "created_date",
      hierLevel: hier ?? null,
      dimensions: q.dimensions ?? [],
      ...(query.kind === "rows" ? { recordColumns: [...(q.dimensions ?? []), ...q.measures.map((m) => m.name)] } : {}),
      ...(kpi.version ? { version: kpi.version } : {}),
    };
  }
  // When the numbers were last rebuilt: CCRS reports it as asOf.
  entityFor("facts");
  measures.set("facts_built_at", { key: "facts_built_at", entity: "facts", agg: "max", field: "facts_built_at", format: "number", synonyms: [], verified: true });
  // The complaint-type filter narrows by a node of the type tree.
  dimension("facts", "complaint_node_path");
  for (const c of ["ward_code", "service_code", "department_code", "boundary_path", "account_id"]) dimension("facts", c);

  const rawPack = {
    pack: opts.packName ?? "ccrs",
    version: 1,
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    description: "Complaint analytics compiled from a CCRS KPI catalog (dss.KpiDefinition): complaint facts, workflow events and daily open-state snapshots.",
    entities,
    dimensions: [...dimensions.values()],
    measures: [...measures.values()],
  };
  const pack = parsePack(rawPack);

  const boards = packs.map((p) => {
    const ops = p.tiles.filter((t) => widgetOps.has(t)).map((t) => widgetOps.get(t)!);
    // The employee page narrows every non-live tile by its date range; the
    // public page sends none, so each tile keeps its own default window.
    const dated = p.public ? [] : p.tiles.filter((t) => widgetOps.has(t) && !tiles[t]?.live);
    const filters: BoardOp[] = [
      ...(dated.length ? [{ op: "add_filter", filter: { id: "dates", type: "daterange", label: "Dates", field: "time", applies: dated, default: { months: 1 } } }] : []),
      { op: "add_filter", filter: { id: "ward", type: "select", label: "Ward", field: "ward_code", applies: ["*"] } },
      { op: "add_filter", filter: { id: "complaint_type", type: "select", label: "Complaint type", field: "service_code", applies: ["*"] } },
    ] as unknown as BoardOp[];
    dimension("facts", "ward_code");
    dimension("facts", "service_code");
    return {
      id: p.id,
      title: String(p.description ?? p.id).split(" — ")[0]!,
      ops: [...ops, ...filters],
      layout: p.layout.filter((l) => widgetOps.has(l.kpiId)).map((l) => ({ i: l.kpiId, x: l.x, y: l.y, w: l.w, h: l.h })),
      // The pack's own tile list is what CCRS serves; the layout may omit
      // some, which its UI then places itself.
      tiles: p.tiles.filter((t) => widgetOps.has(t)),
    };
  });
  // Dimensions added for board filters after the pack was parsed.
  const finalPack = parsePack({ ...rawPack, dimensions: [...dimensions.values()] });

  const skin: Skin = { tiles, packs: Object.fromEntries(packs.map((p) => [p.id, { public: p.public === true, ...(p.requiredActionUrl ? { requiredActionUrl: p.requiredActionUrl } : {}) }])) };
  void pack;
  return { pack: finalPack, packYaml: YAML.stringify(JSON.parse(JSON.stringify({ ...rawPack, dimensions: [...dimensions.values()] })), { lineWidth: 0 }), boards, skin, notes };
}
export { ccrsApi, type CcrsApiOptions, type Board as CcrsBoard } from "./api";
