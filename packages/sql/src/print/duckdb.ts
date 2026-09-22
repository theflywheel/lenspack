import type { Ast } from "../ast";
import { type DialectRules, type Printed, print, quoteTable } from "./base";

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;

export const duckdbRules: DialectRules = {
  dialect: "duckdb",
  quote,
  cast: (to) => ({ double: "DOUBLE", text: "VARCHAR", timestamp: "TIMESTAMP", int: "INTEGER" })[to],
  json: (col, path) => {
    const seg = (s: string) => `."${s.replace(/"/g, '\\"')}"`;
    if (path.length === 0) return `CAST(${col} AS VARCHAR)`;
    return `json_extract_string(${col}, '$${path.map(seg).join("")}')`;
  },
  percentile: (fn, arg) => `quantile_cont(${arg}, ${fn === "median" ? 0.5 : 0.9})`,
  trunc: (grain, arg) => `date_trunc('${grain}', ${arg})`,
  // DuckDB accepts numbered parameters, so both dialects bind the same way.
  param: (i) => `$${i}`,
  paramValue: (v) => (v instanceof Date ? v.toISOString().replace("T", " ").replace("Z", "") : v),
};

export function printDuckdb(ast: Ast): Printed {
  const fix = (s: Ast["from"]) => ({ ...s, table: quoteTable(s.table, quote) });
  return print({ ...ast, from: fix(ast.from), joins: ast.joins.map((j) => ({ ...j, source: fix(j.source) })) }, duckdbRules);
}
