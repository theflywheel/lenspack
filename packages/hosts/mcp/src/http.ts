import { createHash, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { Tool } from "@lenspack/agent";

import { isLoopback } from "./options";
import { createMcpServer } from "./server";

// Streamable HTTP at /mcp. Without a token this is a tool for one person on
// one machine: it listens on loopback only, and it refuses a request whose
// Host is not a loopback name or whose Origin is not its own, so a web page
// open in that person's browser cannot drive it (DNS rebinding, cross-site
// POSTs). Listening anywhere else needs a bearer token, checked on every
// request. Clients other than browsers send no Origin and are not affected.

export type HttpOptions = {
  port: number;
  /** Default 127.0.0.1. Any address that is not loopback requires `token`. */
  host?: string;
  /** Every request must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** Browser origins allowed besides the server's own (http://localhost:<port> and the like). */
  allowedOrigins?: string[];
};

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Why a request is refused (status and message), or null when it may go through. */
export function refusal(req: Pick<IncomingMessage, "headers">, o: { host: string; port: number; token?: string; allowedOrigins?: string[] }): { status: number; message: string } | null {
  const loopback = isLoopback(o.host);
  if (loopback) {
    // The name the client used to reach us. A rebound DNS name arrives here with its own name.
    const name = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!isLoopback(name)) return { status: 403, message: "This server answers only to localhost" };
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const own = loopback ? ["localhost", "127.0.0.1", "[::1]"] : [o.host.includes(":") && !o.host.startsWith("[") ? `[${o.host}]` : o.host];
    const allowed = new Set([...own.map((h) => `http://${h}:${o.port}`), ...(o.allowedOrigins ?? [])].map((u) => u.toLowerCase()));
    if (!allowed.has(origin.toLowerCase())) return { status: 403, message: `Origin ${origin} is not allowed` };
  }
  if (o.token !== undefined) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!m || !timingSafeEqual(digest(m[1]!.trim()), digest(o.token))) return { status: 401, message: "A valid bearer token is required" };
  }
  return null;
}

/** Serves the tools over streamable HTTP at /mcp. Resolves once listening, with the URL it can be reached at. */
export async function serveHttp(tools: Tool[], opts: HttpOptions): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  if (!isLoopback(host) && !opts.token) throw new Error(`Listening on ${host} lets other machines reach this server; it needs a bearer token`);
  let port = opts.port;
  const http = createServer(async (req, res) => {
    if ((req.url ?? "").split("?")[0] !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const refused = refusal(req, { host, port, token: opts.token, allowedOrigins: opts.allowedOrigins });
    if (refused) {
      res.writeHead(refused.status, { "content-type": "application/json", ...(refused.status === 401 ? { "www-authenticate": "Bearer" } : {}) });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: refused.message }, id: null }));
      return;
    }
    // Stateless: a server per request. The board itself lives in the store,
    // so requests share it; each request only re-registers the tools.
    try {
      const server = createMcpServer(tools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  port = (http.address() as AddressInfo).port;
  const shown = host.includes(":") ? `[${host}]` : host;
  return {
    server: http,
    url: `http://${shown}:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
