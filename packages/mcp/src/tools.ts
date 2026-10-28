import { z } from "zod";

import { type BoardOp, type BoardStore, type FilterClause, type Query, nearest, querySchema, summarise, verifiedOnly } from "@lenspack/core";
import { AGGS, FORMATS, type Pack, catalogueFrom } from "@lenspack/spec";
import { type Connector, type Ctx, type Executor, checkOps, describeSources, explain, run, runSql, sqlConnector, valuesQuery } from "@lenspack/sql";

import { type Proposal, type ProposalStore, memoryProposals } from "./proposals";

// Every input is a flat scalar and the op is assembled here. Weaker models
// corrupt nested tool arguments, so a tool that asked for a widget object
// would fail on roughly every call. Assembling server-side costs a few more
// parameters and removes the failure.

export type Tool<A extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  description: string;
  inputSchema: z.ZodObject<A>;
  execute(args: z.infer<z.ZodObject<A>>): Promise<unknown>;
};

// Keeps each tool's argument type inferred from its own schema while the
// collection stays a plain Tool[].
function defineTool<A extends z.ZodRawShape>(t: Tool<A>): Tool {
  return t as unknown as Tool;
}

export type BoardToolsOptions = {
  pack: Pack;
  /** The backend. A bare SQL executor is accepted and wrapped. */
  connector?: Connector;
  executor?: Executor;
  store: BoardStore;
  boardId: string;
  ctx?: Ctx;
  /**
   * Off by default. Results are ephemeral and can never become a widget.
   * Raw SQL does not pass through the pack, so the tenant and row scope are
   * not applied to it: on a pack with tenant-scoped entities, or with a
   * caller scope, it is refused unless the database role itself limits what
   * the connection can read ("role-scoped").
   */
  runSql?: boolean | "role-scoped";
  proposals?: ProposalStore;
  timeoutMs?: number;
};

// Lenient scalars: a null, a numeric string or a "true" from a weaker model
// is an argument to accept and coerce, not a reason to end the turn.
const str = (fallback = "") => z.string().nullish().transform((v) => v ?? fallback);
const num = (fallback: number, min: number, max: number) =>
  z
    .union([z.number(), z.string(), z.null(), z.undefined()])
    .transform((v) => (v === null || v === undefined || v === "" ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));
const bool = (fallback = false) =>
  z.union([z.boolean(), z.string(), z.null(), z.undefined()]).transform((v) => (v === null || v === undefined || v === "" ? fallback : v === true || v === "true"));
const oneOf = <T extends [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.union([z.enum(values), z.null(), z.undefined(), z.literal("")]).transform((v) => (v ? v : fallback) as T[number]);

const PLACE = str("bottom").describe('Where to put it: "top", "bottom", or "after:<widgetId>"');
const WIDTH = oneOf(["full", "half", "third", "quarter"], "half").describe("full is the whole row, half is two across, third is three across, quarter is four across");
const QUERY_SHAPE = {
  query_kind: z.enum(["breakdown", "series", "value", "rows"]).describe("breakdown = a measure per group; series = a measure over time; value = one number; rows = a list of records"),
  measure: str().describe("Measure key from list_metrics (not for rows)"),
  measures: str().describe("Optional, comma-separated: further measures over the same groups, as extra table columns or chart series (not with a split series)"),
  dimension: str().describe("For breakdown: the dimension to group by. For series: optional split. For rows: comma-separated columns"),
  entity: str().describe("For rows: the entity to list"),
  grain: oneOf(["hour", "day", "week", "month", "quarter", "year"], "day").describe("For series"),
  time_last: str().describe('Relative window like "30d", "12w", "6m". Always set it when the request names a period ("last 10 weeks" -> "10w", "past month" -> "30d"); empty means all time. For a named calendar period use time_from and time_to instead'),
  time_from: str().describe('Absolute start, ISO 8601 with offset, e.g. "2026-09-01T00:00:00Z" (inclusive); use with time_to, not with time_last'),
  time_to: str().describe('Absolute end, ISO 8601 with offset (exclusive), e.g. "2026-10-01T00:00:00Z" for all of September'),
  compare: bool(false).describe("For value: also compute the previous period"),
  limit: num(0, 0, 500).describe("Max groups or rows; 0 for the default"),
  sort: oneOf(["asc", "desc"], "desc").describe('For breakdown: "desc" = largest first (default), "asc" = smallest first ("lowest first", "bottom N")'),
  split: str().describe("For breakdown: a second dimension within each group, drawn as stacked bars"),
  filters: str().describe('Optional: clauses separated by ";", e.g. "channel = web; language in en, fr; status != failed; size >= 18". Ops: =, !=, >=, <=, in (comma-separated), contains, between <a> and <b>. Values must match exactly: check them with list_values'),
  filter_dimension: str().describe("Optional: narrow by this dimension"),
  filter_value: str().describe("Optional: the value the filter dimension must equal"),
};

type QueryArgs = { [K in keyof typeof QUERY_SHAPE]: z.infer<(typeof QUERY_SHAPE)[K]> };

const OPS = { "=": "eq", "!=": "neq", ">=": "gte", "<=": "lte", in: "in", contains: "contains", between: "between" } as const;
const CLAUSE = /^([a-z][a-z0-9_]*)\s*(?:(!=|>=|<=|=)|\s(in|contains|between)\s)\s*(.+)$/i;
const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

// Nested filter objects are what weaker models corrupt, so filters arrive as
// one string in a small closed grammar and become IR clauses here.
function parseFilters(text: string, pack: Pack): FilterClause[] {
  return text
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((clause) => {
      const m = CLAUSE.exec(clause);
      if (!m) throw new Error(`Cannot read the filter "${clause}": write <dimension> <op> <value>, op one of =, !=, >=, <=, in, contains, between <a> and <b>`);
      const dimension = m[1]!;
      const op = OPS[(m[2] ?? m[3]!.toLowerCase()) as keyof typeof OPS];
      const values = (op === "in" ? m[4]!.split(",") : op === "between" ? m[4]!.split(/\s+and\s+/i) : [m[4]!]).map(unquote).filter(Boolean);
      if (op === "between" ? values.length !== 2 : !values.length) throw new Error(`Cannot read the filter "${clause}": ${op === "between" ? "between needs <a> and <b>" : "it has no value"}`);
      const typed = op === "contains" ? values : values.map((v) => typedValue(pack, dimension, v, clause));
      return { dimension, op, value: op === "in" || op === "between" ? typed : typed[0]! };
    });
}

// A value is typed by its dimension: "18" is a number on a number dimension
// and stays a string on a code.
function typedValue(pack: Pack, dimension: string, v: string, clause: string) {
  const type = pack.dimensions.find((d) => d.key === dimension)?.type;
  if (type === "number") {
    if (!v.trim() || !Number.isFinite(Number(v))) throw new Error(`Cannot read the filter "${clause}": ${dimension} is a number, "${v}" is not`);
    return Number(v);
  }
  if (type === "boolean") {
    if (!/^(true|false)$/i.test(v)) throw new Error(`Cannot read the filter "${clause}": ${dimension} is true or false, "${v}" is neither`);
    return v.toLowerCase() === "true";
  }
  return v;
}

export function assembleQuery(a: QueryArgs, pack: Pack): Query {
  if (Boolean(a.time_from) !== Boolean(a.time_to)) throw new Error("time_from and time_to go together: give both, or use time_last");
  const clauses = parseFilters(a.filters, pack);
  if (a.filter_dimension) clauses.push({ dimension: a.filter_dimension, op: "eq", value: typedValue(pack, a.filter_dimension, a.filter_value, `${a.filter_dimension} = ${a.filter_value}`) });
  const filters = clauses.length ? clauses : undefined;
  const time = a.time_from && a.time_to ? { from: a.time_from, to: a.time_to } : a.time_last ? { last: a.time_last } : undefined;
  const more = a.measures.split(",").map((s) => s.trim()).filter((s) => s && s !== a.measure);
  const base = { ...(filters ? { filters } : {}), ...(time ? { time } : {}), ...(more.length && a.query_kind !== "rows" ? { measures: more } : {}) };
  switch (a.query_kind) {
    case "breakdown":
      return querySchema.parse({ kind: "breakdown", dimension: a.dimension, measure: a.measure, sort: a.sort, ...(a.split ? { by: a.split } : {}), ...(a.limit ? { limit: a.limit } : {}), ...base });
    case "series":
      return querySchema.parse({ kind: "series", measure: a.measure, grain: a.grain, ...(a.split || a.dimension ? { by: a.split || a.dimension } : {}), ...base });
    case "value":
      return querySchema.parse({ kind: "value", measure: a.measure, ...(a.compare ? { compare: "previous_period" } : {}), ...base });
    case "rows":
      return querySchema.parse({
        kind: "rows",
        entity: a.entity,
        columns: a.dimension.split(",").map((s) => s.trim()).filter(Boolean),
        ...(a.limit ? { limit: a.limit } : {}),
        ...base,
      });
  }
}

// In a patch an omitted, null or empty field means "leave it", so none of
// them falls back to a default the way a new widget's fields do.
const given = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === null || v === "" ? undefined : v), s.optional());
const PATCH_SHAPE = Object.fromEntries(Object.entries(QUERY_SHAPE).map(([k, s]) => [k, given(s)])) as {
  [K in keyof typeof QUERY_SHAPE]: z.ZodEffects<z.ZodOptional<(typeof QUERY_SHAPE)[K]>, z.infer<(typeof QUERY_SHAPE)[K]> | undefined, unknown>;
};

// The scalars a stored query is rebuilt from. The rest (time, filters,
// further measures, a breakdown's split, sortBy, orderBy) carries over from
// the query itself unless the patch names it.
function scalarsOf(q: Query) {
  switch (q.kind) {
    case "breakdown":
      return { query_kind: q.kind, measure: q.measure, dimension: q.dimension, sort: q.sort };
    case "series":
      return { query_kind: q.kind, measure: q.measure, grain: q.grain, dimension: q.by };
    case "value":
      return { query_kind: q.kind, measure: q.measure, compare: !!q.compare };
    case "rows":
      return { query_kind: q.kind, entity: q.entity, dimension: q.columns.join(",") };
  }
}

function patchQuery(current: Query, changed: Partial<QueryArgs>, pack: Pack): Query {
  if (Object.keys(changed).length === 0) return current;
  if (changed.query_kind && changed.query_kind !== current.kind) return assembleQuery(z.object(QUERY_SHAPE).parse(changed), pack);
  const next = assembleQuery(z.object(QUERY_SHAPE).parse({ ...scalarsOf(current), ...changed }), pack);
  // The rebuilt query has the default limit unless one was given, and compare
  // only when it is still asked for, so a patch can turn it off.
  return querySchema.parse({ ...current, compare: undefined, ...next, ...("limit" in current && !changed.limit ? { limit: current.limit } : {}) });
}

function fail(e: unknown) {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const err = e as { message: string; nearest?: string };
    return { applied: false, error: err.message, ...(err.nearest ? { didYouMean: err.nearest } : {}) };
  }
  return { applied: false, error: e instanceof Error ? e.message : String(e) };
}

export function boardTools(opts: BoardToolsOptions): Tool[] {
  const { pack, store, boardId } = opts;
  const scoped = Object.values(pack.entities).some((e) => e.tenant) || !!opts.ctx?.scope?.length;
  if (opts.runSql === true && scoped)
    throw new Error(
      `run_sql would read "${pack.pack}" past its tenant and row scope. Enable it as "role-scoped" only when the database role behind this connection already limits the rows it can read.`,
    );
  const connector = opts.connector ?? (opts.executor ? sqlConnector(opts.executor) : null);
  if (!connector) throw new Error("boardTools needs a connector (or a SQL executor)");
  const executor = opts.executor ?? (connector as { executor?: Executor }).executor;
  // What the model sees the compiled query called: SQL, or a search request.
  const nativeKey = connector.kind === "postgres" || connector.kind === "duckdb" ? "sql" : "request";
  const catalogue = verifiedOnly(catalogueFrom(pack));
  const ctx = opts.ctx ?? {};
  const proposals = opts.proposals ?? memoryProposals();

  // Models call several edit tools in one step and the SDK runs them in
  // parallel; each patch reads the board, so unserialised they would race and
  // the last write would win. Edits queue per tool set instead, and a patch
  // passes a function so it reads the board inside the queue.
  let queue: Promise<unknown> = Promise.resolve();
  const apply = (edit: BoardOp[] | (() => Promise<BoardOp[] | ReturnType<typeof fail>>)) => {
    const work = async () => {
      const ops = Array.isArray(edit) ? edit : await edit();
      if (!Array.isArray(ops)) return ops;
      // Refuse at edit time what the compiler would refuse at render time.
      const checked = checkOps(ops, pack, { ctx, capabilities: connector.capabilities });
      if (!checked.ok) return { applied: false, error: checked.error, ...(checked.hint ? { didYouMean: checked.hint } : {}) };
      const result = await store.patch({ id: boardId, ops, catalogue, source: "chat" });
      if (!result.ok) return { applied: false, error: result.error, ...(result.hint ? { didYouMean: result.hint } : {}) };
      return { applied: true, version: result.board.version, board: summarise(result.board.config) };
    };
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const values = async (dimension: string, q = "", limit = 50) => {
    const query = valuesQuery(dimension, pack, limit, q);
    return query ? run(query, { pack, connector, ctx, timeoutMs: opts.timeoutMs }) : null;
  };

  // A guessed value (the wrong case, a near spelling) returns nothing rather
  // than an error. Only when a result is empty, name the value the data has.
  async function closestValues(query: Query) {
    const fixed: string[] = [];
    for (const f of query.filters ?? []) {
      const type = pack.dimensions.find((d) => d.key === f.dimension)?.type;
      if ((f.op !== "eq" && f.op !== "in") || (type !== "string" && type !== "enum")) continue;
      const wanted = (Array.isArray(f.value) ? f.value : [f.value]).map(String);
      let top: string[] | null = null;
      const near: string[] = [];
      for (const v of wanted) {
        // Searched for, not looked up in the top values: a rare value is still found.
        const like = ((await values(f.dimension, v))?.rows ?? []).map((r) => r.group);
        const hit = like.includes(v) ? v : like.find((x) => x.toLowerCase() === v.toLowerCase());
        near.push(hit ?? nearest(v, (top ??= ((await values(f.dimension))?.rows ?? []).map((r) => r.group))) ?? v);
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
          entities: catalogue.entities.map((e) => ({ key: e.key, grain: e.grain, hasTime: e.hasTime })),
          dimensions: catalogue.dimensions.filter(matches).map((d) => ({ key: d.key, label: d.label, entity: d.entity, type: d.type, ...(d.hint ? { hint: d.hint } : {}) })),
          measures: catalogue.measures.filter(matches).map((m) => ({ key: m.key, label: m.label, entity: m.entity, format: m.format, ...(m.hint ? { hint: m.hint } : {}) })),
          note: "A measure is computed at its entity's grain. A dimension on another entity works only through a many-to-one join; otherwise the query is refused rather than multiplied.",
        };
      },
    }),
    defineTool({
      name: "query",
      description: "Run one query against the pack and return its rows plus the native query that ran. Use this to answer questions or to check a widget before adding it.",
      inputSchema: z.object(QUERY_SHAPE),
      async execute(a) {
        try {
          const query = assembleQuery(a, pack);
          const data = await run(query, { pack, connector, ctx, timeoutMs: opts.timeoutMs });
          if (data.error) return { ok: false, error: data.error, ...(data.hint ? { didYouMean: data.hint } : {}) };
          const { text } = await explain(query, { pack, connector, ctx });
          const closest = data.total === 0 ? await closestValues(query) : "";
          return {
            ok: true,
            query,
            ...(closest ? { didYouMean: closest } : {}),
            rows: data.records ?? data.rows,
            total: data.total,
            format: data.format,
            compare: data.compare,
            ...(data.approximate ? { approximate: true } : {}),
            [nativeKey]: text,
          };
        } catch (e) {
          return { ok: false, ...fail(e) };
        }
      },
    }),
    defineTool({
      name: "explain",
      description: "Compile a query without running it: the native query, the entities used, and the tenant scope. Cheap; use it to debug a refusal.",
      inputSchema: z.object(QUERY_SHAPE),
      async execute(a) {
        try {
          const query = assembleQuery(a, pack);
          const c = await explain(query, { pack, connector, ctx });
          return { ok: true, query, [nativeKey]: c.text, root: c.root, entities: c.entities, tenant: c.tenant, ...(c.approximate ? { approximate: true } : {}) };
        } catch (e) {
          return { ok: false, ...fail(e) };
        }
      },
    }),
    defineTool({
      name: "list_values",
      description: "A dimension's most common values with their row counts. Use it before filtering on a value you have not seen: filter values must match exactly.",
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
        const board = await store.get(boardId);
        if (!board) return { error: "This board no longer exists" };
        return { board: summarise(board.config), version: board.version };
      },
    }),
    defineTool({
      name: "add_widget",
      description: "Put something new on the board. Use chart for a breakdown or series, kpi for a single headline number, table for a list, text for a note.",
      inputSchema: z.object({
        id: z.string().describe("Short lowercase id, e.g. revenue_by_country"),
        kind: z.enum(["chart", "kpi", "table", "text"]),
        title: z.string().describe("What the reader sees above it"),
        chart: oneOf(["bar", "line", "pie", "area"], "bar").describe("Only when kind is chart"),
        body: str().describe("Only when kind is text: the note itself"),
        ...QUERY_SHAPE,
        place: PLACE,
        width: WIDTH,
        height: num(0, 0, 20).describe("Rows tall; 0 lets the server choose"),
      }),
      async execute(a) {
        try {
          const widget =
            a.kind === "text"
              ? { kind: "text" as const, title: a.title, body: a.body }
              : a.kind === "kpi"
                ? { kind: "kpi" as const, title: a.title, query: assembleQuery(a, pack), aggregate: "last" as const }
                : a.kind === "table"
                  ? { kind: "table" as const, title: a.title, query: assembleQuery(a, pack), pageSize: 10 }
                  : { kind: "chart" as const, chart: a.chart as "bar" | "line" | "pie" | "area", title: a.title, query: assembleQuery(a, pack), options: { legend: true, colorScheme: "default" as const } };
          return apply([{ op: "add_widget", id: a.id, widget, placement: { place: a.place, width: a.width as "full" | "half" | "third" | "quarter", ...(a.height > 0 ? { height: a.height } : {}) } }]);
        } catch (e) {
          return fail(e);
        }
      },
    }),
    defineTool({
      name: "update_widget",
      description:
        "Change a widget in place: give its id and only what changes; every field left out keeps its current value. Query fields change the current query; a different query_kind starts a new query from the fields given.",
      inputSchema: z.object({
        id: z.string(),
        kind: given(z.enum(["chart", "kpi", "table", "text"])).describe("Only to change it; a text widget needs body, any other a query"),
        title: given(z.string()),
        chart: given(z.enum(["bar", "line", "pie", "area"])),
        body: given(z.string()),
        ...PATCH_SHAPE,
      }),
      async execute({ id, kind, title, chart, body, ...fields }) {
        const changed = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<QueryArgs>;
        try {
          return await apply(async () => {
            const widgets = (await store.get(boardId))?.config.widgets ?? {};
            const current = widgets[id];
            const near = nearest(id, Object.keys(widgets));
            if (!current) return { applied: false, error: `No widget called "${id}"`, ...(near ? { didYouMean: near } : {}) };
            const to = kind ?? current.kind;
            const name = title ?? current.title;
            if (to === "text") {
              const text = body ?? (current.kind === "text" ? current.body : undefined);
              if (text === undefined) return { applied: false, error: "A text widget needs body" };
              return [{ op: "update_widget", id, widget: { kind: "text", title: name, body: text } }];
            }
            if (current.kind === "text" && !changed.query_kind) return { applied: false, error: `A ${to} needs a query: give query_kind and its fields` };
            const query = current.kind === "text" ? assembleQuery(z.object(QUERY_SHAPE).parse(changed), pack) : patchQuery(current.query, changed, pack);
            const widget =
              to === "kpi"
                ? { aggregate: "last" as const, ...(current.kind === "kpi" ? current : {}), kind: "kpi" as const, title: name, query }
                : to === "table"
                  ? { pageSize: 10, ...(current.kind === "table" ? current : {}), kind: "table" as const, title: name, query }
                  : {
                      options: { legend: true, colorScheme: "default" as const },
                      ...(current.kind === "chart" ? current : {}),
                      kind: "chart" as const,
                      chart: chart ?? (current.kind === "chart" ? current.chart : "bar"),
                      title: name,
                      query,
                    };
            return [{ op: "update_widget", id, widget }];
          });
        } catch (e) {
          return fail(e);
        }
      },
    }),
    defineTool({
      name: "move_widget",
      description: "Move a widget somewhere else on the board.",
      inputSchema: z.object({ id: z.string(), place: PLACE, width: WIDTH }),
      execute: ({ id, place, width }) => {
        const w = width as "full" | "half" | "third" | "quarter";
        return apply([{ op: "move_widget", id, placement: { place, width: w } }, { op: "resize_widget", id, width: w }]);
      },
    }),
    defineTool({
      name: "resize_widget",
      description: "Make a widget wider, narrower, taller or shorter.",
      inputSchema: z.object({ id: z.string(), width: WIDTH, height: num(0, 0, 20).describe("Rows tall; 0 leaves the height alone") }),
      execute: ({ id, width, height }) => apply([{ op: "resize_widget", id, width: width as "full" | "half" | "third" | "quarter", ...(height > 0 ? { height } : {}) }]),
    }),
    defineTool({
      name: "remove_widget",
      description: "Take a widget off the board. Say what you are removing before you do it.",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => apply([{ op: "remove_widget", id }]),
    }),
    defineTool({
      name: "add_filter",
      description: "Add a control at the top of the board that narrows it to one value of a dimension.",
      inputSchema: z.object({
        field: z.string().describe("The dimension key, from list_metrics"),
        label: str().describe("What the control is called; defaults to the dimension's label"),
        applies: str("*").describe('"*" for every widget, or widget ids separated by commas'),
      }),
      execute: ({ field, label, applies }) => {
        const targets = applies.split(",").map((s) => s.trim()).filter(Boolean);
        const dim = catalogue.dimensions.find((d) => d.key === field);
        return apply([{ op: "add_filter", filter: { id: `filter_${field}`, type: "select", label: label.trim() || dim?.label || field, field, applies: targets.length ? targets : ["*"] } }]);
      },
    }),
    defineTool({
      name: "remove_filter",
      description: "Take a filter off the board.",
      inputSchema: z.object({ field: z.string().describe("The dimension the filter is on") }),
      execute: ({ field }) => apply([{ op: "remove_filter", id: `filter_${field}` }]),
    }),
    defineTool({
      name: "set_layout_mode",
      description: 'How the board uses space. density "compact" tightens gutters and row height; fill true packs each row (gaps closed, last widget widened to the edge) now and on every later edit. Use for "make it compact", "pack it", "tighter", "use less space".',
      inputSchema: z.object({
        density: oneOf(["comfortable", "compact"], "").describe("comfortable or compact; empty leaves it"),
        fill: z.union([z.boolean(), z.string(), z.null(), z.undefined()]).transform((v) => (v === null || v === undefined || v === "" ? undefined : v === true || v === "true")).describe("true to pack rows, false to stop packing; omit to leave it"),
      }),
      execute: ({ density, fill }) => apply([{ op: "set_layout_mode", ...(density ? { density: density as "comfortable" | "compact" } : {}), ...(fill === undefined ? {} : { fill }) }]),
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

  if (opts.runSql && executor) {
    tools.push(defineTool({
      name: "run_sql",
      description: `Read-only SQL for a question the pack cannot express. One SELECT or WITH statement, capped rows, timeboxed. Results are for answering, never for widgets: if the answer is worth keeping, propose_measure it. Tables:\n${describeSources(pack)}`,
      inputSchema: z.object({ sql: z.string() }),
      async execute({ sql }) {
        try {
          return { ok: true, ...(await runSql(sql, executor, { timeoutMs: opts.timeoutMs })) };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    }));
  }

  return tools;
}
