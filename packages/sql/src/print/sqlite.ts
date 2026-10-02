import type { Ast } from "../ast";
import { type DialectRules, type Printed, printerFor } from "./base";

// SQLite keeps time as ISO text ("2026-01-05 10:00:00"), so buckets are text
// too and compare in the same order the instants do. It has no percentile
// aggregate, and its LIKE folds ASCII case only.

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Text in the form SQLite's date functions write, whole seconds unless there are milliseconds. */
export function sqliteTime(d: Date) {
  const iso = d.toISOString().replace("T", " ").replace("Z", "");
  return iso.endsWith(".000") ? iso.slice(0, 19) : iso;
}

export const sqliteRules: DialectRules = {
  dialect: "sqlite",
  quote,
  // A timestamp stays text: CAST(... AS TIMESTAMP) would take NUMERIC affinity and keep only the year.
  cast: (to) => ({ double: "REAL", text: "TEXT", timestamp: "TEXT", int: "INTEGER", bigint: "INTEGER" })[to],
  json: (col, path) => {
    if (path.length === 0) return `CAST(${col} AS TEXT)`;
    return `CAST(json_extract(${col}, ${lit(`$${path.map((s) => `."${s.replace(/"/g, '\\"')}"`).join("")}`)}) AS TEXT)`;
  },
  trunc: (grain, arg) => {
    switch (grain) {
      case "hour":
        return `strftime('%Y-%m-%d %H:00:00', ${arg})`;
      case "day":
        return `strftime('%Y-%m-%d 00:00:00', ${arg})`;
      case "week":
        // %w is 0 on Sunday; step back to Monday.
        return `strftime('%Y-%m-%d 00:00:00', ${arg}, '-' || ((CAST(strftime('%w', ${arg}) AS INTEGER) + 6) % 7) || ' days')`;
      case "month":
        return `strftime('%Y-%m-01 00:00:00', ${arg})`;
      case "quarter":
        return `printf('%s-%02d-01 00:00:00', strftime('%Y', ${arg}), ((CAST(strftime('%m', ${arg}) AS INTEGER) - 1) / 3) * 3 + 1)`;
      case "year":
        return `strftime('%Y-01-01 00:00:00', ${arg})`;
    }
  },
  epoch: (arg, unit) => `strftime('%Y-%m-%d %H:%M:%f', ${arg}${unit === "epoch_ms" ? " / 1000.0" : ""}, 'unixepoch')`,
  segment: (arg, values) => `(${values.map((v) => `instr('|' || CAST(${arg} AS TEXT) || '|', '|' || ${v} || '|') > 0`).join(" OR ")})`,
  param: () => "?",
  // The driver binds no booleans or Dates: SQLite stores neither.
  paramValue: (v) => (v instanceof Date ? sqliteTime(v) : typeof v === "boolean" ? (v ? 1 : 0) : v),
  ops: {
    ILIKE: (l, r) => `(LOWER(${l}) LIKE LOWER(${r}) ESCAPE '\\')`,
    LIKE: (l, r) => `(${l} LIKE ${r} ESCAPE '\\')`,
    "IS DISTINCT FROM": (l, r) => `(${l} IS NOT ${r})`,
  },
  capabilities: { percentiles: false },
};

export const printSqlite: (ast: Ast) => Printed = printerFor(sqliteRules);
