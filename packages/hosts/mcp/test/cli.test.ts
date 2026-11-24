import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openSource } from "@lenspack/sql";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { openSqlite } from "@lenspack/sql/sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMcpServer } from "../src";
import { refusal, serveHttp } from "../src/http";
import { dataUrl, openData, openMcp } from "../src/open";
import { UsageError, isLoopback, parseCli } from "../src/options";

// What the lenspack-mcp command does with its arguments, tested through the
// same functions the command calls: how it opens the data (read-only, no
// other file reachable from SQL), where it keeps boards, and who its HTTP
// server answers.

const dir = mkdtempSync(join(tmpdir(), "lenspack-mcp-"));
const data = join(dir, "data.duckdb");
const packFile = join(dir, "pack.yaml");
const secretCsv = join(dir, "secret.csv");
const secretParquet = join(dir, "secret.parquet");
const other = join(dir, "other.duckdb");

writeFileSync(
  packFile,
  `pack: plain
version: 1
entities:
  items: { source: items, grain: one row per item }
dimensions:
  - { key: colour, entity: items, sql: colour }
measures:
  - { key: items, entity: items, agg: count }
`,
);

beforeAll(async () => {
  writeFileSync(secretCsv, "secret\nhunter2\n");
  // The data file, plus files a model must not be able to read through it.
  const db = await openDuckdb(data);
  await db.writer.exec(`CREATE TABLE items (id INTEGER, colour VARCHAR)`);
  await db.writer.exec(`INSERT INTO items VALUES (1, 'red'), (2, 'blue')`);
  await db.writer.exec(`COPY (SELECT 'hunter2' AS secret) TO '${secretParquet}' (FORMAT parquet)`);
  await db.close();
  const o = await openDuckdb(other);
  await o.writer.exec(`CREATE TABLE stolen AS SELECT 1 AS x`);
  await o.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as { ok?: boolean; error?: string; rows?: unknown[] };

describe("lenspack-mcp arguments", () => {
  it("needs --pack and --db, and refuses an unknown flag or a flag missing its value", () => {
    expect(() => parseCli(["--pack", "p.yaml"])).toThrow(UsageError);
    expect(() => parseCli(["--pack", "p.yaml", "--db", "d.duckdb", "--nope"])).toThrow(UsageError);
    // Used to fall back to stdio without a word.
    expect(() => parseCli(["--pack", "p.yaml", "--db", "d.duckdb", "--http"])).toThrow(UsageError);
    expect(() => parseCli(["--pack", "p.yaml", "--db", "d.duckdb", "--http", "web"])).toThrow(/port number/);
    expect(parseCli(["--help"])).toBe("help");
  });

  it("serves HTTP on 127.0.0.1 unless told otherwise, with no token needed there", () => {
    expect(parseCli(["--pack", "p", "--db", "d", "--http", "8787"], {})).toMatchObject({ http: { port: 8787, host: "127.0.0.1", token: undefined } });
    expect(parseCli(["--pack", "p", "--db", "d", "--http", "8787", "--host", "localhost"], {})).toMatchObject({ http: { host: "localhost" } });
  });

  it("refuses to listen on any other address without a token, from --token or LENSPACK_MCP_TOKEN", () => {
    const args = ["--pack", "p", "--db", "d", "--http", "8787", "--host", "0.0.0.0"];
    expect(() => parseCli(args, {})).toThrow(/needs a bearer token/);
    expect(() => parseCli(args, { LENSPACK_MCP_TOKEN: "" })).toThrow(/needs a bearer token/);
    expect(() => parseCli([...args, "--token", "short"], {})).toThrow(/too short/);
    const token = "0123456789abcdef0123";
    expect(parseCli([...args, "--token", token], {})).toMatchObject({ http: { host: "0.0.0.0", token } });
    expect(parseCli(args, { LENSPACK_MCP_TOKEN: token })).toMatchObject({ http: { host: "0.0.0.0", token } });
  });

  it("refuses HTTP-only flags without --http, and both run_sql flags at once", () => {
    expect(() => parseCli(["--pack", "p", "--db", "d", "--host", "0.0.0.0"], {})).toThrow(/only apply with --http/);
    expect(() => parseCli(["--pack", "p", "--db", "d", "--run-sql", "--run-sql-role-scoped"], {})).toThrow(/not both/);
  });

  it("knows a loopback address", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopback(h), h).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com", "localhost.evil.com", "127.0.0.1.evil.com"]) expect(isLoopback(h), h).toBe(false);
  });
});

describe("lenspack-mcp data", () => {
  let served: Awaited<ReturnType<typeof openMcp>>;
  let client: Client;
  const runSql = async (sql: string) => text(await client.callTool({ name: "run_sql", arguments: { sql } }));

  beforeAll(async () => {
    served = await openMcp({ pack: packFile, db: data, board: "default", runSql: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([createMcpServer(served.tools).connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
    await served.close();
  });

  it("answers run_sql from the data", async () => {
    expect(await runSql("SELECT count(*) AS n FROM items")).toMatchObject({ ok: true, rows: [{ n: 2 }] });
  });

  it.each([
    ["read_csv", `SELECT * FROM read_csv('${secretCsv}')`],
    ["read_csv_auto", `SELECT * FROM read_csv_auto('/etc/passwd')`],
    ["a file named as a table", `SELECT * FROM '${secretCsv}'`],
    ["read_parquet", `SELECT * FROM read_parquet('${secretParquet}')`],
    ["read_text", `SELECT * FROM read_text('/etc/hostname')`],
    ["read_blob", `SELECT * FROM read_blob('${secretCsv}')`],
    ["glob", `SELECT * FROM glob('${dir}/*')`],
  ])("run_sql cannot read another file: %s", async (_, sql) => {
    const r = await runSql(sql);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/file system operations are disabled/);
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  // Three layers stand in the way of each statement below. run_sql refuses
  // anything not shaped as a SELECT; the source's executor runs only a
  // statement DuckDB prepares as a SELECT; and the database itself is opened
  // read-only with file access off and its configuration locked. The last is
  // checked on the raw connection, past both of the others.
  let opened: Awaited<ReturnType<typeof openData>> | undefined;
  let raw: Awaited<ReturnType<typeof openSource>> | undefined;
  const executor = () => opened!.connector.executor;
  beforeAll(async () => {
    // Two more read-only opens of the same file, as the command opens it.
    opened = await openData(data);
    raw = await openSource(dataUrl(data));
  });
  afterAll(async () => {
    await opened?.close();
    await raw?.connection.close();
  });

  const sandbox = /file system operations are disabled|disabled through configuration|configuration has been locked/;
  const readOnly = /read-only/;
  it.each([
    ["COPY to a file", `COPY items TO '${join(dir, "out.csv")}'`, sandbox],
    ["COPY from a file", `COPY items FROM '${secretCsv}'`, sandbox],
    ["ATTACH another database", `ATTACH '${other}' AS o`, sandbox],
    ["INSTALL an extension", `INSTALL httpfs`, sandbox],
    ["LOAD an extension", `LOAD httpfs`, sandbox],
    ["turn file access back on", `SET enable_external_access = true`, sandbox],
    ["unlock the configuration", `SET lock_configuration = false`, sandbox],
    ["INSERT", `INSERT INTO items VALUES (3, 'green')`, readOnly],
    ["CREATE", `CREATE TABLE more (x INTEGER)`, readOnly],
    ["DROP", `DROP TABLE items`, readOnly],
  ])("nothing will %s: not run_sql, the source's executor or the database", async (_, sql, why) => {
    expect((await runSql(sql)).ok).toBe(false);
    // COPY fails as it is prepared, before the SELECT check, because it names a file.
    await expect(executor().query(sql, [])).rejects.toThrow(/Only a SELECT|file system operations are disabled/);
    await expect(raw!.connection.writer!.exec(sql)).rejects.toThrow(why);
  });

  it("changed nothing and wrote no file", async () => {
    expect(existsSync(join(dir, "out.csv"))).toBe(false);
    expect(await runSql("SELECT count(*) AS n FROM items")).toMatchObject({ ok: true, rows: [{ n: 2 }] });
  });

  it("keeps boards in their own file next to the pack, never in the data", async () => {
    expect(served.store).toBe(join(dir, "plain.boards.duckdb"));
    expect(existsSync(join(dir, "plain.boards.duckdb"))).toBe(true);
    const r = await client.callTool({ name: "add_widget", arguments: { id: "items", kind: "kpi", title: "Items", query_kind: "value", measure: "items" } });
    expect(text(r)).toMatchObject({ applied: true });
    const tables = await executor().query(`SELECT table_name AS t FROM information_schema.tables WHERE table_catalog = current_database()`, []);
    expect(tables.map((t) => t.t)).toEqual(["items"]);
  });

  it("refuses a board store that is the data file, and a data file that does not exist", async () => {
    await expect(openMcp({ pack: packFile, db: data, store: data, board: "b", runSql: false })).rejects.toThrow(/store is the data file/);
    await expect(openMcp({ pack: packFile, db: `duckdb:${data}`, store: `duckdb:${data}`, board: "b", runSql: false })).rejects.toThrow(/store is the data file/);
    await expect(openMcp({ pack: packFile, db: join(dir, "missing.duckdb"), store: "memory", board: "b", runSql: false })).rejects.toThrow(/No database file/);
    expect(existsSync(join(dir, "missing.duckdb"))).toBe(false);
  });

  it("reads no file from an in-memory DuckDB either", async () => {
    const mem = await openData("duckdb::memory:");
    try {
      await expect(mem.connector.executor.query(`SELECT * FROM read_csv('${secretCsv}')`, [])).rejects.toThrow(/file system operations are disabled/);
    } finally {
      await mem.close();
    }
  });

  it("opens other drivers through the same read-only path: a SQLite file", async () => {
    const file = join(dir, "data.sqlite");
    const w = await openSqlite(file);
    await w.writer.exec(`CREATE TABLE items (id INTEGER, colour TEXT)`);
    await w.writer.exec(`INSERT INTO items VALUES (1, 'red')`);
    await w.close();
    const s = await openMcp({ pack: packFile, db: `sqlite:${file}`, store: "memory", board: "b", runSql: true });
    try {
      const run = s.tools.find((t) => t.name === "run_sql")!;
      expect(await run.execute({ sql: "SELECT count(*) AS n FROM items" } as never)).toMatchObject({ ok: true, rows: [{ n: 1 }] });
      const sqlite = await openData(`sqlite:${file}`);
      await expect(sqlite.connector.executor.query("DELETE FROM items", [])).rejects.toThrow();
      await expect(sqlite.connector.executor.query(`ATTACH '${join(dir, "x.sqlite")}' AS x`, [])).rejects.toThrow();
      await sqlite.close();
      expect(await run.execute({ sql: "SELECT count(*) AS n FROM items" } as never)).toMatchObject({ ok: true, rows: [{ n: 1 }] });
    } finally {
      await s.close();
    }
  });
});

describe("lenspack-mcp over HTTP", () => {
  let served: Awaited<ReturnType<typeof openMcp>>;
  beforeAll(async () => {
    served = await openMcp({ pack: packFile, db: data, store: "memory", board: "default", runSql: false });
  });
  afterAll(async () => served.close());

  // A raw request, so the Host, Origin and Authorization headers are ours to set.
  const post = (url: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      const req = request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end(body);
    });

  it("listens on 127.0.0.1 by default, and serves an MCP client there", async () => {
    const http = await serveHttp(served.tools, { port: 0 });
    try {
      expect(http.server.address()).toMatchObject({ address: "127.0.0.1" });
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("add_widget");
      await client.close();
    } finally {
      await http.close();
    }
  });

  it("refuses a cross-site browser request and a rebound host name", async () => {
    const http = await serveHttp(served.tools, { port: 0 });
    const port = new URL(http.url).port;
    try {
      expect(await post(http.url, {})).toBe(200);
      expect(await post(http.url, { origin: `http://localhost:${port}` })).toBe(200);
      expect(await post(http.url, { origin: "https://evil.example" })).toBe(403);
      expect(await post(http.url, { origin: `http://localhost:${Number(port) + 1}` })).toBe(403);
      expect(await post(http.url, { origin: "null" })).toBe(403);
      // DNS rebinding: evil.example now resolves to 127.0.0.1, and the browser says so in Host.
      expect(await post(http.url, { host: `evil.example:${port}` })).toBe(403);
      expect(await post(http.url, { host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).toBe(403);
    } finally {
      await http.close();
    }
  });

  it("lets an origin in when it is allowed", async () => {
    const http = await serveHttp(served.tools, { port: 0, allowedOrigins: ["https://app.example.com"] });
    try {
      expect(await post(http.url, { origin: "https://app.example.com" })).toBe(200);
      expect(await post(http.url, { origin: "https://other.example.com" })).toBe(403);
    } finally {
      await http.close();
    }
  });

  it("will not listen on another address without a token, and checks the token on every request", async () => {
    await expect(serveHttp(served.tools, { port: 0, host: "0.0.0.0" })).rejects.toThrow(/needs a bearer token/);
    const token = "0123456789abcdef0123";
    const http = await serveHttp(served.tools, { port: 0, host: "0.0.0.0", token });
    const url = `http://127.0.0.1:${new URL(http.url).port}/mcp`;
    try {
      expect(http.server.address()).toMatchObject({ address: "0.0.0.0" });
      expect(await post(url, {})).toBe(401);
      expect(await post(url, { authorization: "Bearer wrong-token-0000000000" })).toBe(401);
      expect(await post(url, { authorization: `Basic ${token}` })).toBe(401);
      expect(await post(url, { authorization: `Bearer ${token}` })).toBe(200);
      // A token does not let a browser page in.
      expect(await post(url, { authorization: `Bearer ${token}`, origin: "https://evil.example" })).toBe(403);
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      await client.close();
    } finally {
      await http.close();
    }
  });

  it("checks a token on loopback too, when one is set", () => {
    const o = { host: "127.0.0.1", port: 8787, token: "0123456789abcdef0123" };
    expect(refusal({ headers: { host: "127.0.0.1:8787" } }, o)).toMatchObject({ status: 401 });
    expect(refusal({ headers: { host: "127.0.0.1:8787", authorization: `Bearer ${o.token}` } }, o)).toBeNull();
  });
});
