import type { Ast } from "../ast";
import { type DialectRules, type Printed, printerFor } from "./base";

// MySQL 8 and MariaDB 10.6+ share this dialect. Neither has date_trunc, a
// percentile aggregate (MariaDB's PERCENTILE_CONT is a window function only)
// or NULLS LAST, so those are spelled out or refused.

const quote = (id: string) => `\`${id.replace(/`/g, "``")}\``;
const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
const EPOCH = "TIMESTAMP '1970-01-01 00:00:00'";

export const mysqlRules: DialectRules = {
  dialect: "mysql",
  quote,
  cast: (to) => ({ double: "DOUBLE", text: "CHAR", timestamp: "DATETIME(3)", int: "SIGNED", bigint: "SIGNED" })[to],
  json: (col, path) => {
    if (path.length === 0) return `CAST(${col} AS CHAR)`;
    // JSON_UNQUOTE(JSON_EXTRACT()) rather than ->>, which MariaDB lacks.
    return `JSON_UNQUOTE(JSON_EXTRACT(${col}, ${lit(`$${path.map((s) => `."${s.replace(/"/g, '\\"')}"`).join("")}`)}))`;
  },
  trunc: (grain, arg) => {
    switch (grain) {
      case "hour":
        return `CAST(DATE_FORMAT(${arg}, '%Y-%m-%d %H:00:00') AS DATETIME)`;
      case "day":
        return `CAST(DATE(${arg}) AS DATETIME)`;
      case "week":
        return `CAST(DATE_SUB(DATE(${arg}), INTERVAL WEEKDAY(${arg}) DAY) AS DATETIME)`;
      case "month":
        return `CAST(DATE_FORMAT(${arg}, '%Y-%m-01') AS DATETIME)`;
      case "quarter":
        return `CAST(MAKEDATE(YEAR(${arg}), 1) + INTERVAL (QUARTER(${arg}) - 1) QUARTER AS DATETIME)`;
      case "year":
        return `CAST(MAKEDATE(YEAR(${arg}), 1) AS DATETIME)`;
    }
  },
  // Arithmetic from the epoch, not FROM_UNIXTIME, which reads the session time zone.
  epoch: (arg, unit) => (unit === "epoch_ms" ? `TIMESTAMPADD(MICROSECOND, CAST(${arg} AS SIGNED) * 1000, ${EPOCH})` : `TIMESTAMPADD(SECOND, CAST(${arg} AS SIGNED), ${EPOCH})`),
  // LOCATE finds the delimited value literally: no wildcard in it can widen the match.
  segment: (arg, values) => `(${values.map((v) => `LOCATE(CONCAT('|', ${v}, '|'), CONCAT('|', CAST(${arg} AS CHAR), '|')) > 0`).join(" OR ")})`,
  param: () => "?",
  paramValue: (v) => (v instanceof Date ? v.toISOString().replace("T", " ").replace("Z", "") : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "bigint" ? Number(v) : v),
  ops: {
    ILIKE: (l, r) => `(LOWER(${l}) LIKE LOWER(${r}))`,
    "IS DISTINCT FROM": (l, r) => `(NOT (${l} <=> ${r}))`,
  },
  // AVG of an exact value is a DECIMAL with four more places than its input, so
  // a rate over 0/1 would come back rounded to 0.0713; a double does not round.
  aggregate: { avg: (arg) => `avg(CAST(${arg} AS DOUBLE))` },
  // NULLs sort first ascending and last descending; only ascending needs help.
  // MariaDB cannot test an aggregate's alias for NULL, so the test repeats the expression.
  orderBy: (e, dir, selected) => (dir === "asc" ? `${selected ? selected() : e} IS NULL, ${e} ASC` : `${e} DESC`),
  capabilities: { percentiles: false },
};

export const printMysql: (ast: Ast) => Printed = printerFor(mysqlRules);
