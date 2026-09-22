import { z } from "zod";

import { type BoardOp, type BoardStore, type Query, querySchema, summarise, verifiedOnly } from "@lenspack/core";
import { AGGS, FORMATS, type Pack, catalogueFrom } from "@lenspack/spec";
import { type Ctx, type Executor, checkOps, compile, describeSources, run, runSql } from "@lenspack/sql";

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
  executor: Executor;
  store: BoardStore;
  boardId: string;
  ctx?: Ctx;
  /** Off by default. Results are ephemeral and can never become a widget. */
  runSql?: boolean;
  proposals?: ProposalStore;
  timeoutMs?: number;
};

const PLACE = z.string().default("bottom").describe('Where to put it: "top", "bottom", or "after:<widgetId>"');
const WIDTH = z.enum(["full", "half", "third", "quarter"]).default("half").describe("full is the whole row, half is two across, third is three across");
const QUERY_SHAPE = {
  query_kind: z.enum(["breakdown", "series", "value", "rows"]).describe("breakdown = a measure per group; series = a measure over time; value = one number; rows = a list of records"),
  measure: z.string().default("").describe("Measure key from list_metrics (not for rows)"),
  dimension: z.string().default("").describe("For breakdown: the dimension to group by. For series: optional split. For rows: comma-separated columns"),
  entity: z.string().default("").describe("For rows: the entity to list"),
  grain: z.enum(["hour", "day", "week", "month", "quarter", "year"]).default("day").describe("For series"),
  time_last: z.string().default("").describe('Relative window like "30d", "12w", "6m"; empty for all time'),
  compare: z.boolean().default(false).describe("For value: also compute the previous period"),
  limit: z.number().int().min(0).max(500).default(0).describe("Max groups or rows; 0 for the default"),
  filter_dimension: z.string().default("").describe("Optional: narrow by this dimension"),
  filter_value: z.string().default("").describe("Optional: the value the filter dimension must equal"),
};

export function assembleQuery(a: { [K in keyof typeof QUERY_SHAPE]: z.infer<(typeof QUERY_SHAPE)[K]> }): Query {
  const filters = a.filter_dimension ? [{ dimension: a.filter_dimension, op: "eq" as const, value: a.filter_value }] : undefined;
  const time = a.time_last ? { last: a.time_last } : undefined;
  const base = { ...(filters ? { filters } : {}), ...(time ? { time } : {}) };
  switch (a.query_kind) {
    case "breakdown":
      return querySchema.parse({ kind: "breakdown", dimension: a.dimension, measure: a.measure, ...(a.limit ? { limit: a.limit } : {}), ...base });
    case "series":
      return querySchema.parse({ kind: "series", measure: a.measure, grain: a.grain, ...(a.dimension ? { by: a.dimension } : {}), ...base });
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

function fail(e: unknown) {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const err = e as { message: string; nearest?: string };
    return { applied: false, error: err.message, ...(err.nearest ? { didYouMean: err.nearest } : {}) };
  }
  return { applied: false, error: e instanceof Error ? e.message : String(e) };
}

export function boardTools(opts: BoardToolsOptions): Tool[] {
  const { pack, executor, store, boardId } = opts;
  const catalogue = verifiedOnly(catalogueFrom(pack));
  const ctx = opts.ctx ?? {};
  const proposals = opts.proposals ?? memoryProposals();

  const apply = async (ops: BoardOp[]) => {
    // Refuse at edit time what the compiler would refuse at render time.
    const checked = checkOps(ops, pack, { dialect: executor.dialect, ctx });
    if (!checked.ok) return { applied: false, error: checked.error, ...(checked.hint ? { didYouMean: checked.hint } : {}) };
    const result = await store.patch({ id: boardId, ops, catalogue, source: "chat" });
    if (!result.ok) return { applied: false, error: result.error, ...(result.hint ? { didYouMean: result.hint } : {}) };
    return { applied: true, version: result.board.version, board: summarise(result.board.config) };
  };

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
      description: "Run one query against the pack and return its rows plus the SQL that ran. Use this to answer questions or to check a widget before adding it.",
      inputSchema: z.object(QUERY_SHAPE),
      async execute(a) {
        try {
          const query = assembleQuery(a);
          const compiled = compile(query, pack, { dialect: executor.dialect, ctx });
          const data = await run(query, { pack, executor, ctx, timeoutMs: opts.timeoutMs });
          if (data.error) return { ok: false, error: data.error, ...(data.hint ? { didYouMean: data.hint } : {}) };
          return { ok: true, query, rows: data.records ?? data.rows, total: data.total, format: data.format, compare: data.compare, sql: compiled.sql };
        } catch (e) {
          return { ok: false, ...fail(e) };
        }
      },
    }),
    defineTool({
      name: "explain",
      description: "Compile a query without running it: the SQL, the entities joined, and the tenant scope. Cheap; use it to debug a refusal.",
      inputSchema: z.object(QUERY_SHAPE),
      async execute(a) {
        try {
          const query = assembleQuery(a);
          const c = compile(query, pack, { dialect: executor.dialect, ctx });
          return { ok: true, query, sql: c.sql, params: c.params, root: c.bound.root, entities: c.bound.entitiesUsed, tenant: c.bound.tenant };
        } catch (e) {
          return { ok: false, ...fail(e) };
        }
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
        chart: z.enum(["bar", "line", "pie", "area"]).default("bar").describe("Only when kind is chart"),
        body: z.string().default("").describe("Only when kind is text: the note itself"),
        ...QUERY_SHAPE,
        place: PLACE,
        width: WIDTH,
        height: z.number().int().min(0).max(20).default(0).describe("Rows tall; 0 lets the server choose"),
      }),
      async execute(a) {
        try {
          const widget =
            a.kind === "text"
              ? { kind: "text" as const, title: a.title, body: a.body }
              : a.kind === "kpi"
                ? { kind: "kpi" as const, title: a.title, query: assembleQuery(a), aggregate: "last" as const }
                : a.kind === "table"
                  ? { kind: "table" as const, title: a.title, query: assembleQuery(a), pageSize: 10 }
                  : { kind: "chart" as const, chart: a.chart, title: a.title, query: assembleQuery(a), options: { legend: true, colorScheme: "default" as const } };
          return apply([{ op: "add_widget", id: a.id, widget, placement: { place: a.place, width: a.width, ...(a.height > 0 ? { height: a.height } : {}) } }]);
        } catch (e) {
          return fail(e);
        }
      },
    }),
    defineTool({
      name: "update_widget",
      description: "Replace a widget's title, chart type or query, keeping its place on the board.",
      inputSchema: z.object({
        id: z.string(),
        kind: z.enum(["chart", "kpi", "table", "text"]),
        title: z.string(),
        chart: z.enum(["bar", "line", "pie", "area"]).default("bar"),
        body: z.string().default(""),
        ...QUERY_SHAPE,
      }),
      async execute(a) {
        try {
          const widget =
            a.kind === "text"
              ? { kind: "text" as const, title: a.title, body: a.body }
              : a.kind === "kpi"
                ? { kind: "kpi" as const, title: a.title, query: assembleQuery(a), aggregate: "last" as const }
                : a.kind === "table"
                  ? { kind: "table" as const, title: a.title, query: assembleQuery(a), pageSize: 10 }
                  : { kind: "chart" as const, chart: a.chart, title: a.title, query: assembleQuery(a), options: { legend: true, colorScheme: "default" as const } };
          return apply([{ op: "update_widget", id: a.id, widget }]);
        } catch (e) {
          return fail(e);
        }
      },
    }),
    defineTool({
      name: "move_widget",
      description: "Move a widget somewhere else on the board.",
      inputSchema: z.object({ id: z.string(), place: PLACE, width: WIDTH }),
      execute: ({ id, place, width }) => apply([{ op: "move_widget", id, placement: { place, width } }, { op: "resize_widget", id, width }]),
    }),
    defineTool({
      name: "resize_widget",
      description: "Make a widget wider, narrower, taller or shorter.",
      inputSchema: z.object({ id: z.string(), width: WIDTH, height: z.number().int().min(0).max(20).default(0).describe("Rows tall; 0 leaves the height alone") }),
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
      description: "Add a control at the top of the board that narrows it to one value of a dimension.",
      inputSchema: z.object({
        field: z.string().describe("The dimension key, from list_metrics"),
        label: z.string().default("").describe("What the control is called; defaults to the dimension's label"),
        applies: z.string().default("*").describe('"*" for every widget, or widget ids separated by commas'),
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

  if (opts.runSql) {
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
