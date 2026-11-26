import { z } from "zod";

import { type BoardConfig, type BoardOp, type BoardStore, CHART_KINDS, type Filter, type Query, type Widget, layoutChanges, nearest, summarise, verifiedOnly } from "@lenspack/core";
import { type Connector, type Ctx, checkOps, explain, run, valuesQuery } from "@lenspack/engine";
import { shownConfig, showsStatement, visibleCatalogue } from "@lenspack/policy";
import { AGGS, FORMATS, type Pack, catalogueFrom } from "@lenspack/pack";

import { CHART, PAGE_SIZE, PATCH_SHAPE, PLACE, QUERY, QUERY_SHAPE, type QueryArgs, WIDGET_KINDS, WIDTH, assembleQuery, bool, given, num, oneOf, parseClear, patchQuery, str } from "./args";
import { type Proposal, type ProposalStore, memoryProposals } from "./proposals";

export type Tool<A extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  description: string;
  inputSchema: z.ZodObject<A>;
  execute(args: z.infer<z.ZodObject<A>>): Promise<unknown>;
};

/**
 * Keeps each tool's argument type inferred from its own schema while the collection stays a plain
 * Tool[]. A thrown error is returned, not raised: a raised one would end the turn, a returned one
 * lets the model retry.
 */
export function defineTool<A extends z.ZodRawShape>(t: Tool<A>): Tool {
  const execute = async (args: z.infer<z.ZodObject<A>>) => {
    try {
      return await t.execute(args);
    } catch (e) {
      const err = (e && typeof e === "object" ? e : {}) as { message?: string; code?: unknown; nearest?: string };
      return { ok: false, applied: false, error: err.message ?? String(e), ...(err.code && err.nearest ? { didYouMean: err.nearest } : {}) };
    }
  };
  return { ...t, execute } as unknown as Tool;
}

/** Raw SQL past the pack, for run_sql: what the model is told the tables are, and how a statement runs. */
export type RawSql = { describe: string; run(sql: string, opts: { timeoutMs?: number }): Promise<object> };

export type BoardToolsOptions = {
  pack: Pack;
  connector: Connector;
  store: BoardStore;
  boardId: string;
  ctx?: Ctx;
  /**
   * Off by default, and only offered with rawSql. Results are ephemeral and can never become a
   * widget. Raw SQL does not pass through the pack, so the tenant and row scope are not applied to
   * it: on a pack with tenant-scoped entities, or with a caller scope, it is refused unless the
   * database role itself limits what the connection can read ("role-scoped").
   */
  runSql?: boolean | "role-scoped";
  rawSql?: RawSql;
  proposals?: ProposalStore;
  timeoutMs?: number;
  /**
   * The caller may read this board but not change it. Every edit tool then answers with this
   * message instead of changing the board, so the model can say why (reading tools still work).
   */
  readOnly?: string;
  /**
   * The store holds edits back until the turn ends (a staged store, while a reviewer checks them),
   * so an applied edit is a draft: its result and onEdit say `held`, and its version is the number
   * it will have if it is saved, not one the board already has.
   */
  held?: boolean;
  /** Told of every edit a tool applied or refused (an audit log). Never throws into the tool. */
  onEdit?: (e: { outcome: "ok" | "refused"; ops: string[]; version?: number; held?: boolean; error?: string }) => void;
};

/** The shape the Vercel AI SDK's `tool()` accepts, keyed by name: spread it into `tools:`. */
export const toVercelAI = (tools: Tool[]) =>
  Object.fromEntries(tools.map((t) => [t.name, { description: t.description, inputSchema: t.inputSchema, execute: (args: unknown) => t.execute(args as never) }]));

/**
 * A chart widget from its kind and query. A heatmap's columns read in their own order (days,
 * codes) rather than ranked by the measure, and it is shaded on the sequential scale.
 */
function chartWidget(chart: (typeof CHART_KINDS)[number], title: string, query: Query) {
  if (chart === "heatmap") {
    const q = query.kind === "breakdown" && !query.sortBy ? { ...query, sortBy: "group" as const, sort: "asc" as const } : query;
    return { kind: "chart" as const, chart, title, query: q, options: { legend: true, colorScheme: "sequential" as const } };
  }
  return { kind: "chart" as const, chart, title, query, options: { legend: true, colorScheme: "default" as const } };
}

/**
 * A breakdown's counts in words: groups shown against the limit, and what records covers. Read
 * alone, the records behind a top 3 look like a fact about the whole data (how many records carry
 * the dimension at all); said this way, they cannot.
 */
function countsNote(query: Extract<Query, { kind: "breakdown" }>, shown: number, records: number) {
  const cut = shown >= query.limit;
  return `${shown} group${shown === 1 ? "" : "s"} shown${cut ? `, the top ${query.limit}: other groups may exist` : ", every group with records"}. records (${records}) counts only the records behind the groups shown, not the data's total; for a total, run a value query.`;
}

// Rows per page of a table. A table of rows reads one row past its first
// page with the board, so Prev/Next know whether another page exists.
export const DEFAULT_PAGE_SIZE = 25;
function tableOf(title: string, query: Query, pageSize: number, limitGiven: boolean) {
  const rows = query.kind === "rows" && !limitGiven ? { ...query, limit: Math.min(1000, Math.max(query.limit, pageSize + 1)) } : query;
  return { kind: "table" as const, title, query: rows, pageSize: Math.max(5, pageSize) };
}

const KEEPS_EMPTY = "A field left empty keeps that part; to remove filters, the time window, a split, further measures or compute steps, name them in clear.";

// What an update changed, named as the tool's own fields: what the model is told it did.
const QUERY_PARTS: Record<string, string> = { by: "split", time: "time window", measures: "further measures", orderBy: "order_by", sortBy: "sort_by" };
function widgetChanges(before: Widget, after: Widget): string[] {
  // Compared by content, whatever order an object's keys were written in.
  const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
  const differ = (a: Record<string, unknown>, b: Record<string, unknown>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => canon(a[k]) !== canon(b[k]));
  const { query: was, ...restBefore } = before as Widget & { query?: Record<string, unknown> };
  const { query: now, ...restAfter } = after as Widget & { query?: Record<string, unknown> };
  const out = differ(restBefore, restAfter).map((k) => (k === "pageSize" ? "page_size" : k));
  // A widget that gains or loses its query (to or from text) changed its query as a whole.
  if (!was || !now || was.kind !== now.kind) return canon(was) === canon(now) ? out : [...out, "query"];
  for (const k of differ(was, now)) out.push(`${QUERY_PARTS[k] ?? k}${now[k] === undefined ? " removed" : ""}`);
  return out;
}

const targetsOf = (applies: string) => {
  const ids = applies.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : ["*"];
};

/** A filter's default from the words given: values for a select, "3 months" / "30 days" for a date range. */
function defaultOf(type: Filter["type"], given: string): { default?: Filter["default"] } {
  if (!given.trim()) return {};
  if (type !== "daterange") return { default: { values: given.split(",").map((v) => v.trim()).filter(Boolean) } };
  const m = /^(?:last\s+)?(\d+)?\s*(day|week|month|quarter|year)s?$/i.exec(given.trim());
  if (!m) throw new Error(`Cannot read the date range "${given}": write it as "3 months" or "30 days"`);
  const n = Number(m[1] ?? 1);
  const unit = m[2]!.toLowerCase();
  return { default: unit === "day" ? { days: n } : unit === "week" ? { days: 7 * n } : { months: n * (unit === "quarter" ? 3 : unit === "year" ? 12 : 1) } };
}

/** The board filter a person or the model names: by its label or the dimension it is on (or its id). */
function filterNamed(filters: Filter[], name: string): Filter {
  const n = name.trim().toLowerCase();
  const found = [(f: Filter) => f.id.toLowerCase() === n, (f: Filter) => f.label.toLowerCase() === n, (f: Filter) => f.field.toLowerCase() === n].map((test) => filters.filter(test)).find((hits) => hits.length);
  if (found?.length === 1) return found[0]!;
  if (found) throw new Error(`Several filters match "${name}": ${found.map((f) => `“${f.label}” (${f.id})`).join(", ")}; name one by its id`);
  const near = nearest(name, filters.map((f) => f.label));
  throw new Error(filters.length ? `No filter called "${name}". The board's filters: ${filters.map((f) => `“${f.label}”`).join(", ")}${near ? `. Did you mean “${near}”?` : ""}` : `The board has no filters`);
}

// A board's original: the newest version its board file wrote, else the
// version it was created (or copied) as. Versions arrive newest first.
const baselineOf = <V extends { source: string; version: number }>(versions: V[]) =>
  versions.find((v) => v.source === "file") ?? versions.find((v) => v.source === "create") ?? versions.at(-1);

export function boardTools(opts: BoardToolsOptions): Tool[] {
  const { pack, store, boardId, connector } = opts;
  const scoped = Object.values(pack.entities).some((e) => e.tenant) || !!opts.ctx?.scope?.length;
  if (opts.runSql === true && scoped)
    throw new Error(
      `run_sql would read "${pack.pack}" past its tenant and row scope. Enable it as "role-scoped" only when the database role behind this connection already limits the rows it can read.`,
    );
  // Raw SQL does not pass through the pack, so it cannot keep a key from a caller either.
  if (opts.runSql && (opts.ctx?.hidden?.size || opts.ctx?.hiddenEntities?.size)) throw new Error(`run_sql would read "${pack.pack}" past the keys this caller may not use`);
  // What the model sees the compiled query called: SQL, or a search request. Shown only as the API would show it to this caller.
  const nativeKey = connector.kind === "postgres" || connector.kind === "duckdb" ? "sql" : "request";
  const ctx = opts.ctx ?? {};
  const statement = (text: string) => (showsStatement(ctx) ? { [nativeKey]: text } : {});
  // The board as this caller is shown it: the same view the board API sends them, so the model never reads a value they may not see.
  const shown = (config: BoardConfig) => summarise(shownConfig(config, ctx));
  // What the model may name: verified keys this caller may use.
  const catalogue = visibleCatalogue(verifiedOnly(catalogueFrom(pack)), ctx);
  const proposals = opts.proposals ?? memoryProposals();

  // Models call several edit tools in one step and the SDK runs them in
  // parallel; each patch reads the board, so unserialised they would race and
  // the last write would win. Edits queue per tool set instead, and a patch
  // passes a function so it reads the board inside the queue.
  let queue: Promise<unknown> = Promise.resolve();
  const told = (e: Parameters<NonNullable<BoardToolsOptions["onEdit"]>>[0]) => {
    try {
      opts.onEdit?.(e);
    } catch {
      /* an audit sink must not break an edit */
    }
  };
  const apply = (edit: BoardOp[] | (() => Promise<BoardOp[] | { applied: boolean; [k: string]: unknown }>)) => {
    if (opts.readOnly) {
      told({ outcome: "refused", ops: Array.isArray(edit) ? edit.map((o) => o.op) : [], error: "read-only" });
      return Promise.resolve({ applied: false as const, error: opts.readOnly, readOnly: true as const });
    }
    const work = async () => {
      const ops = Array.isArray(edit) ? edit : await edit();
      if (!Array.isArray(ops)) return ops;
      const names = ops.map((o) => o.op);
      // Refuse at edit time what the compiler would refuse at render time.
      const checked = checkOps(ops, pack, { ctx, capabilities: connector.capabilities });
      if (!checked.ok) {
        told({ outcome: "refused", ops: names, error: checked.error });
        return { applied: false, error: checked.error, ...(checked.hint ? { didYouMean: checked.hint } : {}) };
      }
      const layoutEdit = ops.some((op) => op.op === "move_widget" || op.op === "resize_widget" || op.op === "remove_widget");
      const before = layoutEdit ? (await store.get(boardId))?.config : undefined;
      const result = await store.patch({ id: boardId, ops, catalogue, source: "chat" });
      if (!result.ok) {
        told({ outcome: "refused", ops: names, error: result.error });
        return { applied: false, error: result.error, ...(result.hint ? { didYouMean: result.hint } : {}) };
      }
      const held = opts.held ? { held: true as const } : {};
      told({ outcome: "ok", ops: names, version: result.board.version, ...held });
      // What the edit did besides what was asked (room made, a widget widened), so the model can say so.
      const layout = before ? layoutChanges(before, result.board.config, ops) : [];
      return { applied: true, version: result.board.version, ...held, ...(layout.length ? { layout: layout.join("; ") } : {}), board: shown(result.board.config) };
    };
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  // Reads wait for the edits already asked for: a get_board run beside a move_widget would
  // otherwise show the board one edit behind that edit's own result.
  const afterEdits = <T>(read: () => Promise<T>): Promise<T> => queue.then(read, read);

  // A missing value is grouped as "(none)", which no filter can match, so it is never offered.
  const values = async (dimension: string, q = "", limit = 50, exact?: string[]) => {
    const query = valuesQuery(dimension, pack, limit, q, ctx.hidden);
    if (!query) return null;
    const data = await run(exact ? { ...query, filters: [{ dimension, op: "in", value: exact }] } : query, { pack, connector, ctx, timeoutMs: opts.timeoutMs });
    return { ...data, rows: data.rows.filter((r) => r.group !== "(none)") };
  };
  const groups = async (dimension: string, q = "", exact?: string[]) => ((await values(dimension, q, 50, exact))?.rows ?? []).map((r) => r.group);

  // A guessed value (the wrong case, a near spelling) returns nothing rather
  // than an error. Only when a result is empty, name the value the data has.
  async function closestValues(query: Query) {
    const fixed: string[] = [];
    for (const f of query.filters ?? []) {
      const type = pack.dimensions.find((d) => d.key === f.dimension)?.type;
      if ((f.op !== "eq" && f.op !== "in") || (type !== "string" && type !== "enum")) continue;
      const wanted = (Array.isArray(f.value) ? f.value : [f.value]).map(String);
      // Looked up exactly, not in the top values: a rare value is still present.
      const present = await groups(f.dimension, "", wanted);
      let top: string[] | null = null;
      const near: string[] = [];
      for (const v of wanted) {
        const hit = present.includes(v) ? v : (await groups(f.dimension, v)).find((x) => x.toLowerCase() === v.toLowerCase());
        near.push(hit ?? nearest(v, (top ??= await groups(f.dimension))) ?? v);
      }
      if (near.some((v, i) => v !== wanted[i])) fixed.push(`${f.dimension} ${f.op === "in" ? "in" : "="} ${near.join(", ")}`);
    }
    return fixed.join("; ");
  }

  const tools: Tool[] = [
    defineTool({
      name: "list_metrics",
      description: "The dimensions, measures and entities this pack has, with what each means. Only these keys can be queried or put on the board — never invent one. Pass q to narrow by name, label or synonym.",
      inputSchema: z.object({ q: z.string().default("").describe("Optional search text") }),
      async execute({ q }) {
        const needle = q.trim().toLowerCase();
        const matches = (x: { key: string; label: string; synonyms?: string[]; hint?: string }) =>
          !needle || [x.key, x.label, ...(x.synonyms ?? []), x.hint ?? ""].some((s) => s.toLowerCase().includes(needle));
        return {
          pack: `${pack.pack} v${pack.version}`,
          entities: catalogue.entities.map((e) => ({ key: e.key, grain: e.grain, hasTime: e.hasTime, ...(e.hasLocation ? { hasLocation: true } : {}) })),
          dimensions: catalogue.dimensions.filter(matches).map((d) => ({ key: d.key, label: d.label, entity: d.entity, type: d.type, ...(d.hint ? { hint: d.hint } : {}) })),
          measures: catalogue.measures.filter(matches).map((m) => ({ key: m.key, label: m.label, entity: m.entity, format: m.format, ...(m.hint ? { hint: m.hint } : {}) })),
          note: "A measure is computed at its entity's grain. A dimension on another entity works only through a many-to-one join; otherwise the query is refused rather than multiplied.",
        };
      },
    }),
    defineTool({
      name: "query",
      description:
        "Run one query against the pack and return its rows plus the native query that ran. Use this to answer questions or to check a widget before adding it. Each row's value is the measure (or, with compute, the computed number named in computed); its count is the number of records in that group. records is how many records lie behind the rows shown: it is not the measure's total, and a breakdown with a limit shows only its top groups. For the measure over everything, run a value query.",
      inputSchema: QUERY,
      async execute(a) {
        const query = assembleQuery(a, pack);
        const data = await run(query, { pack, connector, ctx, timeoutMs: opts.timeoutMs });
        if (data.error) return { ok: false, error: data.error, ...(data.hint ? { didYouMean: data.hint } : {}) };
        const { text } = await explain(query, { pack, connector, ctx });
        const closest = data.total === 0 ? await closestValues(query) : "";
        return {
          ok: true,
          query,
          ...(closest ? { didYouMean: closest } : {}),
          // What the numbers are when they were computed after the source answered, and how zeros and gaps were treated.
          ...(data.computed ? { computed: data.computed } : {}),
          rows: data.records ?? data.rows,
          // Records behind the rows shown, not the measure's total: named so a model cannot read it as one.
          records: data.total,
          ...(query.kind === "breakdown" ? { counts: countsNote(query, data.rows.filter((r) => !r.other).length, data.total) } : {}),
          format: data.format,
          compare: data.compare,
          ...(data.approximate ? { approximate: true } : {}),
          ...(data.notes ? { notes: data.notes } : {}),
          ...statement(text),
        };
      },
    }),
    defineTool({
      name: "explain",
      description: "Compile a query without running it: the native query, the entities used, and the tenant scope. Cheap; use it to debug a refusal.",
      inputSchema: QUERY,
      async execute(a) {
        const query = assembleQuery(a, pack);
        const c = await explain(query, { pack, connector, ctx });
        return { ok: true, query, ...statement(c.text), root: c.root, entities: c.entities, tenant: c.tenant, ...(c.approximate ? { approximate: true } : {}) };
      },
    }),
    defineTool({
      name: "list_values",
      description: "A dimension's most common values with their row counts.",
      inputSchema: z.object({
        dimension: z.string().describe("The dimension key"),
        q: str().describe("Optional: only values containing this text, any case"),
        limit: num(20, 2, 50).describe("How many values, at most 50"),
      }),
      async execute({ dimension, q, limit }) {
        const data = await values(dimension, q.trim(), limit);
        if (!data) return { ok: false, error: `"${pack.pack}" has no count measure to list values with` };
        if (data.error) return { ok: false, error: data.error, ...(data.hint ? { didYouMean: data.hint } : {}) };
        return { ok: true, dimension, values: data.rows.map((r) => ({ value: r.group, count: r.count })) };
      },
    }),
    defineTool({
      name: "get_board",
      description: "Read what is currently on the board: widgets, their ids, and how they are arranged by row. Call this before editing so you refer to widgets by the ids they actually have.",
      inputSchema: z.object({}),
      async execute() {
        const board = await afterEdits(() => store.get(boardId));
        if (!board) return { error: "This board no longer exists" };
        return { board: shown(board.config), version: board.version };
      },
    }),
    defineTool({
      name: "list_versions",
      description:
        "The board's saved versions, newest first: number, who or what made it (chat, by hand, board file, rollback) and what changed. Call this before restore_version when the user names a point in the history rather than the original.",
      inputSchema: z.object({ limit: num(20, 1, 100).describe("How many versions, newest first (default 20)") }),
      async execute({ limit }) {
        const all = await afterEdits(() => store.versions(boardId));
        if (all.length === 0) return { error: "This board has no history" };
        const base = baselineOf(all);
        return {
          current: all[0]!.version,
          baseline: base?.version ?? null,
          versions: all.slice(0, limit).map((v) => ({ version: v.version, source: v.source, summary: v.summary, at: new Date(v.createdAt).toISOString() })),
        };
      },
    }),
    defineTool({
      name: "restore_version",
      description:
        'Put the board back as it was at an earlier version. to: "baseline" restores the original (as its board file defines it, or as it was when this copy was made) and undoes every later change; a number restores that version. Nothing is lost: the restore is saved as a new version, so it can itself be undone.',
      inputSchema: z.object({ to: str("baseline").describe('"baseline", or a version number from list_versions') }),
      execute: ({ to }) =>
        // Queued with the edits, so a restore never interleaves with a patch.
        apply(async () => {
          const all = await store.versions(boardId);
          const wanted = to.trim().toLowerCase();
          const target = /^(baseline|original|default|reset|start)$/.test(wanted) ? baselineOf(all) : all.find((v) => v.version === Number(wanted.replace(/^v/, "")));
          if (!target) throw new Error(`No version "${to}". Versions run from ${all.at(-1)?.version ?? 1} to ${all[0]?.version ?? 1}; call list_versions.`);
          const before = all[0]?.version;
          const board = await store.revertTo(boardId, target.version);
          if (!board) throw new Error(`Version ${target.version} could not be restored`);
          return { applied: true as const, restored: target.version, version: board.version, unchanged: board.version === before, board: shown(board.config) };
        }),
    }),
    defineTool({
      name: "add_widget",
      description:
        'Put something new on the board. Use chart for a breakdown or series, kpi for a single headline number, table for a list, text for a note. A heatmap chart shades one measure over two dimensions: "ward by day" is a series with grain day and dimension ward (rows), or a breakdown with dimension as the columns and split as the rows. Give a heatmap full width. A map chart draws a points query: the records of an entity with a location (list_metrics marks them), coloured by a dimension and sized by a measure, e.g. "facilities by zero-dose band" is query_kind points, entity facility, dimension the band, label the facility name. Give a map half or full width.',
      inputSchema: z.object({
        id: z.string().describe("Short lowercase id, e.g. revenue_by_country"),
        kind: z.enum(WIDGET_KINDS),
        title: z.string().describe("What the reader sees above it"),
        chart: CHART.describe("Only when kind is chart"),
        body: str().describe("Only when kind is text: the note itself, in markdown (paragraphs, **bold**, *italics*, - lists, [links](https://...)); up to 2000 characters"),
        ...QUERY_SHAPE,
        place: PLACE,
        width: WIDTH,
        height: num(0, 0, 20).describe("Rows tall; 0 lets the server choose"),
        page_size: PAGE_SIZE,
      }),
      async execute(a) {
        const widget =
          a.kind === "text"
            ? { kind: "text" as const, title: a.title, body: a.body }
            : a.kind === "kpi"
              ? { kind: "kpi" as const, title: a.title, query: assembleQuery(a, pack) }
              : a.kind === "table"
                ? tableOf(a.title, assembleQuery(a, pack), a.page_size || DEFAULT_PAGE_SIZE, a.limit > 0)
                : chartWidget(a.chart, a.title, assembleQuery(a, pack));
        return apply([{ op: "add_widget", id: a.id, widget, placement: { place: a.place, width: a.width, ...(a.height > 0 ? { height: a.height } : {}) } }]);
      },
    }),
    defineTool({
      name: "update_widget",
      description:
        'Change a widget in place: its id plus only the fields that change; a field left empty keeps that part as it is. To take a part off its query, name it in clear: clear "filters, time" shows every record over all time. A different query_kind starts a new query from the fields given. The result says in changed what actually changed.',
      inputSchema: z.object({
        id: z.string(),
        kind: given(z.enum(WIDGET_KINDS)).describe("Only to change it"),
        title: given(z.string()),
        chart: given(z.enum(CHART_KINDS)),
        body: given(z.string()).describe("Only for text: the note, in markdown"),
        page_size: given(PAGE_SIZE),
        ...PATCH_SHAPE,
        clear: str().describe("Optional, comma-separated: parts of the query to remove: filters, time (the time window, back to all time), split, measures (the further ones), compute"),
      }),
      async execute({ id, kind, title, chart, body, page_size, clear: clearing, ...fields }) {
        const changed = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<QueryArgs>;
        const clear = parseClear(clearing);
        let did: string[] = [];
        const result = await apply(async () => {
          const widgets = (await store.get(boardId))?.config.widgets ?? {};
          const current = widgets[id];
          if (!current) {
            const near = nearest(id, Object.keys(widgets));
            return { applied: false, error: `No widget called "${id}"`, ...(near ? { didYouMean: near } : {}) };
          }
          // A chart type alone ("make it a pie") means a chart.
          const to = kind ?? (chart ? "chart" : current.kind);
          const name = title ?? current.title;
          let widget: Widget;
          if (to === "text") {
            const text = body ?? (current.kind === "text" ? current.body : undefined);
            if (text === undefined) return { applied: false, error: "A text widget needs body" };
            widget = { kind: "text", title: name, body: text };
          } else {
            if (current.kind === "text" && !changed.query_kind) return { applied: false, error: `A ${to} needs a query: give query_kind and its fields` };
            const query = patchQuery(current.kind === "text" ? undefined : current.query, changed, pack, clear);
            widget =
              to === "kpi"
                ? { ...(current.kind === "kpi" ? current : {}), kind: "kpi" as const, title: name, query }
                : to === "table"
                  ? tableOf(name, query, page_size || (current.kind === "table" ? current.pageSize : DEFAULT_PAGE_SIZE), !page_size || !!changed.limit)
                  : (() => {
                      const kindNow = chart ?? (current.kind === "chart" ? current.chart : "bar");
                      const fresh = chartWidget(kindNow, name, query);
                      // Options carry over, except across the heatmap line (its scale is sequential).
                      return { ...fresh, ...(current.kind === "chart" && (current.chart === "heatmap") === (kindNow === "heatmap") ? { options: current.options } : {}) };
                    })();
          }
          did = widgetChanges(current, widget);
          // Never "applied" for an update that changed nothing: the model would tell the user it did.
          if (!did.length) return { applied: false, unchanged: true, error: `That leaves "${id}" as it was. ${KEEPS_EMPTY}` };
          return [{ op: "update_widget", id, widget }];
        });
        if (!result.applied) return result;
        // A part given as an empty word ("none") is kept, not removed: said, so the model does not claim otherwise.
        const parts = { filters: "filters", time_last: "time", split: "split", measures: "measures" } as const;
        const kept = (Object.keys(parts) as (keyof typeof parts)[]).filter((k) => changed[k] === "" && !clear.includes(parts[k]));
        return { ...result, changed: did.join(", "), ...(kept.length ? { note: `${kept.join(", ")} given empty, so kept as it was. ${KEEPS_EMPTY}` } : {}) };
      },
    }),
    defineTool({
      name: "move_widget",
      description: "Move a widget somewhere else on the board.",
      inputSchema: z.object({ id: z.string(), place: PLACE, width: WIDTH }),
      // Resize first, so the move looks for room at the width asked for.
      execute: ({ id, place, width }) => apply([{ op: "resize_widget", id, width }, { op: "move_widget", id, placement: { place, width } }]),
    }),
    defineTool({
      name: "resize_widget",
      description: "Make a widget wider, narrower, taller or shorter.",
      inputSchema: z.object({ id: z.string(), width: WIDTH, height: num(0, 0, 20).describe("Rows tall; 0 leaves the height alone") }),
      execute: ({ id, width, height }) => apply([{ op: "resize_widget", id, width, ...(height > 0 ? { height } : {}) }]),
    }),
    defineTool({
      name: "remove_widget",
      description: "Take a widget off the board. Say what you are removing before you do it.",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => apply([{ op: "remove_widget", id }]),
    }),
    defineTool({
      name: "add_filter",
      description: 'Add a control to the board\'s filter bar: one that narrows it to values of a dimension, or, with field "time", a date range.',
      inputSchema: z.object({
        field: z.string().describe('The dimension key, or "time" for a date range'),
        label: str().describe("What the control is called; defaults to the dimension's label"),
        applies: str("*").describe('"*" for every widget, or widget ids separated by commas'),
        default: str().describe('Optional: what it is set to before anyone picks: values separated by commas (exactly as the data has them), or for a date range "3 months" / "30 days"'),
      }),
      execute: ({ field, label, applies, default: given }) => {
        const dim = catalogue.dimensions.find((d) => d.key === field);
        const type = field === "time" ? "daterange" : "select";
        const filter = { id: `filter_${field}`, type, label: label.trim() || dim?.label || (field === "time" ? "Dates" : field), field, applies: targetsOf(applies) } as const;
        return apply([{ op: "add_filter", filter: { ...filter, ...defaultOf(type, given) } }]);
      },
    }),
    defineTool({
      name: "update_filter",
      description: "Change a filter on the board: its label, the widgets it applies to, or what it is set to by default. Name it as the board shows it.",
      inputSchema: z.object({
        filter: z.string().describe("The filter's label, or the dimension it is on"),
        label: str().describe("A new label; empty keeps it"),
        applies: str().describe('"*" for every widget, or widget ids separated by commas; empty keeps it'),
        default: str().describe('Values separated by commas, or for a date range "3 months" / "30 days"; "clear" removes the default; empty keeps it'),
      }),
      execute: ({ filter: name, label, applies, default: given }) =>
        apply(async () => {
          const f = filterNamed((await store.get(boardId))?.config.filters ?? [], name);
          const { default: _old, ...rest } = f;
          const def = given.trim().toLowerCase() === "clear" ? {} : given.trim() ? defaultOf(f.type, given) : f.default ? { default: f.default } : {};
          return [{ op: "update_filter", id: f.id, filter: { ...rest, ...(label.trim() ? { label: label.trim() } : {}), ...(applies.trim() ? { applies: targetsOf(applies) } : {}), ...def } }];
        }),
    }),
    defineTool({
      name: "remove_filter",
      description: "Take a filter off the board, including one the board keeps as its host has it. Name it as the board shows it.",
      inputSchema: z.object({ filter: z.string().describe("The filter's label, or the dimension it is on") }),
      execute: ({ filter: name }) => apply(async () => [{ op: "remove_filter", id: filterNamed((await store.get(boardId))?.config.filters ?? [], name).id }]),
    }),
    defineTool({
      name: "set_layout_mode",
      description: 'How the board uses space. density "compact" tightens gutters and row height; fill true packs each row (gaps closed, last widget widened to the edge) now and on every later edit. Use for "make it compact", "pack it", "tighter", "use less space".',
      inputSchema: z.object({
        density: oneOf(["comfortable", "compact"], "").describe("comfortable or compact; empty leaves it"),
        fill: bool(undefined).describe("true to pack rows, false to stop packing; omit to leave it"),
      }),
      execute: ({ density, fill }) => apply([{ op: "set_layout_mode", ...(density ? { density } : {}), ...(fill === undefined ? {} : { fill }) }]),
    }),
    defineTool({
      name: "rename_board",
      description: "Change the board's title.",
      inputSchema: z.object({ title: z.string() }),
      execute: ({ title }) => apply([{ op: "set_title", title }]),
    }),
    defineTool({
      name: "propose_measure",
      description: "Draft a new measure for a human to review. It is NOT added to the pack and cannot be queried until someone verifies it by editing the pack file. Use this when list_metrics has nothing that answers the question.",
      inputSchema: z.object({
        key: z.string().regex(/^[a-z][a-z0-9_]*$/),
        entity: z.string(),
        agg: z.enum(AGGS),
        sql: z.string().describe("Row-level SQL expression over the entity's columns"),
        filter: z.string().default("").describe("Optional row predicate"),
        format: z.enum(FORMATS).default("number"),
        label: z.string().default(""),
        rationale: z.string().describe("Why this measure is needed and what it means"),
      }),
      async execute(a) {
        if (!pack.entities[a.entity]) return { ok: false, error: `"${a.entity}" is not an entity in this pack` };
        const proposal: Proposal = { ...a, filter: a.filter || undefined, label: a.label || undefined, verified: false, proposedAt: new Date().toISOString() };
        await proposals.add(proposal);
        return { ok: true, proposal, next: "A maintainer reviews this and adds it to the pack with verified: true." };
      },
    }),
  ];

  const raw = opts.rawSql;
  if (opts.runSql && raw)
    tools.push(
      defineTool({
        name: "run_sql",
        description: `Read-only SQL for a question the pack cannot express. One SELECT or WITH statement, capped rows, timeboxed. Results are for answering, never for widgets: if the answer is worth keeping, propose_measure it. Tables:\n${raw.describe}`,
        inputSchema: z.object({ sql: z.string() }),
        execute: async ({ sql }) => ({ ok: true, ...(await raw.run(sql, { timeoutMs: opts.timeoutMs })) }),
      }),
    );

  return tools;
}
