import { parseArgs } from "node:util";

// The lenspack-mcp command line. Parsed strictly: an unknown flag, or a flag
// missing its value, is an error rather than a quiet fallback to stdio.

export const USAGE = `usage: lenspack-mcp --pack <pack.yaml> --db <url | file.duckdb> [options]

  --db <url>              the data, opened read-only: postgres://…, mysql://…, clickhouse://…,
                          sqlite:<file>, duckdb:<file>, or a bare path to a DuckDB file
  --store <where>         where boards are kept, apart from the data: a DuckDB file, postgres://…,
                          or "memory" (default: <pack name>.boards.duckdb next to the pack)
  --board <id>            the board to edit (default: "default")
  --tenant <t>            the tenant every query is scoped to
  --run-sql               offer run_sql (raw read-only SQL) on a pack without tenant scoping
  --run-sql-role-scoped   offer run_sql where the database role already limits the rows
  --http <port>           serve streamable HTTP at /mcp instead of stdio
  --host <address>        the address --http listens on (default 127.0.0.1, this machine only);
                          any other address needs a token
  --token <token>         the bearer token every HTTP request must carry (or LENSPACK_MCP_TOKEN)
  --allow-origin <url>    a browser origin allowed to call the HTTP server (repeatable)`;

export type CliOptions = {
  pack: string;
  db: string;
  store?: string;
  board: string;
  tenant?: string;
  runSql: boolean | "role-scoped";
  http?: { port: number; host: string; token?: string; allowedOrigins: string[] };
};

export class UsageError extends Error {}

/** True for an address only this machine can reach. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h) || /^::ffff:127(\.\d{1,3}){3}$/.test(h);
}

/** The options a command line asks for, or a UsageError saying what is wrong. `help` when --help was asked. */
export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions | "help" {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        pack: { type: "string" },
        db: { type: "string" },
        store: { type: "string" },
        board: { type: "string" },
        tenant: { type: "string" },
        "run-sql": { type: "boolean" },
        "run-sql-role-scoped": { type: "boolean" },
        http: { type: "string" },
        host: { type: "string" },
        token: { type: "string" },
        "allow-origin": { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (values.help) return "help";
  if (!values.pack || !values.db) throw new UsageError("--pack and --db are required");
  if (values["run-sql"] && values["run-sql-role-scoped"]) throw new UsageError("pass --run-sql or --run-sql-role-scoped, not both");

  const opts: CliOptions = {
    pack: values.pack,
    db: values.db,
    store: values.store,
    board: values.board ?? "default",
    tenant: values.tenant,
    runSql: values["run-sql-role-scoped"] ? "role-scoped" : !!values["run-sql"],
  };

  const token = values.token ?? (env.LENSPACK_MCP_TOKEN || undefined);
  if (values.http === undefined) {
    if (values.host !== undefined || values.token !== undefined || values["allow-origin"]) throw new UsageError("--host, --token and --allow-origin only apply with --http");
    return opts;
  }
  const port = Number(values.http);
  if (!/^\d+$/.test(values.http) || port > 65535) throw new UsageError(`--http takes a port number, not "${values.http}"`);
  const host = values.host ?? "127.0.0.1";
  if (!isLoopback(host) && !token)
    throw new UsageError(
      `--host ${host} lets other machines reach this server, so it needs a bearer token: pass --token or set LENSPACK_MCP_TOKEN (or leave out --host to serve this machine only)`,
    );
  if (token !== undefined && token.length < 16) throw new UsageError("the token is too short: use at least 16 characters, e.g. from `openssl rand -hex 32`");
  for (const o of values["allow-origin"] ?? [])
    if (!/^https?:\/\/[^/]+$/.test(o)) throw new UsageError(`--allow-origin takes an origin like https://app.example.com (scheme and host, no path), not "${o}"`);
  opts.http = { port, host, token, allowedOrigins: values["allow-origin"] ?? [] };
  return opts;
}
