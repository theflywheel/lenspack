#!/usr/bin/env -S npx tsx
// Lenspack over Superset: the chat beside a Superset dashboard (in an iframe),
// or floating on Superset's own pages (one script tag in Superset's
// tail_js_custom_extra.html). Superset is not forked; it is the record for
// boards and the engine for numbers.
//
//   npx tsx --tsconfig tsconfig.base.json packages/superset/bin/serve.ts superset.yaml

import { mkdirSync, readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { memoryStore } from "@lenspack/core";
import { addUsageSink, buildProvider, createApp, probe, providersFromEnv, publicView, usageLedger } from "@lenspack/serve";
import YAML from "yaml";

import { type Overlay, fetchDatasets, packFromDatasets, supersetBoards, supersetClient, supersetConnector } from "../src/index";

type Config = {
  superset: {
    /** Where this server reaches Superset's API (in compose: http://superset:8088). */
    url: string;
    /** Where browsers reach Superset, when that differs from url (behind an ingress: https://superset.example.org). */
    publicUrl?: string;
    /** Superset's port as browsers see it, when publicUrl is not set (same host, another port). */
    publicPort?: number;
    username: string;
    passwordEnv?: string;
    password?: string;
  };
  /** Superset datasets by id, or by table name (schema.table or table). */
  datasets: (number | string)[];
  dashboards?: number[];
  overlay?: Overlay;
  host?: string;
  port?: number;
  /** The path browsers reach this server under, when a proxy mounts it below Superset's own host (/lenspack). */
  publicPath?: string;
  state?: string;
  budget?: { usdPerDay?: number; usdPerUserPerDay?: number };
};

const file = resolve(process.argv[2] ?? "superset.yaml");
const dir = dirname(file);
// Any string "env:NAME" in the config reads the environment variable NAME, so secrets and
// per-deployment URLs stay out of the file.
const fromEnv = (v: unknown): unknown => {
  if (typeof v === "string" && v.startsWith("env:")) {
    const value = process.env[v.slice(4)];
    if (value === undefined) throw new Error(`${file}: environment variable ${v.slice(4)} is not set`);
    return value;
  }
  if (Array.isArray(v)) return v.map(fromEnv);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromEnv(x)]));
  return v;
};
const config = fromEnv(YAML.parse(readFileSync(file, "utf8"))) as Config;
const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "web");
const log = (s: string) => console.error(`lenspack-superset: ${s}`);

const password = config.superset.password ?? process.env[config.superset.passwordEnv ?? "LENSPACK_SUPERSET_PASSWORD"];
if (!password) throw new Error("No Superset password: set superset.passwordEnv");
const client = supersetClient({ url: config.superset.url, username: config.superset.username, password });

const datasets = await fetchDatasets(client, config.datasets);
const { pack, packYaml, binding } = packFromDatasets(datasets, config.overlay);
log(`pack ${pack.pack}: ${Object.keys(pack.entities).length} datasets, ${pack.dimensions.length} dimensions, ${pack.measures.length} measures`);
const connector = supersetConnector(client, binding);

const statePath = resolve(dir, config.state ?? "state/superset-boards.json");
mkdirSync(dirname(statePath), { recursive: true });
const dashboards: Record<string, number> = Object.fromEntries((config.dashboards ?? []).map((d) => [`superset-${d}`, d]));
const store = supersetBoards({ inner: memoryStore(), client, pack, binding, dashboards, stateFile: statePath, log });
await store.seed();

const ledger = usageLedger();
addUsageSink(ledger);
const providers = providersFromEnv().map(buildProvider);
void Promise.all(providers.map((p) => probe(p))).then((probed) => probed.forEach((p, i) => (providers[i] = p)));
const roles = process.env.LENSPACK_LLM_ROLES ? JSON.parse(process.env.LENSPACK_LLM_ROLES) : undefined;
const api = createApp([{ name: pack.pack, pack, packYaml, connector, store, ctx: {}, boards: [] }], { providers, roles, ledger, budget: config.budget, log });

/** Binds a dashboard (by id or slug) to a board on first use, so the overlay works on any dashboard. */
async function bind(idOrSlug: string): Promise<{ board: string; dashboard: number; title: string; notes: string[] }> {
  const head = await client.get<{ result: { id: number; dashboard_title: string } }>(`/api/v1/dashboard/${encodeURIComponent(idOrSlug)}`);
  const id = head.result.id;
  const board = `superset-${id}`;
  if (dashboards[board] === undefined) {
    dashboards[board] = id;
    await store.pull(board, true);
    log(`bound dashboard ${id} (${head.result.dashboard_title})`);
  }
  return { board, dashboard: id, title: head.result.dashboard_title, notes: store.notes.get(board) ?? [] };
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };
const send = (res: ServerResponse, status: number, body: string, type = "application/json") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const base = (config.publicPath ?? "").replace(/\/+$/, "");
const page = (name: string, vars: Record<string, unknown>) =>
  readFileSync(join(web, name), "utf8")
    .replaceAll("__BASE__", base)
    .replace("/*__VARS__*/", `window.__lp=${JSON.stringify(vars).replace(/</g, "\\u003c")};`);

// The overlay runs on Superset's origin and calls this server: allow exactly
// that origin (publicUrl's, else the same host on Superset's port). Mounted
// under Superset's own host (publicPath), the calls are same-origin and need none of this.
function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const o = new URL(origin);
    const supersetPort = String(config.superset.publicPort ?? new URL(config.superset.url).port);
    const allowed = config.superset.publicUrl ? o.origin === new URL(config.superset.publicUrl).origin : o.port === supersetPort;
    if (allowed) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("vary", "origin");
    }
  } catch {
    /* not a URL */
  }
}

const port = Number(config.port ?? 8795);
const host = config.host ?? "127.0.0.1";
createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return send(res, 204, "");
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res);
    const supersetPort = config.superset.publicPort ?? Number(new URL(config.superset.url).port);
    const panel = config.overlay?.panel === "dock" ? "dock" : "float";
    const vars = { pack: pack.pack, panel, supersetPort, supersetUrl: config.superset.publicUrl?.replace(/\/+$/, "") ?? null, base, examples: (config.overlay?.examples ?? []).map((e: any) => e.question).filter(Boolean) };
    if (url.pathname === "/_superset/info") return send(res, 200, JSON.stringify({ pack: vars.pack, examples: vars.examples, panel }));
    // What a settings page (Superset's Settings → Manage → AI assistant) shows. No secrets: which
    // variable the LLM key came from, never the key.
    if (url.pathname === "/_superset/settings") {
      const llmFrom = process.env.LENSPACK_LLM_KEY_SOURCE || (process.env.LENSPACK_LLM_PROVIDERS ? "LENSPACK_LLM_PROVIDERS" : process.env.LENSPACK_LLM_API_KEY ? "LENSPACK_LLM_API_KEY" : process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null);
      return send(res, 200, JSON.stringify({
        pack: pack.pack,
        datasets: datasets.map((d) => ({ id: d.id, table: d.table_name, schema: d.schema ?? null, entity: binding.entityOf.get(d.id) ?? null })),
        dimensions: pack.dimensions.length,
        measures: pack.measures.map((m) => ({ key: m.key, label: m.label, agg: m.agg })),
        providers: providers.map(publicView),
        llmFrom,
        budget: config.budget ?? null,
        superset: { url: config.superset.url, username: config.superset.username },
        dashboards: Object.values(dashboards),
        publicPath: base,
        panel,
      }));
    }
    if (url.pathname === "/_superset/bind") return send(res, 200, JSON.stringify(await bind(url.searchParams.get("dashboard") ?? "")));
    if (url.pathname === "/_superset/dashboards") {
      const list = await client.get<{ result: { id: number; dashboard_title: string; changed_on_delta_humanized: string }[] }>("/api/v1/dashboard/?q=(page_size:100,order_column:changed_on_delta_humanized,order_direction:desc)");
      return send(res, 200, JSON.stringify(list.result.map((d) => ({ id: d.id, title: d.dashboard_title, changed: d.changed_on_delta_humanized }))));
    }
    const embed = /^\/superset\/(\d+)\/?$/.exec(url.pathname);
    if (embed) return send(res, 200, page("embed.html", { ...vars, dashboard: Number(embed[1]) }), TYPES[".html"]);
    if (url.pathname === "/") return send(res, 200, page("index.html", vars), TYPES[".html"]);
    const asset = /^\/(chat\.js|overlay\.js|chat\.css)$/.exec(url.pathname);
    if (asset) return send(res, 200, readFileSync(join(web, asset[1]!), "utf8"), TYPES[asset[1]!.slice(asset[1]!.lastIndexOf("."))]);
    return send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (e) {
    log(`${req.method} ${url.pathname}: ${e instanceof Error ? e.message : String(e)}`);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}).listen(port, host, () => log(`http://${host}:${port}/ (Superset ${config.superset.url}, ${Object.keys(dashboards).length} dashboard(s) bound, chat ${providers.length ? "on" : "off"})`));
