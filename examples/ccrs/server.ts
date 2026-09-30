// CCRS's dashboard on lenspack. The analytics API (/pgr-services/v2/analytics/*) is
// answered by lenspack from the compiled pack and boards; every other path —
// CCRS's own UI bundle, localization, MDMS, boundaries, login — is passed to
// the CCRS deployment unchanged. The page is CCRS's; only its numbers come
// from lenspack.
//
//   CCRS_PG_URL=postgres://… CCRS_UPSTREAM=https://ccrs.example.org PORT=8791 tsx examples/ccrs/server.ts
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type CcrsBoard, type Skin, ccrsApi } from "@lenspack/ccrs";
import { parsePackText } from "@lenspack/spec";
import { sqlConnector } from "@lenspack/sql";
import { openPostgres } from "@lenspack/sql/pg";

const here = dirname(fileURLToPath(import.meta.url));
const upstream = (process.env.CCRS_UPSTREAM ?? "").replace(/\/$/, "");
const port = Number(process.env.PORT ?? 8791);
// Local by default: put a TLS proxy in front to publish it.
const host = process.env.HOST ?? "127.0.0.1";
if (!process.env.CCRS_PG_URL || !upstream) throw new Error("CCRS_PG_URL and CCRS_UPSTREAM are required");

const pack = parsePackText(readFileSync(join(here, "pack.yaml"), "utf8"));
const skin = JSON.parse(readFileSync(join(here, "skin.json"), "utf8")) as Skin;
const boards: CcrsBoard[] = readdirSync(join(here, "boards"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    const id = f.replace(/\.json$/, "");
    const b = JSON.parse(readFileSync(join(here, "boards", f), "utf8")) as { layout: CcrsBoard["layout"]; tiles?: string[] };
    const meta = skin.packs[id] ?? { public: false };
    return { id, public: meta.public, requiredActionUrl: meta.requiredActionUrl, layout: b.layout, tiles: b.tiles ?? b.layout.map((l) => l.i) };
  })
  // CCRS picks the first pack a caller can see, in MDMS order.
  .sort((a, b) => Object.keys(skin.packs).indexOf(a.id) - Object.keys(skin.packs).indexOf(b.id));

const db = await openPostgres(process.env.CCRS_PG_URL);
const connector = sqlConnector(db.executor);

// A caller's row scope is CCRS's own resolution (HRMS departments and
// jurisdictions per role): ask it once per token with a one-row query and
// apply what it says. Cached briefly; the token is never logged or stored.
type Scope = { departments?: string[]; jurisdictions?: string[]; accountId?: string; restrictedTo?: string };
const scopes = new Map<string, { at: number; scope: Scope | null }>();
// The caller's own auth headers go with every call made on their behalf:
// CCRS resolves the principal from them as well as from RequestInfo.
const authHeaders = (request: unknown): Record<string, string> => {
  const h = (request as { headers?: Record<string, string | string[] | undefined> })?.headers ?? {};
  return Object.fromEntries(["authorization", "cookie", "x-tenant-id"].filter((k) => h[k]).map((k) => [k, String(h[k])]));
};

async function scopeOf(body: Record<string, unknown>, request?: unknown): Promise<Scope | null> {
  const info = body.RequestInfo as { authToken?: string; userInfo?: { uuid?: string } } | undefined;
  const key = `${info?.authToken ?? ""}|${authHeaders(request).authorization ?? ""}`;
  const hit = scopes.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.scope;
  // The same inline shape CCRS's own page sends for its filter menus.
  const probe = { RequestInfo: body.RequestInfo, tenantId: body.tenantId, queries: { scope: { grain: "facts", window: { name: "all" }, dimensions: ["ward_code"], measures: [{ name: "n", agg: "count" }], limit: 1 } } };
  const r = await fetch(`${upstream}/pgr-services/v2/analytics/_query`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(request) }, body: JSON.stringify(probe) });
  let scope: Scope | null = null;
  if (r.ok) {
    const s = ((await r.json()) as { scope?: Scope }).scope ?? {};
    scope = {
      ...(s.departments ? { departments: s.departments } : {}),
      ...(s.jurisdictions ? { jurisdictions: s.jurisdictions } : {}),
      ...(s.restrictedTo ? { restrictedTo: s.restrictedTo } : {}),
      ...(s.restrictedTo === "own-records" && info?.userInfo?.uuid ? { accountId: info.userInfo.uuid } : {}),
    };
  } else {
    // No scope, no rows: never widen what CCRS would show.
    console.warn(`[ccrs] scope probe answered ${r.status}; admitting no rows for this caller`);
    scope = { departments: [] };
  }
  scopes.set(key, { at: Date.now(), scope });
  console.log(`[ccrs] scope probe ${r.status}: ${scope ? `${scope.departments?.length ?? "all"} departments, ${scope.jurisdictions?.length ?? "all"} jurisdictions${scope.accountId ? ", own records" : ""}` : "none"}`);
  return scope;
}

const api = ccrsApi({
  pack,
  connector,
  skin,
  boards,
  tenant: process.env.CCRS_TENANT ?? "ke",
  // What a signed-in caller may see is CCRS's decision: ask its /_access with
  // the caller's own RequestInfo, and show exactly what it grants.
  capabilities: async (body, request) => {
    const r = await fetch(`${upstream}/pgr-services/v2/analytics/_access`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(request) }, body: JSON.stringify(body) });
    if (!r.ok) return [];
    const grant = (await r.json()) as { allowed?: boolean; capabilities?: string[] };
    return grant.allowed ? (grant.capabilities ?? []) : [];
  },
  scope: scopeOf,
});

const read = (req: import("node:http").IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"]);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    // The analytics base a CCRS build uses: /api/analytics by default, or
    // pgr-services' own path when REACT_APP_ANALYTICS_BASE names it.
    const m = /^\/(?:api\/analytics|pgr-services\/v2\/analytics)(\/.*)$/.exec(url.pathname);
    if (m && req.method === "POST") {
      const raw = await read(req);
      const out = await api(m[1]!, raw.length ? JSON.parse(raw.toString("utf8")) : {}, req);
      res.writeHead(out.status, { "content-type": "application/json", "x-served-by": "lenspack" });
      return res.end(JSON.stringify(out.body));
    }
    // Everything else is CCRS's own.
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await read(req);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)).map(([k, v]) => [k, String(v)]));
    const r = await fetch(`${upstream}${url.pathname}${url.search}`, { method: req.method, headers, body, redirect: "manual" });
    const out: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (!HOP.has(k)) out[k] = v;
    });
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad_gateway", message: e instanceof Error ? e.message : String(e) }));
  }
}).listen(port, host, () => console.log(`CCRS dashboard on lenspack: http://${host}:${port}/digit-ui/public-dashboard.html (analytics by lenspack, everything else from ${upstream})`));
