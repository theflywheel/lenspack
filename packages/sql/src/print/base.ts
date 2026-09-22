import { fragmentFor } from "@lenspack/spec";

import type { Ast, Expr, Source } from "../ast";

export type Dialect = "postgres" | "duckdb";
export type Printed = { sql: string; params: unknown[] };

// Everything a dialect can differ on lives in this table; the printer below
// never branches on the dialect itself.
export type DialectRules = {
  dialect: Dialect;
  quote(id: string): string;
  cast(to: "double" | "text" | "timestamp" | "int"): string;
  json(col: string, path: string[]): string;
  percentile(fn: "median" | "p90", arg: string): string;
  trunc(grain: string, arg: string): string;
  param(index: number): string;
  paramValue(value: unknown): unknown;
};

export function print(ast: Ast, rules: DialectRules): Printed {
  const params: unknown[] = [];
  const q = rules.quote;
  const P = (value: unknown, cast?: "timestamp" | "double" | "int") => {
    params.push(rules.paramValue(value));
    const ph = rules.param(params.length);
    return cast ? `CAST(${ph} AS ${rules.cast(cast)})` : ph;
  };

  const expr = (e: Expr): string => {
    switch (e.t) {
      case "raw":
        return `(${fragmentFor(e.sql, rules.dialect)})`;
      case "col":
        return e.alias ? `${q(e.alias)}.${q(e.col)}` : q(e.col);
      case "param":
        return P(e.value, e.cast);
      case "lit":
        return String(e.value);
      case "star":
        return "*";
      case "json":
        return rules.json(q(e.col), e.path);
      case "agg": {
        if (e.fn === "count_distinct") return `count(DISTINCT ${expr(e.arg)})`;
        if (e.fn === "median" || e.fn === "p90") return rules.percentile(e.fn, expr(e.arg));
        return `${e.fn}(${expr(e.arg)})`;
      }
      case "bin":
        return `(${expr(e.l)} ${e.op} ${expr(e.r)})`;
      case "in":
        return `(${expr(e.l)} IN (${e.values.map(expr).join(", ")}))`;
      case "case":
        return `CASE WHEN ${expr(e.when)} THEN ${expr(e.then)} END`;
      case "trunc":
        return rules.trunc(e.grain, expr(e.arg));
      case "cast":
        return `CAST(${expr(e.arg)} AS ${rules.cast(e.to)})`;
      case "nullif0":
        return `NULLIF(${expr(e.arg)}, 0)`;
      case "paren":
        return `(${expr(e.arg)})`;
    }
  };

  const source = (s: Source) => {
    const projections = s.projections.map((p) => `, ${expr(p.expr)} AS ${q(p.alias)}`).join("");
    const where = s.where.length ? ` WHERE ${s.where.map(expr).join(" AND ")}` : "";
    return `(SELECT *${projections} FROM ${s.table}${where}) AS ${q(s.alias)}`;
  };

  const parts = [
    `SELECT ${ast.select.map((s) => `${expr(s.expr)} AS ${q(s.alias)}`).join(", ")}`,
    `FROM ${source(ast.from)}`,
    ...ast.joins.map((j) => `LEFT JOIN ${source(j.source)} ON ${expr(j.on.left)} = ${expr(j.on.right)}`),
  ];
  if (ast.where.length) parts.push(`WHERE ${ast.where.map(expr).join(" AND ")}`);
  if (ast.groupBy.length) parts.push(`GROUP BY ${ast.groupBy.map(expr).join(", ")}`);
  if (ast.orderBy.length) parts.push(`ORDER BY ${ast.orderBy.map((o) => `${expr(o.expr)} ${o.dir.toUpperCase()} NULLS LAST`).join(", ")}`);
  parts.push(`LIMIT ${Math.max(1, Math.floor(ast.limit))}`);
  return { sql: parts.join("\n"), params };
}

// Table names from the pack are validated as identifiers, but quoting each
// part keeps a mixed-case name intact on Postgres.
export function quoteTable(table: string, quote: (s: string) => string) {
  return table.split(".").map(quote).join(".");
}
