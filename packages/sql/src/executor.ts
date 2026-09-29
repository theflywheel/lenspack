import type { BoundPlan, Connector, Plan, Row } from "@lenspack/engine";
import { SQL_CAPABILITIES, shapeRows } from "@lenspack/engine";
import type { Pack } from "@lenspack/spec";

import { type Compiled, printPlan } from "./compile";
import type { Dialect } from "./print/base";

// The executor is the only thing that touches a database. Read-only and a
// statement timeout are its responsibility, never the SQL's.

export type { Row };

export interface Executor {
  readonly dialect: Dialect;
  query(sql: string, params: unknown[], opts?: { timeoutMs?: number }): Promise<Row[]>;
}

/** Writes, for seeding examples and for the SQL board store. Never handed to the model. */
export interface Writer {
  exec(sql: string, params?: unknown[]): Promise<Row[]>;
}

/** Postgres or DuckDB as a lenspack connector: compile to SQL, run read-only. */
export function sqlConnector(executor: Executor): Connector & { executor: Executor } {
  return {
    kind: executor.dialect,
    capabilities: SQL_CAPABILITIES,
    executor,
    compile(bound: BoundPlan, pack: Pack): Plan {
      const compiled = printPlan(bound, pack, executor.dialect);
      return { text: compiled.sql, native: compiled, bound };
    },
    async execute(plan, opts) {
      const compiled = plan.native as Compiled;
      const raw = await executor.query(compiled.sql, compiled.params, opts);
      const def = compiled.bound.measure?.def;
      return shapeRows(raw, compiled.bound.query, def?.format ?? "number", def?.key);
    },
  };
}
