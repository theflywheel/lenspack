import type { FilterClause, Query } from "@lenspack/core";
import { type Connector, type Ctx, type WidgetData, addDays, localDate, run, startOfLocalDay } from "@lenspack/engine";
import type { Pack } from "@lenspack/spec";

import type { Skin, SkinTile } from "./index";

// CCRS's analytics API (pgr-services /v2/analytics), answered by lenspack.
// A CCRS dashboard sends { kpiId, params } references; each becomes a
// lenspack query over the compiled pack, and each result goes back in CCRS's
// own envelope and column names — so CCRS's UI runs unchanged on lenspack,
// and a migration is a base-URL switch.

export type Board = { id: string; public: boolean; requiredActionUrl?: string; layout: { i: string; x: number; y: number; w: number; h: number }[]; tiles: string[] };

export type CcrsApiOptions = {
  pack: Pack;
  connector: Connector;
  skin: Skin;
  boards: Board[];
  tenant: string;
  now?: () => Date;
  /**
   * Who may see what stays with the system that knows the user: the
   * capability grant CCRS's own /_access returns for the caller's token.
   * Absent, every tile is visible (a trusted, private deployment).
   */
  capabilities?: (body: Record<string, unknown>, request?: unknown) => Promise<string[] | null>;
  /**
   * The caller's row scope as CCRS resolves it (departments, jurisdictions,
   * own records), applied as filters so an employee sees exactly the rows
   * CCRS would show them.
   */
  scope?: (body: Record<string, unknown>, request?: unknown) => Promise<RowScope | null>;
};

export type RowScope = { departments?: string[]; jurisdictions?: string[]; accountId?: string; restrictedTo?: string };

type InlineQuery = { grain?: string; window?: { name?: string }; dimensions?: string[]; measures?: { name: string; agg: string; column?: string; filter?: unknown }[]; limit?: number; filters?: unknown; sort?: unknown };
type Ref = { kpiId?: string; params?: Record<string, string> } & InlineQuery;
type Result = { grain: string; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; tookMs: number; paramsIgnored?: string[] };

const ACTION = "/pgr-services/v2/analytics";
const MAX_BATCH = 50;
const DATE_COLUMNS = new Set(["created_date", "occurred_date", "snapshot_date"]);

// CCRS rounds ratios to four places in SQL; the same rounding here keeps
// every printed digit the same.
const round4 = (v: number | null) => (v === null ? null : Math.round(v * 10_000) / 10_000);

export function ccrsApi(opts: CcrsApiOptions) {
  const tz = opts.pack.timeZone ?? "UTC";
  const now = () => (opts.now ? opts.now() : new Date());
  const ctx = (): Ctx => ({ tenant: opts.tenant, now: now() });
  const measureOf = (key: string) => opts.pack.measures.find((m) => m.key === key);
  const isRatio = (key: string) => {
    const m = measureOf(key);
    return !!m?.derived && m.format === "percent";
  };

  /** A tile as CCRS's catalog serialises it: the typed viz fields always present. */
  const safeTile = (t: SkinTile) => ({
    kpiId: t.kpiId,
    version: t.version ?? "1.0.0",
    titleKey: (t.viz.titleKey as string) ?? null,
    viz: {
      kind: t.viz.kind,
      format: t.viz.format ?? null,
      valueKey: t.viz.valueKey ?? null,
      accent: t.viz.accent ?? null,
      group: t.viz.group ?? null,
      titleKey: t.viz.titleKey ?? null,
      dimensionKey: t.viz.dimensionKey ?? null,
      measureKeys: t.viz.measureKeys ?? null,
      variants: t.viz.variants ?? null,
      compose: t.viz.compose ?? null,
      pii: t.viz.pii ?? false,
      ...Object.fromEntries(Object.entries(t.viz).filter(([k]) => !["kind", "format", "valueKey", "accent", "group", "titleKey", "dimensionKey", "measureKeys", "variants", "compose", "pii"].includes(k))),
    },
    params: t.params ?? [],
  });

  const visible = (t: SkinTile, caps: string[] | null, isPublic: boolean) => (isPublic ? t.public : caps === null || (!!t.requiredActionUrl && caps.includes(t.requiredActionUrl)));

  // ── Windows, as pgr-services computes them ─────────────────────────────
  const startOf = (name: string, today: string): string | null => {
    const [y, m, d] = today.split("-").map(Number) as [number, number, number];
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday 0
    switch (name) {
      case "dtd":
        return today;
      case "wtd":
        return addDays(today, -dow);
      case "mtd":
        return `${today.slice(0, 7)}-01`;
      case "qtd":
        return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
      case "ytd":
        return `${y}-01-01`;
      default:
        return null;
    }
  };
  /** The window a request reads: its date range, else its window param, else the KPI's own. */
  const windowFor = (tile: SkinTile, params: Record<string, string>): { from: Date; to: Date } | null => {
    if (tile.live) return null;
    if (params.dateFrom && params.dateTo) return { from: startOfLocalDay(params.dateFrom, tz), to: startOfLocalDay(addDays(params.dateTo, 1), tz) };
    const name = params.window ?? tile.window;
    if (!name || name === "all") return null;
    const at = now();
    const rolling = /^last_(\d+)d$/.exec(name);
    if (rolling) return { from: new Date(at.getTime() - Number(rolling[1]) * 86_400_000), to: at };
    const start = startOf(name, localDate(at, tz));
    return start ? { from: startOfLocalDay(start, tz), to: at } : null;
  };
  /** The prior period: the span before a date range, or the previous calendar week. */
  const priorFor = (tile: SkinTile, params: Record<string, string>): { from: Date; to: Date } | null => {
    if (params.dateFrom && params.dateTo) {
      const from = startOfLocalDay(params.dateFrom, tz);
      const to = startOfLocalDay(addDays(params.dateTo, 1), tz);
      return { from: new Date(from.getTime() - (to.getTime() - from.getTime())), to: from };
    }
    const thisMonday = startOf("wtd", localDate(now(), tz))!;
    return { from: startOfLocalDay(addDays(thisMonday, -7), tz), to: startOfLocalDay(thisMonday, tz) };
  };

  // ── One reference → one lenspack query ─────────────────────────────────
  const build = (tile: SkinTile, params: Record<string, string>, isPublic: boolean, scope: RowScope | null = null) => {
    const ignored: string[] = [];
    let q: Query = JSON.parse(JSON.stringify(tile.query));
    const filters: FilterClause[] = [...((q as { filters?: FilterClause[] }).filters ?? [])];
    // The caller's rows, as CCRS scopes them. An empty list admits nothing.
    if (scope?.departments) filters.push({ dimension: "department_code", op: "in", value: scope.departments.length ? scope.departments : ["\u0000none"] });
    if (scope?.jurisdictions) filters.push({ dimension: "boundary_path", op: "segment", value: scope.jurisdictions.length ? scope.jurisdictions : ["\u0000none"] } as unknown as FilterClause);
    if (scope?.accountId) filters.push({ dimension: "account_id", op: "eq", value: scope.accountId });
    // The KPI's own filters narrow the rows, as CCRS's WHERE does.
    for (const f of tile.rowFilters ?? []) if (!filters.some((x) => x.dimension === f.dimension && x.op === f.op)) filters.push(f as FilterClause);
    const narrow = (dimension: string, op: FilterClause["op"], value: string, param: string) => {
      // A param may not override a filter the KPI itself bakes in.
      if (isPublic && filters.some((f) => f.dimension === dimension)) return ignored.push(param);
      const i = filters.findIndex((f) => f.dimension === dimension && f.op === op);
      if (i >= 0) filters.splice(i, 1);
      filters.push({ dimension, op, value });
    };
    if (params.ward && params.ward !== "all") narrow("ward_code", "eq", params.ward, "ward");
    if (params.serviceCode && params.serviceCode !== "all") narrow("service_code", "eq", params.serviceCode, "serviceCode");
    if (params.complaintPath && !/^[A-Za-z0-9._/\-]{1,256}$/.test(params.complaintPath))
      throw Object.assign(new Error("invalid_param: complaintPath must match ^[A-Za-z0-9._/\\-]{1,256}$"), { status: 400, perRef: true });
    if (params.complaintPath) {
      if (tile.grain === "daily") ignored.push("complaintPath");
      else narrow("complaint_node_path", "subtree", params.complaintPath, "complaintPath");
    }
    if (filters.length) q = { ...q, filters } as Query;

    // The complaint-type level a chart rolls up to.
    const level = params.hierLevel ?? tile.hierLevel;
    if (q.kind === "breakdown" && tile.dimensions.includes("service_code") && level) {
      const dim = level === "leaf" ? "service_code" : `service_type_l${level}`;
      if (tile.dimensions[0] === "service_code") q = { ...q, dimension: dim };
      else if (tile.dimensions[1] === "service_code") q = { ...q, by: dim } as Query;
    }
    return { q, ignored };
  };

  const withWindow = (q: Query, w: { from: Date; to: Date } | null): Query => {
    const { time: _t, compare: _c, ...rest } = q as Query & { time?: unknown; compare?: unknown };
    return (w ? { ...rest, time: { from: w.from.toISOString(), to: w.to.toISOString() } } : rest) as Query;
  };

  const cell = (column: string, v: unknown, key?: string) => {
    if (DATE_COLUMNS.has(column) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return Date.parse(`${v.slice(0, 10)}T00:00:00Z`);
    if (key && typeof v === "number" && isRatio(key)) return round4(v);
    return v;
  };

  /** lenspack's widget data → CCRS's { columns, rows } in the KPI's own column names. */
  const toResult = (tile: SkinTile, q: Query, data: WidgetData, grain: string, started: number, ignored: string[]): Result => {
    const cols = tile.columns;
    // Measures in the KPI's own order, as pgr-services selects them.
    const order = (names: string[]) => (tile.measureOrder?.length ? [...names].sort((a, b) => tile.measureOrder.indexOf(a) - tile.measureOrder.indexOf(b)) : names);
    let columns: string[];
    let rows: Record<string, unknown>[];
    if (data.records) {
      columns = tile.recordColumns ?? data.columns ?? [];
      const src = data.columns ?? [];
      const fixed = tile.recordConstants ?? {};
      rows = data.records.map((r) => Object.fromEntries(columns.map((c, i) => [c, c in fixed ? fixed[c] : cell(c, r[src[i] ?? c])])));
    } else if (q.kind === "value") {
      const extras = Object.entries(cols.extras);
      columns = order([cols.value, ...extras.map(([, name]) => name)]);
      const r = data.rows[0];
      rows = r ? [{ [cols.value]: cell(cols.value, r.value, q.measure), ...Object.fromEntries(extras.map(([key, name]) => [name, cell(name, r.values?.[key] ?? null, key)])) }] : [];
    } else {
      const measure = (q as { measure: string }).measure;
      const extras = Object.entries(cols.extras);
      const dims = [cols.group, cols.series].filter((d): d is string => !!d);
      columns = [...dims, ...order([cols.value, ...extras.map(([, name]) => name)])];
      rows = data.rows.map((r) => ({
        ...(cols.group ? { [cols.group]: cell(cols.group, r.group === "(none)" ? null : r.group) } : {}),
        ...(cols.series ? { [cols.series]: cell(cols.series, r.series === "(none)" ? null : r.series) } : {}),
        [cols.value]: cell(cols.value, r.value, measure),
        ...Object.fromEntries(extras.map(([key, name]) => [name, cell(name, r.values?.[key] ?? null, key)])),
      }));
    }
    // Each row lists its fields in column order, as pgr-services' JSON does.
    rows = rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]])));
    return { grain, columns, rows, rowCount: rows.length, tookMs: Date.now() - started, ...(ignored.length ? { paramsIgnored: ignored } : {}) };
  };

  // The inline queries a CCRS page sends itself: distinct values of one
  // dimension with a count (the ward and complaint-type menus). Anything
  // richer is refused rather than guessed.
  const runInline = async (ref: InlineQuery, scope: RowScope | null): Promise<Result | { error: string; message: string }> => {
    const started = Date.now();
    const [dim, ...more] = ref.dimensions ?? [];
    const measure = ref.measures?.[0];
    if (!dim || more.length || (ref.measures?.length ?? 0) !== 1 || measure?.agg !== "count" || measure.filter || ref.filters || !opts.pack.dimensions.some((d) => d.key === dim))
      return { error: "unsupported_query", message: "unsupported_query: only distinct values of one dimension with a count are answered inline" };
    const tile = { dimensions: [dim], grain: "facts", live: true, query: { kind: "breakdown", dimension: dim, measure: "complaints", limit: Math.min(1000, ref.limit ?? 1000), sort: "desc", sortBy: "none" } } as unknown as SkinTile;
    const { q } = build(tile, {}, false, scope);
    const data = await run(q, { pack: opts.pack, connector: opts.connector, ctx: ctx() });
    if (data.error) return { error: "query_failed", message: data.error };
    const rows = data.rows.map((r) => ({ [dim]: r.group === "(none)" ? null : r.group, [measure.name]: r.value }));
    return { grain: ref.grain ?? "facts", columns: [dim, measure.name], rows, rowCount: rows.length, tookMs: Date.now() - started };
  };

  const runRef = async (name: string, ref: Ref, isPublic: boolean, caps: string[] | null, scope: RowScope | null): Promise<Result | { error: string; message: string }> => {
    if (!ref.kpiId) {
      if (isPublic || (caps !== null && !caps.includes(`${ACTION}/_query`))) return { error: "kpi_forbidden", message: "kpi_forbidden: inline queries need the query capability" };
      return runInline(ref, scope);
    }
    const tile = opts.skin.tiles[ref.kpiId];
    if (!tile || !visible(tile, caps, isPublic)) return { error: "kpi_forbidden", message: `kpi_forbidden: '${ref.kpiId}' is not available` };
    const params = { ...Object.fromEntries((tile.params ?? []).filter((p) => p.default).map((p) => [p.name, p.default!])), ...(ref.params ?? {}) };
    const started = Date.now();
    const { q, ignored } = build(tile, params, isPublic, scope);
    let query: Query;
    // pgr-services resolves compare:prior before the live-snapshot rule: even
    // a tile reading the current open state compares against the prior window.
    if (params.compare === "prior") query = withWindow(q, priorFor(tile, params));
    else if (params.series === "daily") {
      // A daily series of the headline number over the same window.
      const w = windowFor(tile, params) ?? (tile.live ? null : { from: new Date(now().getTime() - 30 * 86_400_000), to: now() });
      // pgr-services: min(366, days in the range) with a date range, 366 otherwise.
      const days = params.dateFrom && params.dateTo ? Math.min(366, Math.round((Date.parse(`${params.dateTo}T00:00:00Z`) - Date.parse(`${params.dateFrom}T00:00:00Z`)) / 86_400_000) + 1) : 366;
      const measure = (q as { measure?: string }).measure!;
      query = withWindow({ kind: "breakdown", dimension: tile.seriesDate, measure, limit: Math.max(2, days), sort: "asc", sortBy: "group", ...((q as { filters?: FilterClause[] }).filters ? { filters: (q as { filters: FilterClause[] }).filters } : {}) } as Query, w);
      const data = await run(query, { pack: opts.pack, connector: opts.connector, ctx: ctx() });
      if (data.error) return { error: "query_failed", message: data.error };
      const valueName = tile.columns.value;
      const rows = data.rows.map((r) => ({ [tile.seriesDate]: cell(tile.seriesDate, r.group), [valueName]: cell(valueName, r.value, measure) }));
      return { grain: tile.grain, columns: [tile.seriesDate, valueName], rows, rowCount: rows.length, tookMs: Date.now() - started };
    } else query = withWindow(q, windowFor(tile, params));
    const data = await run(query, { pack: opts.pack, connector: opts.connector, ctx: ctx() });
    if (data.error) return { error: "query_failed", message: data.error };
    void name;
    return toResult(tile, query, data, tile.grain, started, ignored);
  };

  const asOf = async () => {
    const d = await run({ kind: "value", measure: "facts_built_at" }, { pack: opts.pack, connector: opts.connector, ctx: ctx() }).catch(() => null);
    return d?.rows[0]?.value ?? now().getTime();
  };
  const envelope = async (scope: RowScope | null = null) => ({
    asOf: await asOf(),
    calendar: { timeZone: tz, businessDate: localDate(now(), tz) },
    scope: {
      tenantId: opts.tenant,
      level: opts.tenant.includes(".") ? "city" : "state",
      ...(scope?.restrictedTo ? { restrictedTo: scope.restrictedTo } : {}),
      ...(scope?.departments ? { departments: scope.departments } : {}),
      ...(scope?.jurisdictions ? { jurisdictions: scope.jurisdictions } : {}),
    },
  });

  const batch = async (queries: Record<string, Ref>, isPublic: boolean, caps: string[] | null, scope: RowScope | null) => {
    const names = Object.keys(queries);
    if (names.length > MAX_BATCH) throw Object.assign(new Error(`invalid_param: at most ${MAX_BATCH} queries per batch`), { status: 400 });
    const results: Record<string, unknown> = {};
    let partial = false;
    await Promise.all(
      names.map(async (n) => {
        const r = await runRef(n, queries[n]!, isPublic, caps, scope).catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          return { error: message.includes(":") ? message.split(":")[0]! : "query_failed", message };
        });
        if ("error" in r) partial = true;
        results[n] = r;
      }),
    );
    return { ...(await envelope(scope)), results, partial };
  };

  // CCRS's getBestPack: the first pack, in catalog order, the caller can see.
  // An employee needs the pack's requiredActionUrl; a pack with neither that
  // nor public is visible to no one.
  const packFor = (caps: string[] | null, isPublic: boolean) =>
    opts.boards.find((b) => (isPublic ? b.public : !!b.requiredActionUrl && (caps === null || caps.includes(b.requiredActionUrl))));

  const options = async () => {
    const distinct = async (dimension: string) => {
      const d = await run({ kind: "breakdown", dimension, measure: "complaints", limit: 300, sort: "desc" }, { pack: opts.pack, connector: opts.connector, ctx: ctx() });
      return { columns: [dimension], rows: d.rows.filter((r) => r.group && r.group !== "(none)").map((r) => ({ [dimension]: r.group })), rowCount: d.rows.length };
    };
    const [wards, complaintTypes] = await Promise.all([distinct("ward_code"), distinct("service_code")]);
    return { ...(await envelope()), results: { wards, complaintTypes }, partial: false };
  };

  /** Dispatch one API call. `path` is below the analytics base (e.g. "/public/packs"). */
  /** Dispatch one API call. `request` is passed through to the access and scope callbacks (e.g. the caller's headers). */
  return async function handle(path: string, body: Record<string, unknown>, request?: unknown): Promise<{ status: number; body: unknown }> {
    try {
      const isPublic = path.startsWith("/public/");
      const caps = isPublic ? null : opts.capabilities ? await opts.capabilities(body, request) : null;
      const tilesFor = (board: Board | undefined) => (board?.tiles ?? Object.keys(opts.skin.tiles)).map((k) => opts.skin.tiles[k]).filter((t): t is SkinTile => !!t && visible(t, caps, isPublic)).map(safeTile);
      switch (path) {
        case "/_access":
          return { status: 200, body: { allowed: caps === null || caps.includes(`${ACTION}/_access`) || caps.length > 0, capabilities: caps ?? [] } };
        case "/packs":
        case "/public/packs": {
          const board = packFor(caps, isPublic);
          const tiles = tilesFor(board);
          const ids = new Set(tiles.map((t) => t.kpiId));
          const layout = (board?.layout ?? []).filter((l) => ids.has(l.i)).map((l) => ({ kpiId: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
          return {
            status: 200,
            body: isPublic
              ? { enabled: true, tiles, defaultLayout: layout, asOf: await asOf(), packId: board?.id ?? null, maxBatchQueries: MAX_BATCH }
              : { tiles, defaultLayout: layout, asOf: await asOf(), packId: board?.id ?? null, persona: board?.requiredActionUrl?.split("/analytics/")[1] ?? null, recordCount: null, maxBatchQueries: MAX_BATCH },
          };
        }
        case "/catalog/_search":
        case "/public/catalog/_search": {
          const tiles = tilesFor(undefined);
          return { status: 200, body: { tiles, total: tiles.length } };
        }
        case "/public/_options":
          return { status: 200, body: await options() };
        case "/_query":
        case "/public/_query": {
          const queries = (body.queries as Record<string, Ref>) ?? (body.query ? { result: body.query as Ref } : {});
          const scope = isPublic || !opts.scope ? null : await opts.scope(body, request);
          return { status: 200, body: await batch(queries, isPublic, caps, scope) };
        }
        default:
          return { status: 404, body: { error: "not_found", message: `no analytics endpoint ${path}` } };
      }
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      const message = e instanceof Error ? e.message : String(e);
      return { status, body: { error: message.includes(":") ? message.split(":")[0] : "query_failed", message } };
    }
  };
}
