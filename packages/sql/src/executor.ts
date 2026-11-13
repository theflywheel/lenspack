import type { BoundPlan, Connector, Plan, Row, SourceSchema } from "@lenspack/engine";
import { shapeRows } from "@lenspack/engine";
import type { Pack } from "@lenspack/spec";

import { type Compiled, printPlan } from "./compile";
import { capabilitiesFor } from "./dialects";
import type { Dialect } from "./print/base";

// The executor is the only thing that touches a database. Read-only, a single
// statement, a statement timeout and a row cap are its responsibility, never
// the SQL's: nothing a caller passes can remove them.

export type { Row };

export interface Executor {
  readonly dialect: Dialect;
  query(sql: string, params: unknown[], opts?: { timeoutMs?: number }): Promise<Row[]>;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
/** More rows than any compiled query asks for; a statement that returns more is refused. */
export const DEFAULT_MAX_ROWS = 100_000;

export type ExecutorOptions = { defaultTimeoutMs?: number; maxRows?: number };

export const timeoutOf = (o: { timeoutMs?: number } | undefined, opts: ExecutorOptions) => Math.max(100, Math.floor(o?.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS));

/** Refuses a result over the cap rather than truncating it: a cut-off answer would read as a whole one. */
export function capRows<T>(rows: T[], maxRows = DEFAULT_MAX_ROWS): T[] {
  if (rows.length > maxRows) throw new Error(`The statement returned more than ${maxRows} rows, the row cap for this source`);
  return rows;
}

/** Writes, for seeding examples and for the SQL board store. Never handed to the model. */
export interface Writer {
  exec(sql: string, params?: unknown[]): Promise<Row[]>;
  /**
   * Bulk rows into a table, in the form the database loads fastest. Writers
   * whose placeholders are not $1, $2 … provide it; table and columns are
   * already quoted as the caller wants them.
   */
  insert?(table: string, columns: string[], rows: unknown[][]): Promise<void>;
}

/**
 * Column rows (s, t, name, type) and row-count rows (s, t, n) → SourceSchema,
 * the shape every driver's introspection returns. The schema is left out of a
 * table's name when it is the default one; the board store's own tables,
 * should it share the database, are left out altogether.
 */
export function collectSchema(columns: Row[], estimates: Row[], defaultSchema = "public"): SourceSchema {
  const name = (r: Row) => (r.s && r.s !== defaultSchema ? `${String(r.s)}.${String(r.t)}` : String(r.t));
  const rows = new Map(estimates.filter((r) => r.n !== null && r.n !== undefined).map((r) => [name(r), Number(r.n)]));
  const tables = new Map<string, SourceSchema["collections"][number]>();
  for (const c of columns) {
    if (String(c.t).startsWith("lenspack_")) continue;
    const key = name(c);
    if (!tables.has(key)) {
      const n = rows.get(key);
      tables.set(key, { name: key, fields: [], ...(n !== undefined && Number.isFinite(n) && n >= 0 ? { rows: n } : {}) });
    }
    tables.get(key)!.fields.push({ path: String(c.name), type: String(c.type).toLowerCase() });
  }
  return { collections: [...tables.values()] };
}

/** Any SQL dialect as a lenspack connector: compile to SQL, run read-only. */
export function sqlConnector(executor: Executor, opts: { introspect?: () => Promise<SourceSchema>; close?: () => Promise<void> } = {}): Connector & { executor: Executor } {
  return {
    kind: executor.dialect,
    capabilities: capabilitiesFor(executor.dialect),
    executor,
    ...(opts.introspect ? { introspect: opts.introspect } : {}),
    ...(opts.close ? { close: opts.close } : {}),
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
