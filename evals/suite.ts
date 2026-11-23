// A suite is data: questions in a user's words, what a right query looks like,
// and where the true answer comes from. Truth is computed outside Lenspack
// (SQL straight against the database) and frozen in a truth file, so a run is
// never graded against the system it is grading.
import { readFileSync } from "node:fs";

import YAML from "yaml";
import { z } from "zod";

const list = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]).transform((v) => (Array.isArray(v) ? v.map(String) : [String(v)]));
const filters = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/** The parts of a query that make it right; each field is any-of. */
export const queryExpectSchema = z
  .object({
    kind: list,
    measure: list,
    measures_include: z.array(z.string()),
    dimension: list,
    grain: list,
    sort: list,
    filters,
  })
  .partial();
export type QueryExpect = z.infer<typeof queryExpectSchema>;

export const widgetExpectSchema = z.object({ kind: list.optional(), chart: list.optional(), query: queryExpectSchema.optional() });
export type WidgetExpect = z.infer<typeof widgetExpectSchema>;

export const SHAPES = ["scalar", "map", "set", "list", "series", "table"] as const;
export type Shape = (typeof SHAPES)[number];
export const UNITS = ["count", "ratio", "number"] as const;
export type Unit = (typeof UNITS)[number];

const truthSpecSchema = z.object({
  shape: z.enum(SHAPES),
  unit: z.enum(UNITS).default("count"),
  sql: z.string(),
  k: z.number().int().positive().optional(),
  /** For a set: every candidate key, so naming one that is not in the answer counts against precision. */
  universe_sql: z.string().optional(),
  alternatives: z.array(z.object({ label: z.string(), sql: z.string() })).optional(),
});

/** One step of a scripted stub model: a tool call, or the final text ({{rows}} renders the last tool result's rows). */
export const stubStepSchema = z.union([z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) }), z.object({ text: z.string() })]);
export type StubStep = z.infer<typeof stubStepSchema>;

export const WHY = ["engine", "pack", "data", "scope"] as const;

export const questionSchema = z
  .object({
    id: z.string(),
    tier: z.string(),
    prompt: z.string().optional(),
    turns: z.array(z.string()).min(1).optional(),
    /** answer: the reply must carry the number; edit: the board must change; decline: say it can't, or degrade openly. */
    expect: z.enum(["answer", "edit", "decline"]),
    tags: z.array(z.string()).default([]),
    accept: z.object({ measures: list.optional(), dimension: list.optional(), grain: list.optional(), filters: filters.optional() }).optional(),
    truth: truthSpecSchema.optional(),
    cross: z.string().optional(),
    /** Words of which one must appear when the answer depends on a definition (tag ambiguous). */
    disclose: z.array(z.string()).optional(),
    why: z.enum(WHY).optional(),
    note: z.string().optional(),
    widget: widgetExpectSchema.optional(),
    widgets: z.array(widgetExpectSchema).optional(),
    layout: z.object({ same_row: z.boolean().optional(), width: z.number().int().optional() }).optional(),
    filter: z.object({ field: list, applies_all: z.boolean().optional() }).optional(),
    title: z.string().optional(),
    removed: z.object({ title: z.string() }).optional(),
    changed: z.object({ title: z.string(), chart: list.optional() }).optional(),
    absent: z.object({ query: queryExpectSchema, new_only: z.boolean().optional() }).optional(),
    /** Where widgets start for this question, found by title ("(?i)" for any case); the rest keep the seed's place. */
    start_layout: z.array(z.object({ title: z.string(), x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1), h: z.number().int().min(1) })).optional(),
    /** A move: the widget titled `title` must end on the same row as the one titled `beside`, with nothing overlapping. */
    moved: z.object({ title: z.string(), beside: z.string() }).optional(),
    stub: z.array(z.array(stubStepSchema)).optional(),
  })
  .refine((q) => q.prompt || q.turns, { message: "a question needs a prompt or turns" });
export type Question = z.infer<typeof questionSchema>;

export const suiteSchema = z.object({
  suite: z.string(),
  /** A deployment config (Superset), relative to the suite file. */
  config: z.string().optional(),
  /** Or one of the repo's examples, seeded into DuckDB. */
  example: z.string().optional(),
  board: z.object({ dashboard: z.number().int().optional(), example_board: z.string().optional() }).default({}),
  now: z.string().optional(),
  /** ISO date of campaign day 1, for date keys written "Day N". */
  day_one: z.string().optional(),
  questions: z.array(questionSchema),
});
export type Suite = z.infer<typeof suiteSchema>;

export type TruthValue = number | string | null | string[] | [string, number | null][] | Record<string, number | null> | Record<string, Record<string, number | null>>;
export type Truth = { shape: Shape; unit: Unit; value: TruthValue; k?: number; universe?: string[]; alternatives?: { label: string; value: TruthValue }[]; /** ISO date of day 1, so a date key may be written "Day N". */ dayOne?: string };
export type TruthFile = { suite: string; computed: string; fingerprint?: Record<string, unknown>; questions: Record<string, Truth> };

export const turnsOf = (q: Question) => q.turns ?? [q.prompt!];

export function loadSuite(path: string): Suite {
  return suiteSchema.parse(YAML.parse(readFileSync(path, "utf8")));
}

/** Rows from a truth query, shaped as the suite says (first column the key). */
export function shapeRows(rows: Record<string, unknown>[], shape: Shape): TruthValue {
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  const num = (v: unknown) => (v === null || v === undefined ? null : typeof v === "bigint" ? Number(v) : Number(v));
  const key = (r: Record<string, unknown>) => (r[cols[0]!] instanceof Date ? (r[cols[0]!] as Date).toISOString().slice(0, 10) : String(r[cols[0]!]));
  switch (shape) {
    case "scalar":
      return rows[0] ? num(rows[0][cols[0]!]) : null;
    case "set":
      return rows.map(key).sort();
    case "map":
    case "series":
      return Object.fromEntries(rows.map((r) => [key(r), num(r[cols[1]!])]));
    case "list":
      return rows.map((r) => [key(r), num(r[cols[1]!])] as [string, number | null]);
    case "table":
      return Object.fromEntries(rows.map((r) => [key(r), Object.fromEntries(cols.slice(1).map((c) => [c, num(r[c])]))]));
  }
}
