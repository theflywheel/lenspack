import type { Ast } from "../ast";
import { type DialectRules, type Printed, printerFor } from "./base";

// ClickHouse over its HTTP interface. Parameters are typed in the statement
// ({p1:String}), so the placeholder is chosen by the value it carries. The
// session settings that make its NULLs, empty aggregates and outer joins
// behave as the other dialects' do are the driver's (executors/clickhouse.ts).

const quote = (id: string) => `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const TS = "DateTime64(3, 'UTC')";

function typeOf(v: unknown): string {
  if (v instanceof Date) return TS;
  if (typeof v === "boolean") return "Bool";
  if (typeof v === "bigint") return "Int64";
  if (typeof v === "number") return Number.isInteger(v) ? "Int64" : "Float64";
  return "String";
}

export const clickhouseRules: DialectRules = {
  dialect: "clickhouse",
  quote,
  cast: (to) => ({ double: "Float64", text: "String", timestamp: TS, int: "Int32", bigint: "Int64" })[to],
  json: (col, path) => {
    if (path.length === 0) return `CAST(${col} AS String)`;
    return `JSONExtract(${col}, ${path.map(lit).join(", ")}, 'Nullable(String)')`;
  },
  // quantileExactInclusive interpolates as percentile_cont does (R-7).
  percentile: (fn, arg) => `quantileExactInclusive(${fn === "median" ? 0.5 : 0.9})(${arg})`,
  trunc: (grain, arg) => {
    const start = { hour: "toStartOfHour", day: "toStartOfDay", week: "toMonday", month: "toStartOfMonth", quarter: "toStartOfQuarter", year: "toStartOfYear" }[grain];
    return `toDateTime(${start}(${arg}), 'UTC')`;
  },
  epoch: (arg, unit) => `fromUnixTimestamp64Milli(CAST(${arg} AS Int64)${unit === "epoch_s" ? " * 1000" : ""}, 'UTC')`,
  segment: (arg, values) => `hasAny(splitByChar('|', ifNull(CAST(${arg} AS String), '')), [${values.join(", ")}])`,
  param: (i, v) => `{p${i}:${typeOf(v)}}`,
  // Values travel as URL parameters in ClickHouse's escaped text form.
  paramValue: (v) => {
    if (v instanceof Date) return v.toISOString().replace("T", " ").replace("Z", "");
    if (typeof v === "string") return v.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
    return String(v);
  },
  // IS [NOT] DISTINCT FROM is for JOIN ON only. The planner compares with a
  // bound value, never NULL, so "missing or different" says the same.
  ops: {
    "IS DISTINCT FROM": (l, r) => `(${l} IS NULL OR ${l} <> ${r})`,
  },
};

export const printClickhouse: (ast: Ast) => Printed = printerFor(clickhouseRules);
