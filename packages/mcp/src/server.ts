import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Tool } from "@lenspack/agent";

/** An MCP server with every tool registered; results are returned as JSON text. */
export function createMcpServer(tools: Tool[], info = { name: "lenspack", version: "0.1.0" }) {
  const server = new McpServer(info);
  for (const t of tools)
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema.shape }, async (args: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(await t.execute(args as never), null, 2) }],
    }));
  return server;
}
