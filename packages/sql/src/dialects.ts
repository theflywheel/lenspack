import { SQL_CAPABILITIES, type Capabilities } from "@lenspack/engine";

import { type Ast } from "./ast";
import { type Dialect, type DialectRules, type Printed, printerFor } from "./print/base";
import { clickhouseRules } from "./print/clickhouse";
import { duckdbRules } from "./print/duckdb";
import { mysqlRules } from "./print/mysql";
import { postgresRules } from "./print/postgres";
import { sqliteRules } from "./print/sqlite";

// Dialects by name. A driver brings its own rules, and registering them is
// all it takes for the compiler to print for it.

const DIALECTS = new Map<string, { rules: DialectRules; print: (ast: Ast) => Printed }>();

export const registerDialect = (rules: DialectRules) => void DIALECTS.set(rules.dialect, { rules, print: printerFor(rules) });

for (const rules of [postgresRules, duckdbRules, mysqlRules, sqliteRules, clickhouseRules]) registerDialect(rules);

function registered(dialect: Dialect) {
  const found = DIALECTS.get(dialect);
  if (!found) throw new Error(`No SQL dialect "${dialect}" is registered; known: ${[...DIALECTS.keys()].join(", ")}`);
  return found;
}

export const dialectRules = (dialect: Dialect): DialectRules => registered(dialect).rules;
export const printFor = (dialect: Dialect): ((ast: Ast) => Printed) => registered(dialect).print;

/** What resolution refuses up front on this dialect. */
export function capabilitiesFor(dialect: Dialect): Capabilities {
  return { ...SQL_CAPABILITIES, ...dialectRules(dialect).capabilities };
}
