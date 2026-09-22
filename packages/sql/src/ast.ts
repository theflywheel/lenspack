// A small SQL AST. Every identifier in it was bound to a pack object by the
// resolver; every value is a parameter. The printers own the dialects.

import type { Fragment } from "@lenspack/spec";

export type Grain = "hour" | "day" | "week" | "month" | "quarter" | "year";

export type Expr =
  | { t: "raw"; sql: Fragment } // a fragment from the pack, inlined verbatim (per dialect)
  | { t: "col"; alias: string; col: string }
  | { t: "param"; value: unknown; cast?: "timestamp" | "double" | "int" }
  | { t: "lit"; value: number }
  | { t: "star" }
  | { t: "json"; alias: string; col: string; path: string[] }
  | { t: "agg"; fn: "count" | "count_distinct" | "sum" | "avg" | "min" | "max" | "median" | "p90"; arg: Expr }
  | { t: "bin"; op: "=" | "<>" | ">=" | "<=" | ">" | "<" | "+" | "-" | "*" | "/" | "AND" | "OR" | "ILIKE"; l: Expr; r: Expr }
  | { t: "in"; l: Expr; values: Expr[] }
  | { t: "case"; when: Expr; then: Expr } // CASE WHEN when THEN then END (else NULL)
  | { t: "trunc"; grain: Grain; arg: Expr }
  | { t: "cast"; arg: Expr; to: "double" | "text" }
  | { t: "nullif0"; arg: Expr }
  | { t: "paren"; arg: Expr };

export type Source = {
  alias: string;
  table: string; // schema-qualified, from the pack
  projections: { alias: string; expr: Expr }[];
  where: Expr[]; // pushed down into the entity subquery (tenant)
};

export type Join = { source: Source; on: { left: Expr; right: Expr } };

export type Ast = {
  select: { alias: string; expr: Expr }[];
  from: Source;
  joins: Join[];
  where: Expr[];
  groupBy: Expr[];
  orderBy: { expr: Expr; dir: "asc" | "desc" }[];
  limit: number;
};

export const and = (exprs: Expr[]): Expr | null =>
  exprs.length === 0 ? null : exprs.reduce((l, r) => ({ t: "bin", op: "AND", l, r }));
