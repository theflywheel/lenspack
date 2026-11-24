import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

// The few HTTP helpers every lenspack server shares: no framework, node:http as it is.

export const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** A request body over the size a route takes. */
export class BodyTooLarge extends Error {
  constructor() {
    super("body too large");
  }
}

/** The raw request body; over max bytes, it rejects with BodyTooLarge and the request is dropped. */
export const readBody = (req: IncomingMessage, max = Infinity) =>
  new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer | string) => {
      const b = Buffer.from(c);
      size += b.length;
      if (size > max) {
        reject(new BodyTooLarge());
        req.destroy();
      } else parts.push(b);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

/** A JSON request body; an empty one is {}. */
export const readJson = async (req: IncomingMessage, max?: number): Promise<unknown> => {
  const s = (await readBody(req, max)).toString("utf8");
  return s ? JSON.parse(s) : {};
};

export const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A value as a script's JSON literal: "<" is escaped, so no value can end the script. */
export const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/**
 * A file from a built client, index.html for any path that is not one (a
 * single-page app's routes). `page` rewrites index.html on its way out.
 */
export function serveStatic(root: string, pathname: string, res: ServerResponse, page?: (html: string) => string) {
  // Resolved first: join() would normalise a root like "../dist", and the containment check would then never match.
  const base = resolve(root);
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(base, safe);
  const inside = file === base || file.startsWith(base + sep);
  if (!inside || !existsSync(file) || statSync(file).isDirectory()) file = join(base, "index.html");
  if (!existsSync(file)) return json(res, 404, { error: "not found" });
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(page && file.endsWith("index.html") ? page(readFileSync(file, "utf8")) : readFileSync(file));
}
