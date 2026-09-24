import { z } from "zod";

// The pack is the only place a domain is described. Humans write it; it is
// reviewed in git; the model only ever names keys from it. The `sql` fragments
// are trusted code precisely because they never come from a request.

const slug = z.string().regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and underscores, starting with a letter");
const qualified = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/, "a table name, optionally schema-qualified");
const column = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a column name");

export const AGGS = ["count", "count_distinct", "sum", "avg", "min", "max", "median", "p90"] as const;
export const FORMATS = ["number", "percent", "currency", "compact", "duration"] as const;
export const GRAINS = ["hour", "day", "week", "month", "quarter", "year"] as const;

// A fragment is one string, or one per dialect when the engines genuinely
// differ (a date difference, a regex). `default` covers the rest.
export const fragmentSchema = z.union([
  z.string().min(1).max(500),
  z
    .object({ default: z.string().min(1).max(500).optional(), postgres: z.string().min(1).max(500).optional(), duckdb: z.string().min(1).max(500).optional() })
    .refine((f) => f.default || f.postgres || f.duckdb, { message: "a per-dialect fragment needs at least one entry" }),
]);
export type Fragment = z.infer<typeof fragmentSchema>;

export function fragmentFor(fragment: Fragment, dialect: string): string {
  if (typeof fragment === "string") return fragment;
  const chosen = (fragment as Record<string, string | undefined>)[dialect] ?? fragment.default;
  if (!chosen) throw new Error(`No SQL fragment for dialect "${dialect}"`);
  return chosen;
}

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
  time: z.union([column, z.object({ sql: fragmentSchema })]).optional(),
  tenant: column.optional(),
  // A predicate every query over this entity carries, e.g. soft deletes:
  // `filter: "isdeleted = false"`. Pushed into the entity's subquery.
  filter: fragmentSchema.optional(),
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

export const dimensionSchema = z
  .object({
    key: slug,
    entity: slug,
    sql: fragmentSchema.optional(),
    json: z.array(z.string().min(1).max(80)).min(1).max(8).optional(),
    type: z.enum(["string", "number", "boolean", "time", "enum"]).default("string"),
    grains: z.array(z.enum(GRAINS)).optional(),
    ...named,
  })
  .refine((d) => (d.sql ? 1 : 0) + (d.json ? 1 : 0) === 1, { message: "a dimension has exactly one of sql or json" });

export const measureSchema = z
  .object({
    key: slug,
    entity: slug,
    agg: z.enum(AGGS).optional(),
    sql: fragmentSchema.optional(),
    // A ratio of two measures on the same entity, e.g. "weight / things".
    derived: z.string().regex(/^\s*[a-z][a-z0-9_]*\s*\/\s*[a-z][a-z0-9_]*\s*$/, 'e.g. "weight / things"').optional(),
    // An extra predicate on the base rows, e.g. "state = 'broken'".
    filter: fragmentSchema.optional(),
    format: z.enum(FORMATS).default("number"),
    ...named,
  })
  .refine((m) => (m.derived ? !m.agg && !m.sql && !m.filter : !!m.agg), {
    message: "a measure has agg (with optional sql and filter), or derived, not both",
  })
  .refine((m) => m.agg !== "count" || !m.sql, { message: "count takes no sql; use count_distinct or sum for an expression" })
  .refine((m) => !m.agg || m.agg === "count" || !!m.sql, { message: "an aggregate other than count needs sql" });

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

export function parseDerived(expr: string): { numerator: string; denominator: string } {
  const [n, d] = expr.split("/").map((s) => s.trim()) as [string, string];
  return { numerator: n, denominator: d };
}

export type PackProblem = { path: string; message: string };

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
  }

  const measureEntity = new Map(pack.measures.map((m) => [m.key, m.entity]));
  for (const [i, m] of pack.measures.entries()) {
    const path = `measures[${i}]`;
    if (keys.has(m.key)) problems.push({ path, message: `key "${m.key}" already used by ${keys.get(m.key)}` });
    keys.set(m.key, path);
    if (!entities.has(m.entity)) problems.push({ path, message: `unknown entity "${m.entity}"` });
    if (m.derived) {
      const { numerator, denominator } = parseDerived(m.derived);
      for (const operand of [numerator, denominator]) {
        const ent = measureEntity.get(operand);
        if (!ent) problems.push({ path, message: `derived measure refers to unknown measure "${operand}"` });
        else if (ent !== m.entity) problems.push({ path, message: `derived operand "${operand}" is on "${ent}", not "${m.entity}"` });
        const target = pack.measures.find((x) => x.key === operand);
        if (target?.derived) problems.push({ path, message: `derived measure "${operand}" cannot be an operand of another` });
      }
    }
  }

  return problems;
}
