import { type Capabilities, ResolveError } from "@lenspack/engine";
import { maybeFragmentFor } from "@lenspack/spec";

import type { Ast, Expr, Grain, Source } from "../ast";

/** The SQL dialects lenspack ships; a driver registered from outside adds its own name. */
export type Dialect = "postgres" | "duckdb" | "mysql" | "sqlite" | "clickhouse" | (string & {});
export type Printed = { sql: string; params: unknown[] };

/** Operators a dialect may spell differently. Every other operator prints as `(l op r)`. */
export type SpelledOp = "ILIKE" | "LIKE" | "IS DISTINCT FROM";

// Everything a dialect can differ on lives in this table; the printer below
// never branches on the dialect itself.
export type DialectRules = {
  dialect: Dialect;
  quote(id: string): string;
  cast(to: "double" | "text" | "timestamp" | "int" | "bigint"): string;
  json(col: string, path: string[]): string;
  /** Exact median / p90. Absent when the dialect has none: the measure is refused. */
  percentile?(fn: "median" | "p90", arg: string): string;
  /** The start of the bucket a timestamp falls in; weeks start on Monday. */
  trunc(grain: Grain, arg: string): string;
  epoch(arg: string, unit: "epoch_ms" | "epoch_s"): string;
  segment(arg: string, values: string[]): string;
  /** The placeholder for the index-th parameter (1-based); some dialects type it by its value. */
  param(index: number, value: unknown): string;
  paramValue(value: unknown): unknown;
  ops?: Partial<Record<SpelledOp, (l: string, r: string) => string>>;
  /** Aggregates a dialect must spell differently to return the same number. Default: `fn(arg)`. */
  aggregate?: Partial<Record<"count" | "sum" | "avg" | "min" | "max", (arg: string) => string>>;
  /**
   * One ORDER BY term, NULLs last. Default: `x ASC NULLS LAST`. When the term
   * names a selected aggregate, `selected()` prints the expression behind it,
   * for dialects that cannot use an aggregate's alias inside an expression.
   */
  orderBy?(expr: string, dir: "asc" | "desc", selected?: () => string): string;
  /** What resolution must refuse up front on this dialect; merged over SQL_CAPABILITIES. */
  capabilities?: Partial<Capabilities>;
};

export function print(ast: Ast, rules: DialectRules): Printed {
  const params: unknown[] = [];
  const q = rules.quote;
  const P = (value: unknown, cast?: "timestamp" | "double" | "int" | "bigint") => {
    params.push(rules.paramValue(value));
    const ph = rules.param(params.length, value);
    return cast ? `CAST(${ph} AS ${rules.cast(cast)})` : ph;
  };

  const expr = (e: Expr): string => {
    switch (e.t) {
      case "raw": {
        const sql = maybeFragmentFor(e.sql, rules.dialect);
        if (!sql) throw new ResolveError("NOT_SUPPORTED", `The pack has no ${rules.dialect} form of the fragment ${JSON.stringify(e.sql)}; add a ${rules.dialect}: or default: entry`);
        return `(${sql})`;
      }
      case "col":
        return e.alias ? `${q(e.alias)}.${q(e.col)}` : q(e.col);
      case "param":
        return P(e.value, e.cast);
      case "str":
        return `'${e.value.replace(/'/g, "''")}'`;
      case "lit":
        return String(e.value);
      case "star":
        return "*";
      case "json":
        return rules.json(q(e.col), e.path);
      case "agg": {
        if (e.fn === "count_distinct") return `count(DISTINCT ${expr(e.arg)})`;
        if (e.fn === "median" || e.fn === "p90") {
          if (!rules.percentile) throw new ResolveError("NOT_SUPPORTED", `${rules.dialect} has no percentile function, so a ${e.fn} is not computed here`);
          return rules.percentile(e.fn, expr(e.arg));
        }
        const spelled = rules.aggregate?.[e.fn];
        return spelled ? spelled(expr(e.arg)) : `${e.fn}(${expr(e.arg)})`;
      }
      case "bin": {
        const spelled = rules.ops?.[e.op as SpelledOp];
        return spelled ? spelled(expr(e.l), expr(e.r)) : `(${expr(e.l)} ${e.op} ${expr(e.r)})`;
      }
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
      case "epoch":
        return rules.epoch(expr(e.arg), e.unit);
      case "segment":
        return rules.segment(expr(e.arg), e.values.map(expr));
      case "notnull":
        return `(${expr(e.arg)} IS NOT NULL)`;
      case "isnull":
        return `(${expr(e.arg)} IS NULL)`;
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
  const order = rules.orderBy ?? ((e: string, dir: "asc" | "desc") => `${e} ${dir.toUpperCase()} NULLS LAST`);
  const selected = (e: Expr) => {
    const s = e.t === "col" && !e.alias ? ast.select.find((x) => x.alias === e.col) : undefined;
    return s && aggregated(s.expr) ? () => expr(s.expr) : undefined;
  };
  if (ast.orderBy.length) parts.push(`ORDER BY ${ast.orderBy.map((o) => order(expr(o.expr), o.dir, selected(o.expr))).join(", ")}`);
  parts.push(`LIMIT ${Math.max(1, Math.floor(ast.limit))}`);
  return { sql: parts.join("\n"), params };
}

function aggregated(e: Expr): boolean {
  switch (e.t) {
    case "agg":
      return true;
    case "bin":
      return aggregated(e.l) || aggregated(e.r);
    case "case":
      return aggregated(e.when) || aggregated(e.then);
    case "cast":
    case "nullif0":
    case "paren":
      return aggregated(e.arg);
    default:
      return false;
  }
}

// Table names from the pack are validated as identifiers, but quoting each
// part keeps a mixed-case name intact on Postgres.
export function quoteTable(table: string, quote: (s: string) => string) {
  return table.split(".").map(quote).join(".");
}

/** A dialect's printer: quotes the pack's table names with its own quoting, then prints. */
export function printerFor(rules: DialectRules): (ast: Ast) => Printed {
  const fix = (s: Source): Source => ({ ...s, table: quoteTable(s.table, rules.quote) });
  return (ast) => print({ ...ast, from: fix(ast.from), joins: ast.joins.map((j) => ({ ...j, source: fix(j.source) })) }, rules);
}
