import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Tool } from "../tools";

/** Registers every tool on an MCP server; results are returned as JSON text. */
export function toMcp(server: McpServer, tools: Tool[]) {
  for (const t of tools) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema.shape }, async (args: unknown) => {
      const result = await t.execute(args as never);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    });
  }
  return server;
}

export function createMcpServer(tools: Tool[], info = { name: "lenspack", version: "0.1.0" }) {
  return toMcp(new McpServer(info), tools);
}
