import { z } from "zod";

import { ExprError, expandExpr, operands, parseExpr } from "./expr";

// The pack is the only place a domain is described. Humans write it; it is
// reviewed in git; the model only ever names keys from it. The `sql` fragments
// are trusted code precisely because they never come from a request.

const slug = z.string().regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and underscores, starting with a letter");
// A table (optionally schema-qualified) or a search index; index names carry
// hyphens, may be a pattern, or a comma-separated list searched as one.
// Printers quote it; it is never a fragment.
const qualified = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_*-]*(,[A-Za-z_][A-Za-z0-9_*-]*)*(\.[A-Za-z_][A-Za-z0-9_*-]*)?$/, "a table or index name (or index list), optionally schema-qualified");
const column = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a column name");
// A column, or a document field path such as "attrs.region.keyword". The one
// way to name data that every connector understands.
export const fieldPath = z.string().regex(/^[A-Za-z_@][A-Za-z0-9_@]*(\.[A-Za-z_@][A-Za-z0-9_@]*)*$/, 'a column or field path, e.g. "region" or "attrs.region.keyword"');

export const AGGS = ["count", "count_distinct", "sum", "avg", "min", "max", "median", "p90"] as const;
export const FORMATS = ["number", "percent", "currency", "compact", "duration"] as const;
export const GRAINS = ["hour", "day", "week", "month", "quarter", "year"] as const;

// A fragment is one string, or one per dialect when the engines genuinely
// differ (a date difference, a regex). `default` covers the rest.
export const fragmentSchema = z.union([
  z.string().min(1).max(500),
  z
    .object({
      default: z.string().min(1).max(500).optional(),
      postgres: z.string().min(1).max(500).optional(),
      duckdb: z.string().min(1).max(500).optional(),
      // Query DSL JSON for a filter; a Painless script for a dimension or measure.
      elasticsearch: z.string().min(1).max(2000).optional(),
    })
    .refine((f) => f.default || f.postgres || f.duckdb || f.elasticsearch, { message: "a per-dialect fragment needs at least one entry" }),
]);
export type Fragment = z.infer<typeof fragmentSchema>;

export function fragmentFor(fragment: Fragment, dialect: string): string {
  const chosen = maybeFragmentFor(fragment, dialect);
  if (!chosen) throw new Error(`No fragment for dialect "${dialect}"`);
  return chosen;
}

/** A bare string is SQL: it serves every SQL dialect but never a non-SQL one. */
export function maybeFragmentFor(fragment: Fragment, dialect: string): string | undefined {
  const sql = dialect === "postgres" || dialect === "duckdb";
  if (typeof fragment === "string") return sql ? fragment : undefined;
  return (fragment as Record<string, string | undefined>)[dialect] ?? (sql ? fragment.default : undefined);
}

// A structured predicate: the connector-neutral way to say "only these rows".
export const WHERE_OPS = ["eq", "neq", "in", "gt", "gte", "lt", "lte", "exists", "missing"] as const;
const whereValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()])).min(1).max(100)]);
export const whereSchema = z
  .object({ field: fieldPath, op: z.enum(WHERE_OPS).default("eq"), value: whereValue.optional() })
  .refine((w) => (w.op === "exists" || w.op === "missing") === (w.value === undefined), { message: "every op but exists and missing takes a value" })
  .refine((w) => (w.op === "in") === Array.isArray(w.value), { message: "in takes a list; the other ops take one value" });
export type Where = z.infer<typeof whereSchema>;

export const joinSchema = z.object({
  to: slug,
  // "things.owner_id = owners.id" — parsed, never inlined.
  on: z.string().regex(/^\s*[a-z][a-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\s*=\s*[a-z][a-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\s*$/, 'e.g. "things.owner_id = owners.id"'),
  type: z.enum(["many_to_one", "one_to_one", "one_to_many"]),
});

export const entitySchema = z.object({
  source: qualified,
  grain: z.string().max(200).optional(),
  // A column, or an expression that yields a timestamp — schemas that store
  // epoch milliseconds in a BIGINT are common enough to deserve first-class
  // support: `time: { sql: { postgres: "to_timestamp(createdtime / 1000.0)", duckdb: "epoch_ms(createdtime)" } }`.
  // A field holding numbers rather than timestamps says its unit, and every
  // connector converts: `time: { field: Data.createdTime, unit: epoch_ms }`.
  time: z.union([fieldPath, z.object({ sql: fragmentSchema }), z.object({ field: fieldPath, unit: z.enum(["epoch_ms", "epoch_s"]) })]).optional(),
  tenant: fieldPath.optional(),
  // A predicate every query over this entity carries, e.g. soft deletes:
  // `filter: "isdeleted = false"`. Pushed into the entity's subquery.
  filter: fragmentSchema.optional(),
  where: z.array(whereSchema).max(20).optional(),
  joins: z.array(joinSchema).default([]),
});

const named = {
  label: z.string().max(80).optional(),
  hint: z.string().max(400).optional(),
  synonyms: z.array(z.string().max(40)).max(20).default([]),
  // A key in a pack file is verified by the review that merged it. Only a
  // proposal written by the model starts unverified.
  verified: z.boolean().default(true),
};

// How a dimension reads on one entity: a field, a fragment, or a JSON path.
const dimensionSource = {
  field: fieldPath.optional(),
  sql: fragmentSchema.optional(),
  json: z.array(z.string().min(1).max(80)).min(1).max(8).optional(),
};
const oneSource = (d: { field?: unknown; sql?: unknown; json?: unknown }) => (d.field ? 1 : 0) + (d.sql ? 1 : 0) + (d.json ? 1 : 0) === 1;

export const dimensionSchema = z
  .object({
    key: slug,
    entity: slug,
    ...dimensionSource,
    // The same concept on other entities (a conformed dimension). It is what
    // lets one "region" group measures that live on different entities, and
    // what a cross-entity ratio joins its two sides on.
    also: z.record(slug, z.object(dimensionSource).refine(oneSource, { message: "exactly one of field, sql or json" })).optional(),
    type: z.enum(["string", "number", "boolean", "time", "enum"]).default("string"),
    grains: z.array(z.enum(GRAINS)).optional(),
    ...named,
  })
  .refine(oneSource, { message: "a dimension has exactly one of field, sql or json" });

export const measureSchema = z
  .object({
    key: slug,
    entity: slug,
    agg: z.enum(AGGS).optional(),
    sql: fragmentSchema.optional(),
    field: fieldPath.optional(),
    // Arithmetic over other measures: "weight / things", "received - dispatched",
    // "(a + b) / c * 100". Operands on different entities are computed
    // separately and combined per group.
    derived: z
      .string()
      .max(300)
      .refine((s) => {
        try {
          parseExpr(s);
          return true;
        } catch {
          return false;
        }
      }, 'measure keys and numbers with + - * / and parentheses, e.g. "weight / things"')
      .optional(),
    // An extra predicate on the base rows, e.g. "state = 'broken'".
    filter: fragmentSchema.optional(),
    where: z.array(whereSchema).max(20).optional(),
    // Multiplies the aggregate, e.g. people per item handed out.
    scale: z.number().refine((n) => n !== 0 && Number.isFinite(n), "a non-zero number").optional(),
    format: z.enum(FORMATS).default("number"),
    ...named,
  })
  .refine((m) => (m.derived ? !m.agg && !m.sql && !m.field && !m.filter && !m.where && !m.scale : !!m.agg), {
    message: "a measure has agg (with optional sql or field, filter, where, scale), or derived, not both",
  })
  .refine((m) => !(m.sql && m.field), { message: "a measure has sql or field, not both" })
  .refine((m) => m.agg !== "count" || !m.sql, { message: "count takes no sql; count a field (non-null values), or use count_distinct or sum" })
  .refine((m) => !m.agg || m.agg === "count" || !!m.sql || !!m.field, { message: "an aggregate other than count needs sql or field" });

export const packSchema = z.object({
  pack: slug,
  version: z.number().int().min(1),
  description: z.string().max(500).optional(),
  entities: z.record(slug, entitySchema),
  dimensions: z.array(dimensionSchema).default([]),
  measures: z.array(measureSchema).default([]),
});

export type Pack = z.infer<typeof packSchema>;
export type PackEntity = z.infer<typeof entitySchema>;
export type PackDimension = z.infer<typeof dimensionSchema>;
export type PackMeasure = z.infer<typeof measureSchema>;
export type PackJoin = z.infer<typeof joinSchema>;
export type Agg = (typeof AGGS)[number];

export type ParsedJoin = { left: { entity: string; column: string }; right: { entity: string; column: string } };

export function parseJoinOn(on: string): ParsedJoin {
  const [l, r] = on.split("=").map((s) => s.trim()) as [string, string];
  const [le, lc] = l.split(".") as [string, string];
  const [re, rc] = r.split(".") as [string, string];
  return { left: { entity: le, column: lc }, right: { entity: re, column: rc } };
}

/** A two-operand ratio's parts; other expressions go through parseExpr. */
export function parseDerived(expr: string): { numerator: string; denominator: string } {
  const e = parseExpr(expr);
  if (e.t === "op" && e.op === "/" && e.l.t === "measure" && e.r.t === "measure") return { numerator: e.l.key, denominator: e.r.key };
  throw new ExprError(`"${expr}" is not a ratio of two measures`);
}

export type PackProblem = { path: string; message: string };

/** A measure's expression over aggregating measures only (derived operands inlined). */
export function expandedExpr(pack: Pack, key: string) {
  return expandExpr(key, (k) => pack.measures.find((m) => m.key === k)?.derived);
}

/** Cross-reference checks the zod schema cannot express. */
export function checkPack(pack: Pack): PackProblem[] {
  const problems: PackProblem[] = [];
  const entities = new Set(Object.keys(pack.entities));
  const keys = new Map<string, string>();

  for (const [entityKey, entity] of Object.entries(pack.entities)) {
    for (const [i, join] of entity.joins.entries()) {
      const path = `entities.${entityKey}.joins[${i}]`;
      if (!entities.has(join.to)) problems.push({ path, message: `joins an unknown entity "${join.to}"` });
      const parsed = parseJoinOn(join.on);
      const named = new Set([parsed.left.entity, parsed.right.entity]);
      if (!named.has(entityKey) || !named.has(join.to) || named.size !== 2)
        problems.push({ path, message: `"on" must reference exactly ${entityKey} and ${join.to}` });
    }
  }

  for (const [i, d] of pack.dimensions.entries()) {
    const path = `dimensions[${i}]`;
    if (keys.has(d.key)) problems.push({ path, message: `key "${d.key}" already used by ${keys.get(d.key)}` });
    keys.set(d.key, path);
    if (!entities.has(d.entity)) problems.push({ path, message: `unknown entity "${d.entity}"` });
    if (d.grains && d.type !== "time") problems.push({ path, message: "grains only apply to a time dimension" });
    for (const other of Object.keys(d.also ?? {})) {
      if (!entities.has(other)) problems.push({ path: `${path}.also.${other}`, message: `unknown entity "${other}"` });
      else if (other === d.entity) problems.push({ path: `${path}.also.${other}`, message: "also names the dimension's own entity" });
    }
  }

  const measureEntity = new Map(pack.measures.map((m) => [m.key, m.entity]));
  for (const [i, m] of pack.measures.entries()) {
    const path = `measures[${i}]`;
    if (keys.has(m.key)) problems.push({ path, message: `key "${m.key}" already used by ${keys.get(m.key)}` });
    keys.set(m.key, path);
    if (!entities.has(m.entity)) problems.push({ path, message: `unknown entity "${m.entity}"` });
    if (m.derived) {
      const ops = operands(parseExpr(m.derived));
      for (const operand of ops) {
        const ent = measureEntity.get(operand);
        if (!ent) problems.push({ path, message: `derived measure refers to unknown measure "${operand}"` });
      }
      try {
        expandedExpr(pack, m.key);
      } catch (e) {
        problems.push({ path, message: e instanceof Error ? e.message : String(e) });
      }
      // A derived measure is read at the grain of one of its operands.
      const entities = new Set(ops.map((o) => measureEntity.get(o)).filter(Boolean));
      if (entities.size && !entities.has(m.entity)) problems.push({ path, message: `a derived measure's entity is one of its operands' (${[...entities].join(", ")}), not "${m.entity}"` });
    }
  }

  return problems;
}
