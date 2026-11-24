import { type BoardToolsOptions as AgentOptions, type RawSql, type Tool, boardTools as agentTools } from "@lenspack/agent";
import type { Pack } from "@lenspack/spec";
import { type Executor, describeSources, runSql, sqlConnector } from "@lenspack/sql";

export * from "@lenspack/agent";
export * from "./server";

/** run_sql over a SQL executor. */
export const sqlRawSql = (executor: Executor, pack: Pack): RawSql => ({ describe: describeSources(pack), run: (sql, opts) => runSql(sql, executor, opts) });

export type BoardToolsOptions = Omit<AgentOptions, "connector"> & {
  connector?: AgentOptions["connector"];
  /** @deprecated Pass `connector: sqlConnector(executor)` and, for run_sql, `rawSql: sqlRawSql(executor, pack)`. */
  executor?: Executor;
};

/** The agent's board tools, also accepting a bare SQL executor, from which run_sql is built too. */
export function boardTools({ executor, ...opts }: BoardToolsOptions): Tool[] {
  const connector = opts.connector ?? (executor ? sqlConnector(executor) : undefined);
  if (!connector) throw new Error("boardTools needs a connector (or a SQL executor)");
  const sql = executor ?? (connector as { executor?: Executor }).executor;
  return agentTools({ ...opts, connector, rawSql: opts.rawSql ?? (opts.runSql && sql ? sqlRawSql(sql, opts.pack) : undefined) });
}
