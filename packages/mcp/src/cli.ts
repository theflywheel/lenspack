#!/usr/bin/env node
import { createServer } from "node:http";
import { dirname, join } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadPack } from "@lenspack/spec";
import { sqlStore } from "@lenspack/sql";

import { createMcpServer } from "./adapters/mcp";
import { fileProposals } from "./proposals";
import { boardTools } from "./tools";

// lenspack-mcp --pack ./pack.yaml --db postgres://… | ./data.duckdb [--board id] [--tenant t] [--run-sql] [--http 8787]

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const packPath = arg("pack");
  const dbUrl = arg("db");
  if (!packPath || !dbUrl || flag("help")) {
    console.error("usage: lenspack-mcp --pack <pack.yaml> --db <postgres://…|file.duckdb> [--board <id>] [--tenant <t>] [--run-sql] [--http <port>]");
    process.exit(flag("help") ? 0 : 2);
  }

  const pack = await loadPack(packPath);
  const db = dbUrl.startsWith("postgres") ? await (await import("@lenspack/sql/pg")).openPostgres(dbUrl) : await (await import("@lenspack/sql/duckdb")).openDuckdb(dbUrl);
  const store = sqlStore(db);
  await store.migrate();

  const boardId = arg("board", "default")!;
  if (!(await store.get(boardId))) await store.create({ id: boardId, pack, title: `${pack.pack} board` });

  const tools = boardTools({
    pack,
    executor: db.executor,
    store,
    boardId,
    ctx: { tenant: arg("tenant") },
    runSql: flag("run-sql"),
    proposals: fileProposals(join(dirname(packPath), `${pack.pack}.proposals.json`)),
  });

  const port = arg("http");
  if (port) {
    // Stateless streamable HTTP: one server per request keeps this simple and
    // safe behind a load balancer.
    const http = createServer(async (req, res) => {
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      const server = createMcpServer(tools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    http.listen(Number(port), () => console.error(`lenspack-mcp: pack ${pack.pack}, board ${boardId}, http://localhost:${port}/mcp`));
    return;
  }

  const server = createMcpServer(tools);
  await server.connect(new StdioServerTransport());
  console.error(`lenspack-mcp: pack ${pack.pack}, board ${boardId}, stdio`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
