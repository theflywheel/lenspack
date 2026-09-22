import type { Ast } from "../ast";
import { type DialectRules, type Printed, print, quoteTable } from "./base";

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;

export const postgresRules: DialectRules = {
  dialect: "postgres",
  quote,
  cast: (to) => ({ double: "DOUBLE PRECISION", text: "TEXT", timestamp: "TIMESTAMP", int: "INTEGER" })[to],
  json: (col, path) => {
    // (col #>> ARRAY['a','b']) reads nested keys as text; a single key uses ->>.
    const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
    if (path.length === 0) return `CAST(${col} AS TEXT)`;
    if (path.length === 1) return `(${col} ->> ${lit(path[0]!)})`;
    return `(${col} #>> ARRAY[${path.map(lit).join(",")}])`;
  },
  percentile: (fn, arg) => `percentile_cont(${fn === "median" ? 0.5 : 0.9}) WITHIN GROUP (ORDER BY ${arg})`,
  trunc: (grain, arg) => `date_trunc('${grain}', ${arg})`,
  param: (i) => `$${i}`,
  paramValue: (v) => (v instanceof Date ? v.toISOString() : v),
};

export function printPostgres(ast: Ast): Printed {
  return print(withQuotedTables(ast), postgresRules);
}

function withQuotedTables(ast: Ast): Ast {
  const fix = (s: Ast["from"]) => ({ ...s, table: quoteTable(s.table, quote) });
  return { ...ast, from: fix(ast.from), joins: ast.joins.map((j) => ({ ...j, source: fix(j.source) })) };
}
