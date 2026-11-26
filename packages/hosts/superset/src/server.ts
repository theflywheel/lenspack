// Lenspack over Superset: the chat beside a Superset dashboard (in an iframe),
// or floating on Superset's own pages (one script tag in Superset's
// tail_js_custom_extra.html). Superset is not forked; it is the record for
// boards and the engine for numbers, and its signed header says who is asking.
// The server itself is @lenspack/serve's runtime; this file adds what is
// Superset's: the pack from its datasets, boards kept in its dashboards, the
// overlay's pages and scripts, and the settings page's routes under /_superset.
//
//   lenspack superset --config superset.yaml

import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { memoryStore } from "@lenspack/core";
import { boardRights } from "@lenspack/policy";
import { type AdminConfig, type Budget, NO_STORE, TYPES, adminRoutes, adminSettings, json, resolveSecrets, rotatingAudit, scriptJson, startRuntime } from "@lenspack/serve";
import YAML from "yaml";

import { identityKey, serviceAccount } from "./bootstrap";
import { type Overlay, fetchDatasets, packFromDatasets } from "./catalogue";
import { supersetClient } from "./client";
import { supersetConnector } from "./connector";
import { examplesByLanguage, examplesFor } from "./examples";
import { supersetPolicy, viewableDashboards } from "./access";
import { editPolicyFrom, hostPolicyFrom, identityOf, pathRefusal, supersetAuth } from "./identity";
import { supersetBoards } from "./store";
import { defaultMapStyle, supersetVersion } from "./version";

/**
 * superset.yaml. A string "env:NAME" anywhere reads that variable. The plumbing (superset.url, publicPath,
 * host, port, state, budget) may come from LENSPACK_* variables instead, so a deployment's file can be just
 * its datasets and overlay.
 */
export type SupersetConfig = AdminConfig & {
  superset?: {
    /** Where this server reaches Superset's API (in compose: http://superset:8088). Else LENSPACK_SUPERSET_URL. */
    url?: string;
    /** Where browsers reach Superset, when that differs from url (behind an ingress: https://superset.example.org). */
    publicUrl?: string;
    /** Superset's port as browsers see it, when publicUrl is not set (same host, another port). */
    publicPort?: number;
    /** Lenspack's own Superset account (default "lenspack"), made on first start from a one-time admin sign-in. */
    username?: string;
    /** An account you manage instead: its password's variable (default LENSPACK_SUPERSET_PASSWORD), or the password. */
    passwordEnv?: string;
    password?: string;
  };
  /**
   * Who may change dashboards through the chat (env LENSPACK_EDIT_POLICY wins): "superset" (default), whoever
   * Superset lets edit that dashboard (owner with can_write on Dashboard, or admin); "signed-in", anyone signed in.
   * Everyone who can view a dashboard may ask about it.
   */
  editPolicy?: "superset" | "signed-in";
  /**
   * Whose access narrows what each user sees (env LENSPACK_HOST_POLICY wins): "superset" (the default), the user's
   * own Superset dataset access and row-level security, failing closed; "off", only when chosen, Lenspack's service
   * account's, so anyone signed in reads every configured dataset in full (a warning says so at every start).
   * Needs lenspack_superset.py's /api/v1/lenspack/access for dataset access and templated clauses.
   */
  hostPolicy?: "superset" | "off";
  /** The audit log in the state directory (audit.jsonl, monthly files). false turns it off. */
  audit?: false | { retentionDays?: number };
  /** Superset datasets by id, or by table name (schema.table or table). */
  datasets: (number | string)[];
  dashboards?: number[];
  overlay?: Overlay;
  /** Else LENSPACK_HOST, else 127.0.0.1. */
  host?: string;
  /** Else LENSPACK_PORT, else 8795. */
  port?: number;
  /** The path browsers reach this server under, when a proxy mounts it below Superset's own host (/lenspack). Else LENSPACK_PUBLIC_PATH. */
  publicPath?: string;
  /** The board bookkeeping file; its directory holds the rest of the state. Else superset-boards.json in LENSPACK_STATE_DIR, else state/. */
  state?: string;
  /** Else LENSPACK_BUDGET_USD_PER_DAY and LENSPACK_BUDGET_USD_PER_USER_PER_DAY. */
  budget?: Budget;
};

/** A start-up step, tried again while Superset may still be starting. */
async function retried<T>(what: string, f: () => Promise<T>, waits: number[], log: (s: string) => void): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= waits.length) throw e;
      log(`${what} failed (${e instanceof Error ? e.message : String(e)}); trying again in ${waits[i]! / 1000} s`);
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

const web = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

export async function serveSuperset(path: string, env: NodeJS.ProcessEnv = process.env) {
  const file = resolve(path);
  const dir = dirname(file);
  const config = resolveSecrets(YAML.parse(readFileSync(file, "utf8")) as SupersetConfig, env, { file, allowEmpty: true });
  const log = (s: string) => console.error(`lenspack-superset: ${s}`);
  const supersetUrl = config.superset?.url ?? env.LENSPACK_SUPERSET_URL;
  if (!supersetUrl) throw new Error(`${file}: say where Superset's API is, as superset.url or LENSPACK_SUPERSET_URL`);
  const statePath = resolve(dir, config.state ?? (env.LENSPACK_STATE_DIR ? join(env.LENSPACK_STATE_DIR, "superset-boards.json") : "state/superset-boards.json"));
  const stateDir = dirname(statePath);
  mkdirSync(stateDir, { recursive: true });

  // Lenspack's Superset account: given (LENSPACK_SUPERSET_PASSWORD), saved from an earlier start, or made now from a one-time admin sign-in.
  const account = await retried(
    "signing in to Superset",
    () =>
      serviceAccount({
        url: supersetUrl,
        username: config.superset?.username ?? "lenspack",
        stateDir,
        password: config.superset?.password ?? env[config.superset?.passwordEnv ?? "LENSPACK_SUPERSET_PASSWORD"] ?? undefined,
        admin: { username: env.SUPERSET_ADMIN_USERNAME, password: env.SUPERSET_ADMIN_PASSWORD },
        log,
      }),
    [2000, 5000, 10_000, 20_000],
    log,
  );
  const client = supersetClient({ url: supersetUrl, username: account.username, password: account.password });
  // Each dataset is retried inside fetchDatasets; the whole build is retried too, so a partial answer under load isn't a crash loop.
  const datasets = await retried("building the pack", () => fetchDatasets(client, config.datasets, { log }), [2000, 5000, 10_000], log);
  // A column or metric the pack can't use is left out or renamed with a warning, never a failed start.
  const { pack, packYaml, binding, warnings } = packFromDatasets(datasets, config.overlay);
  for (const w of warnings) log(`warning: ${w}`);
  log(`pack ${pack.pack}: ${Object.keys(pack.entities).length} datasets, ${pack.dimensions.length} dimensions, ${pack.measures.length} measures`);
  // What differs between Superset 5 and 6 on this side: the default basemap of the maps Lenspack writes.
  const superset = await supersetVersion(client);
  binding.mapStyle ??= defaultMapStyle(superset.major);
  log(`Superset ${superset.version ?? "5.x (no version reported)"}${config.overlay?.mapStyle ? "" : `; maps drawn on ${binding.mapStyle}`}`);
  const admin = adminSettings(stateDir, config, env);
  log(admin.featuresLine());
  // A switched-off heatmap or map is refused by the connector's capabilities, read on every check.
  const on = (f: "heatmap" | "maps") => admin.features.on(f);
  const connector = supersetConnector(client, binding, { log, capabilities: () => ({ ...(on("heatmap") ? {} : { heatmap: false }), ...(on("maps") ? {} : { points: false }) }) });
  const dashboards: Record<string, number> = Object.fromEntries((config.dashboards ?? []).map((d) => [`superset-${d}`, d]));
  const store = supersetBoards({ inner: memoryStore(), client, pack, binding, dashboards, stateFile: statePath, log });
  await store.seed();

  // The identity key comes from Superset (derived there from its SECRET_KEY); without it nobody is signed in.
  let idKey: string | null = null;
  try {
    idKey = await retried("fetching the identity key", () => identityKey(client), [2000, 5000, 10_000, 20_000], log);
  } catch (e) {
    log(`no identity key (${e instanceof Error ? e.message : String(e)}): every request will be refused until Lenspack restarts with lenspack_superset.py loaded in Superset`);
  }
  const editPolicy = editPolicyFrom(env.LENSPACK_EDIT_POLICY ?? config.editPolicy);
  const hostPolicy = hostPolicyFrom(env.LENSPACK_HOST_POLICY ?? config.hostPolicy);
  const auditLog = config.audit === false ? null : rotatingAudit(stateDir, { retentionDays: Number(env.LENSPACK_AUDIT_RETENTION_DAYS) || (config.audit ? config.audit.retentionDays : undefined) || 90 });
  log(`identity: ${idKey ? "signed by Superset" : "NO KEY"}; edit policy ${editPolicy}; host policy ${hostPolicy}; audit ${auditLog ? `${auditLog.file} (${auditLog.retentionDays} days)` : "off"}; Superset account ${account.username} (${account.source})`);
  if (hostPolicy === "off")
    for (const line of [
      "WARNING: host policy is off (hostPolicy: off or LENSPACK_HOST_POLICY=off).",
      `WARNING: anyone signed in to Superset can read all ${datasets.length} configured dataset(s) in full through Lenspack: the chat, the filter menus and the board API.`,
      "WARNING: Superset's dataset permissions and row-level security do not apply to what Lenspack answers. Remove the setting to apply them (the default, hostPolicy: superset).",
    ])
      log(line);

  /**
   * Binds a dashboard (by id or slug) to a board on first use, so the overlay works on any dashboard. Only the one
   * Superset checked the user may view (the signed d); null for any other.
   */
  async function bind(idOrSlug: string, signed: number | null | undefined) {
    const head = await client.get<{ result: { id: number; dashboard_title: string } }>(`/api/v1/dashboard/${encodeURIComponent(idOrSlug)}`);
    const id = head.result.id;
    if (signed !== id) return null;
    const board = `superset-${id}`;
    if (dashboards[board] === undefined) {
      dashboards[board] = id;
      await store.pull(board, true);
      log(`bound dashboard ${id} (${head.result.dashboard_title})`);
    }
    return { board, dashboard: id, title: head.result.dashboard_title, notes: store.notes.get(board) ?? [] };
  }

  const send = (res: ServerResponse, status: number, body: string, type: string) => {
    res.writeHead(status, { "content-type": type, ...NO_STORE });
    res.end(body);
  };
  const base = (config.publicPath ?? env.LENSPACK_PUBLIC_PATH ?? "").replace(/\/+$/, "");
  const page = (name: string, vars: Record<string, unknown>) => readFileSync(join(web, name), "utf8").replaceAll("__BASE__", base).replace("/*__VARS__*/", `window.__lp=${scriptJson(vars)};`);
  const supersetPort = config.superset?.publicPort ?? Number(new URL(supersetUrl).port);
  const panel = config.overlay?.panel === "dock" ? "dock" : "float";
  const examples = examplesByLanguage(config.overlay?.examples);
  // Where browsers reach Superset: the config's publicUrl, else what Superset's route says it was reached as.
  const pageVars = (req: IncomingMessage) => {
    const fwd = (h: string) => String(req.headers[h] ?? "").split(",")[0]!.trim();
    const derived = fwd("x-forwarded-host") ? `${fwd("x-forwarded-proto") || "http"}://${fwd("x-forwarded-host")}` : null;
    return { pack: pack.pack, panel, supersetPort, supersetUrl: config.superset?.publicUrl?.replace(/\/+$/, "") ?? derived, base, examples };
  };
  // The overlay runs on Superset's origin and calls this server: allow exactly that origin (publicUrl's, else
  // the same host on Superset's port). Mounted under Superset's own host (publicPath), the calls are same-origin.
  const cors = (req: IncomingMessage, res: ServerResponse) => {
    try {
      const o = new URL(req.headers.origin ?? "");
      if (config.superset?.publicUrl ? o.origin !== new URL(config.superset.publicUrl).origin : o.port !== String(supersetPort)) return;
      res.setHeader("access-control-allow-origin", req.headers.origin!);
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("vary", "origin");
    } catch {
      /* no origin, or not a URL */
    }
  };

  const port = Number(config.port ?? env.LENSPACK_PORT ?? 8795);
  const host = config.host ?? env.LENSPACK_HOST ?? "127.0.0.1";
  startRuntime({
    hosts: [{ name: pack.pack, pack, packYaml, connector, store, ctx: {}, boards: [] }],
    app: {
      auth: supersetAuth(() => idKey, editPolicy, () => admin.features.on("boardEdits"), hostPolicy === "superset" ? supersetPolicy({ client, binding, log, dashboards: () => Object.values(dashboards) }) : undefined),
      audit: auditLog?.audit,
      ...admin.app,
    },
    port,
    host,
    budget: config.budget,
    log,
    health: () => ({ identity: !!idKey }),
    routes: ({ providers, budget }) => {
      const settingsPage = adminRoutes({
        prefix: "/_superset",
        settings: admin,
        providers,
        budget,
        audit: auditLog,
        log,
        adminName: "Superset admin",
        writable: () => !!idKey,
        info: (url) => ({ pack: pack.pack, examples: examplesFor(examples, url.searchParams.get("lang")), examplesByLang: examples, panel }),
        details: () => ({
          pack: pack.pack,
          datasets: datasets.map((d) => ({ id: d.id, table: d.table_name, schema: d.schema ?? null, entity: binding.entityOf.get(d.id) ?? null })),
          dimensions: pack.dimensions.length,
          measures: pack.measures.map((m) => ({ key: m.key, label: m.label, agg: m.agg })),
          // What the pack left out of Superset's catalogue or renamed, and why.
          warnings,
          superset: { url: supersetUrl, username: account.username, account: account.source },
          editPolicy,
          hostPolicy,
          dashboards: Object.values(dashboards),
          publicPath: base,
          panel,
        }),
      });
      return async (req, res, url, signedIn) => {
        cors(req, res);
        if (req.method === "OPTIONS") return send(res, 204, "", "application/json");
        // Before the path is read at all: URL would resolve "..", so what the route acts on could differ from what Superset checked.
        const bad = pathRefusal(req.url);
        if (bad) return json(res, 400, { error: bad }, NO_STORE);
        if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;
        // The scripts are public (Superset only includes them for signed-in users); everything else needs Superset's signature.
        const asset = /^\/(chat\.js|overlay\.js|chat\.css)$/.exec(url.pathname);
        if (asset) return send(res, 200, readFileSync(join(web, asset[1]!), "utf8"), TYPES[asset[1]!.slice(asset[1]!.lastIndexOf("."))]!);
        const who = await signedIn();
        if (!who) return json(res, 401, { error: "sign in to Superset first" }, NO_STORE);
        await settingsPage(req, res, url, who);
        if (res.headersSent) return;
        if (url.pathname === "/_superset/bind") {
          const bound = await bind(url.searchParams.get("dashboard") ?? "", identityOf(req, () => idKey)?.d);
          return bound ? json(res, 200, bound, NO_STORE) : json(res, 403, { error: "Superset did not check your access to this dashboard." }, NO_STORE);
        }
        if (url.pathname === "/_superset/dashboards") {
          const list = await client.get<{ result: { id: number; dashboard_title: string; changed_on_delta_humanized: string }[] }>("/api/v1/dashboard/?q=(page_size:100,order_column:changed_on_delta_humanized,order_direction:desc)");
          // Lenspack's account sees every dashboard: list only those Superset lets this user open (admins open all).
          let shown = list.result;
          if (hostPolicy === "superset" && !who.roles.includes("admin")) {
            const open = await viewableDashboards(client, who.user, shown.map((d) => d.id));
            const hiddenBoards = shown.filter((d) => !open.has(d.id)).map((d) => `superset-${d.id}`);
            shown = shown.filter((d) => boardRights({ ...who, hiddenBoards }, { id: `superset-${d.id}` }).view);
          }
          return json(res, 200, shown.map((d) => ({ id: d.id, title: d.dashboard_title, changed: d.changed_on_delta_humanized })), NO_STORE);
        }
        const embed = /^\/superset\/(\d+)\/?$/.exec(url.pathname);
        if (embed) return send(res, 200, page("embed.html", { ...pageVars(req), dashboard: Number(embed[1]) }), TYPES[".html"]!);
        if (url.pathname === "/") return send(res, 200, page("index.html", pageVars(req)), TYPES[".html"]!);
        return json(res, 404, { error: "not found" }, NO_STORE);
      };
    },
    onListening: ({ providers }) => log(`http://${host}:${port}/ (Superset ${supersetUrl}, ${Object.keys(dashboards).length} dashboard(s) bound, chat ${providers.length ? "on" : "off"})`),
  });
}
