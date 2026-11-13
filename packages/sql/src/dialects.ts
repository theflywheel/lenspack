import { SQL_CAPABILITIES, type Capabilities } from "@lenspack/engine";
import { registerSqlDialect } from "@lenspack/spec";

import { type Ast } from "./ast";
import { type Dialect, type DialectRules, type Printed, printerFor } from "./print/base";
import { clickhouseRules } from "./print/clickhouse";
import { duckdbRules } from "./print/duckdb";
import { mysqlRules } from "./print/mysql";
import { postgresRules } from "./print/postgres";
import { sqliteRules } from "./print/sqlite";

// Dialects by name. A driver brings its own rules, and registering them is
// all it takes for the compiler to print for it and for a pack's per-dialect
// fragments to be read under that name.

const DIALECTS = new Map<string, { rules: DialectRules; print: (ast: Ast) => Printed }>();

export function registerDialect(rules: DialectRules) {
  DIALECTS.set(rules.dialect, { rules, print: printerFor(rules) });
  registerSqlDialect(rules.dialect);
}

for (const rules of [postgresRules, duckdbRules, mysqlRules, sqliteRules, clickhouseRules]) registerDialect(rules);

export function dialectRules(dialect: Dialect): DialectRules {
  const found = DIALECTS.get(dialect);
  if (!found) throw new Error(`No SQL dialect "${dialect}" is registered; known: ${[...DIALECTS.keys()].join(", ")}`);
  return found.rules;
}

export function printFor(dialect: Dialect): (ast: Ast) => Printed {
  dialectRules(dialect);
  return DIALECTS.get(dialect)!.print;
}

/** What resolution refuses up front on this dialect. */
export function capabilitiesFor(dialect: Dialect): Capabilities {
  return { ...SQL_CAPABILITIES, ...dialectRules(dialect).capabilities };
}
