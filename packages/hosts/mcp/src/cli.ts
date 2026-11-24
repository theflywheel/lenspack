#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { serveHttp } from "./http";
import { openMcp } from "./open";
import { USAGE, UsageError, parseCli } from "./options";
import { createMcpServer } from "./server";

// lenspack-mcp --pack ./pack.yaml --db postgres://… | ./data.duckdb [--store …] [--board id] [--tenant t]
//   [--run-sql | --run-sql-role-scoped] [--http 8787 [--host 127.0.0.1] [--token …] [--allow-origin …]]

async function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`lenspack-mcp: ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts === "help") {
    console.error(USAGE);
    process.exit(0);
  }

  const served = await openMcp(opts);
  const what = `pack ${served.pack}, board ${served.board} (kept in ${served.store})`;

  if (opts.http) {
    const { url } = await serveHttp(served.tools, opts.http);
    console.error(`lenspack-mcp: ${what}, ${url}${opts.http.token ? " (bearer token required)" : " (this machine only)"}`);
    return;
  }

  const server = createMcpServer(served.tools);
  await server.connect(new StdioServerTransport());
  console.error(`lenspack-mcp: ${what}, stdio`);
}

main().catch((e) => {
  console.error(`lenspack-mcp: ${(e as Error).message ?? e}`);
  process.exit(1);
});
