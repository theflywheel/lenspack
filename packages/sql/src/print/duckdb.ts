import type { Ast } from "../ast";
import { type DialectRules, type Printed, printerFor } from "./base";

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;

export const duckdbRules: DialectRules = {
  dialect: "duckdb",
  quote,
  cast: (to) => ({ double: "DOUBLE", text: "VARCHAR", timestamp: "TIMESTAMP", int: "INTEGER", bigint: "BIGINT" })[to],
  json: (col, path) => {
    const seg = (s: string) => `."${s.replace(/"/g, '\\"')}"`;
    if (path.length === 0) return `CAST(${col} AS VARCHAR)`;
    return `json_extract_string(${col}, '$${path.map(seg).join("")}')`;
  },
  percentile: (fn, arg) => `quantile_cont(${arg}, ${fn === "median" ? 0.5 : 0.9})`,
  trunc: (grain, arg) => `date_trunc('${grain}', ${arg})`,
  segment: (arg, values) => `list_has_any(string_split(CAST(${arg} AS VARCHAR), '|'), [${values.join(", ")}])`,
  epoch: (arg, unit) => `epoch_ms(CAST(${arg} AS BIGINT)${unit === "epoch_s" ? " * 1000" : ""})`,
  // DuckDB accepts numbered parameters, so both dialects bind the same way.
  param: (i) => `$${i}`,
  // The node binding narrows a JS integer past 32 bits to INTEGER, so large
  // integers (epoch milliseconds) are bound as BigInt.
  paramValue: (v) => (v instanceof Date ? v.toISOString().replace("T", " ").replace("Z", "") : typeof v === "number" && Number.isInteger(v) && Math.abs(v) > 2_147_483_647 ? BigInt(v) : v),
};

export const printDuckdb: (ast: Ast) => Printed = printerFor(duckdbRules);
