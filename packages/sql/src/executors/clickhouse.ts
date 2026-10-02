import type { SourceSchema } from "@lenspack/engine";

import { type Executor, type ExecutorOptions, type Row, type Writer, DEFAULT_MAX_ROWS, capRows, collectSchema, timeoutOf } from "../executor";

// ClickHouse over its HTTP interface, with fetch and no client library. The
// guards are server settings sent with every statement: readonly=2 (reads
// only; settings may still be passed), max_execution_time, and a row cap
// that throws rather than truncating. The HTTP interface takes one
// statement per request.
//
// The rest make ClickHouse answer the way the other dialects do: an outer
// join's missing side is NULL rather than a default value, an aggregate over
// no rows is NULL rather than 0, a cast keeps NULL, and times are UTC.

export const CLICKHOUSE_SESSION: Record<string, string> = {
  join_use_nulls: "1",
  aggregate_functions_null_for_empty: "1",
  cast_keep_nullable: "1",
  session_timezone: "UTC",
  output_format_json_quote_64bit_integers: "0",
  output_format_json_quote_decimals: "0",
};

type Target = { base: string; database: string; headers: Record<string, string> };

/** clickhouse://user:password@host:8123/database; ?secure=true for HTTPS (port 8443 by default). */
export function clickhouseTarget(url: string): Target {
  const u = new URL(url.replace(/^clickhouse:/i, "http:"));
  const secure = u.searchParams.get("secure") === "true";
  const port = u.port || (secure ? "8443" : "8123");
  const headers: Record<string, string> = {};
  if (u.username) headers["X-ClickHouse-User"] = decodeURIComponent(u.username);
  if (u.password) headers["X-ClickHouse-Key"] = decodeURIComponent(u.password);
  return { base: `${secure ? "https" : "http"}://${u.hostname}:${port}`, database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "default", headers };
}

async function post(target: Target, sql: string, settings: Record<string, string>, timeoutMs: number): Promise<string> {
  const qs = new URLSearchParams({ database: target.database, ...settings });
  const res = await fetch(`${target.base}/?${qs}`, { method: "POST", body: sql, headers: target.headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim().replace(/\s+\(version [^)]*\)$/, "").slice(0, 600));
  return text;
}

export function clickhouseExecutor(target: Target, opts: ExecutorOptions = {}): Executor {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  return {
    dialect: "clickhouse",
    async query(sql, params, o) {
      const timeout = timeoutOf(o, opts);
      const settings: Record<string, string> = {
        ...CLICKHOUSE_SESSION,
        default_format: "JSON",
        readonly: "2",
        max_execution_time: String(timeout / 1000),
        max_result_rows: String(maxRows),
        result_overflow_mode: "throw",
      };
      params.forEach((v, i) => (settings[`param_p${i + 1}`] = String(v)));
      let text: string;
      try {
        // The client's own timer backs up the server's.
        text = await post(target, sql, settings, timeout + 2000);
      } catch (e) {
        if (/TOO_MANY_ROWS|Limit for result exceeded/.test(String(e))) throw new Error(`The statement returned more than ${maxRows} rows, the row cap for this source`);
        throw e;
      }
      return capRows(JSON.parse(text).data as Row[], maxRows);
    },
  };
}

/** Seeding and examples only. Rows go in as JSONCompactEachRow, in the order of `columns`. */
export function clickhouseWriter(target: Target): Writer {
  const plain = (v: unknown) => (typeof v === "bigint" ? Number(v) : v);
  return {
    async exec(sql) {
      const text = await post(target, sql, { ...CLICKHOUSE_SESSION }, 120_000);
      return text.trim() ? text.trim().split("\n").map((line) => ({ line })) : [];
    },
    async insert(table, columns, rows) {
      for (let i = 0; i < rows.length; i += 50_000) {
        const body = rows.slice(i, i + 50_000).map((r) => JSON.stringify(r.map(plain))).join("\n");
        await post(target, `INSERT INTO ${table} (${columns.join(", ")}) FORMAT JSONCompactEachRow\n${body}`, {}, 120_000);
      }
    },
  };
}

export async function introspectClickhouse(executor: Executor): Promise<SourceSchema> {
  const columns = await executor.query(`SELECT table AS t, name, type FROM system.columns WHERE database = currentDatabase() ORDER BY table, position`, []);
  const estimates = await executor.query(`SELECT name AS t, total_rows AS n FROM system.tables WHERE database = currentDatabase()`, []);
  return collectSchema(columns, estimates);
}

export async function openClickhouse(url: string, opts: ExecutorOptions = {}) {
  const target = clickhouseTarget(url);
  const executor = clickhouseExecutor(target, opts);
  return {
    dialect: "clickhouse" as const,
    executor,
    writer: clickhouseWriter(target),
    target,
    introspect: () => introspectClickhouse(executor),
    close: async () => undefined,
  };
}
