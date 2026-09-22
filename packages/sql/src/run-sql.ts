import type { Pack } from "@lenspack/spec";

import type { Executor, Row } from "./executor";

// The escape hatch, fenced. One statement, SELECT or WITH by shape, wrapped
// so the row cap and the timeout always apply. The application does no keyword
// filtering beyond shape, because a denylist cannot know what a function does;
// the executor's read-only transaction and the database role are the guards.
// Results are ephemeral: nothing here can become a widget.

export type RunSqlResult = { rows: Row[]; rowCount: number; truncated: boolean; sql: string };

export async function runSql(sql: string, executor: Executor, opts: { maxRows?: number; timeoutMs?: number } = {}): Promise<RunSqlResult> {
  const maxRows = opts.maxRows ?? 200;
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("Only SELECT or WITH queries are allowed");
  if (trimmed.includes(";")) throw new Error("One statement at a time");
  const wrapped = `SELECT * FROM (${trimmed}) AS q LIMIT ${maxRows + 1}`;
  const rows = await executor.query(wrapped, [], { timeoutMs: opts.timeoutMs ?? 15_000 });
  const truncated = rows.length > maxRows;
  return { rows: rows.slice(0, maxRows), rowCount: Math.min(rows.length, maxRows), truncated, sql: wrapped };
}

/** What the model may be told about the tables behind a pack: sources only. */
export function describeSources(pack: Pack) {
  return Object.entries(pack.entities)
    .map(([key, e]) => `${key}: ${e.source}${e.grain ? ` — ${e.grain}` : ""}${e.time ? ` (time: ${e.time})` : ""}`)
    .join("\n");
}
