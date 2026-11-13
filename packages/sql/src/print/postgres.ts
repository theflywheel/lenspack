import type { Ast } from "../ast";
import { type DialectRules, type Printed, printerFor } from "./base";

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

// Time is naive UTC (a timestamptz is cast through the session zone, as the
// window predicates compare it), then read as wall-clock time in the zone.
export const zoned = (arg: string, zone: string) => `(CAST(${arg} AS TIMESTAMP) AT TIME ZONE 'UTC') AT TIME ZONE ${lit(zone)}`;

export const postgresRules: DialectRules = {
  dialect: "postgres",
  quote,
  cast: (to) => ({ double: "DOUBLE PRECISION", text: "TEXT", timestamp: "TIMESTAMP", int: "INTEGER", bigint: "BIGINT" })[to],
  json: (col, path) => {
    // (col #>> ARRAY['a','b']) reads nested keys as text; a single key uses ->>.
    if (path.length === 0) return `CAST(${col} AS TEXT)`;
    if (path.length === 1) return `(${col} ->> ${lit(path[0]!)})`;
    return `(${col} #>> ARRAY[${path.map(lit).join(",")}])`;
  },
  percentile: (fn, arg) => `percentile_cont(${fn === "median" ? 0.5 : 0.9}) WITHIN GROUP (ORDER BY ${arg})`,
  trunc: (grain, arg) => `date_trunc('${grain}', ${arg})`,
  zonedTrunc: (grain, arg, zone) => `date_trunc('${grain}', ${zoned(arg, zone)})`,
  // The split-and-match form, which the planner estimates as it does CCRS's.
  segment: (arg, values) => `EXISTS (SELECT 1 FROM unnest(string_to_array(CAST(${arg} AS TEXT), '|')) AS seg WHERE seg IN (${values.join(", ")}))`,
  epoch: (arg, unit) => `(to_timestamp(${arg}${unit === "epoch_ms" ? " / 1000.0" : ""}) AT TIME ZONE 'UTC')`,
  param: (i) => `$${i}`,
  paramValue: (v) => (v instanceof Date ? v.toISOString() : v),
};

export const printPostgres: (ast: Ast) => Printed = printerFor(postgresRules);
