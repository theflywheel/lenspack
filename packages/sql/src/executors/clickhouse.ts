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
  // Exact distincts whatever the server profile says, a timeout that fails rather than
  // returning part of an answer, and a query that stops when lenspack's own timer gives up.
  count_distinct_implementation: "uniqExact",
  timeout_overflow_mode: "throw",
  cancel_http_readonly_queries_on_client_close: "1",
};

// Resource settings a source URL may pin for every statement (?max_memory_usage=…&max_threads=1),
// for a server shared with other work. `max_concurrent` is not a setting: it caps the statements
// this source has in flight at once (default 2), since a board draws all its widgets together.
const PINNABLE = ["max_memory_usage", "max_threads", "final", "max_bytes_before_external_group_by", "max_bytes_before_external_sort"];

type Target = { base: string; database: string; headers: Record<string, string>; pins: Record<string, string>; maxConcurrent: number };

/** clickhouse://user:password@host:8123/database; ?secure=true for HTTPS (port 8443 by default). */
export function clickhouseTarget(url: string): Target {
  const u = new URL(url.replace(/^clickhouse:/i, "http:"));
  const secure = u.searchParams.get("secure") === "true";
  const port = u.port || (secure ? "8443" : "8123");
  const headers: Record<string, string> = {};
  if (u.username) headers["X-ClickHouse-User"] = decodeURIComponent(u.username);
  if (u.password) headers["X-ClickHouse-Key"] = decodeURIComponent(u.password);
  const pins: Record<string, string> = {};
  for (const k of PINNABLE) if (u.searchParams.has(k)) pins[k] = u.searchParams.get(k)!;
  const maxConcurrent = Number(u.searchParams.get("max_concurrent") ?? 2);
  return { base: `${secure ? "https" : "http"}://${u.hostname}:${port}`, database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "default", headers, pins, maxConcurrent };
}

async function post(target: Target, sql: string, settings: Record<string, string>, timeoutMs: number): Promise<string> {
  const qs = new URLSearchParams({ database: target.database, ...settings });
  const res = await fetch(`${target.base}/?${qs}`, { method: "POST", body: sql, headers: target.headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(errorText(text).replace(/\s+\(version [^)]*\)$/, "").slice(0, 600));
  return text;
}

// The server writes an error in the output format when it can (http_write_exception_in_output_format):
// a JSON body with an "exception" field rather than plain text.
function errorText(text: string): string {
  try {
    const e = (JSON.parse(text) as { exception?: unknown }).exception;
    if (typeof e === "string") return e.trim();
  } catch {
    // plain text
  }
  return text.trim();
}

function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export function clickhouseExecutor(target: Target, opts: ExecutorOptions = {}): Executor {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const slot = limiter(Math.max(1, target.maxConcurrent || 2));
  return {
    dialect: "clickhouse",
    async query(sql, params, o) {
      const timeout = timeoutOf(o, opts);
      const settings: Record<string, string> = {
        ...CLICKHOUSE_SESSION,
        ...target.pins,
        default_format: "JSON",
        readonly: "2",
        max_execution_time: String(timeout / 1000),
        max_result_rows: String(maxRows),
        result_overflow_mode: "throw",
      };
      params.forEach((v, i) => (settings[`param_p${i + 1}`] = String(v)));
      let text: string;
      try {
        // The client's own timer backs up the server's, and it starts before the wait for a slot.
        const deadline = Date.now() + timeout + 2000;
        text = await slot(async () => {
          const left = deadline - Date.now();
          if (left <= 0) throw new Error(`No connection to this source was free within ${timeout} ms`);
          return post(target, sql, settings, left);
        });
      } catch (e) {
        if (/TOO_MANY_ROWS|Limit for result exceeded/.test(String(e))) throw new Error(`The statement returned more than ${maxRows} rows, the row cap for this source`);
        throw e;
      }
      // An error after the first rows were sent still comes with status 200, in the body.
      const body = JSON.parse(text) as { data: Row[]; exception?: string };
      if (body.exception) throw new Error(body.exception.trim().slice(0, 600));
      return capRows(body.data, maxRows);
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
