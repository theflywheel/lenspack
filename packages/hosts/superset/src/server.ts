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

import { type PersonalDashboard, type SavedLayout, memoryStore } from "@lenspack/core";
import { type EditScope, decide, editScopeFrom, editScopeWarning, mayEditInScope, personalLimitsFrom, principalOf, shownConfig } from "@lenspack/policy";
import { type AdminConfig, type Budget, NO_STORE, TYPES, adminRoutes, adminSettings, json, resolveSecrets, rotatingAudit, scriptJson, startRuntime } from "@lenspack/serve";
import YAML from "yaml";

import { identityKey, serviceAccount } from "./bootstrap";
import { type Overlay, fetchDatasets, packFromDatasets } from "./catalogue";
import { supersetClient } from "./client";
import { supersetConnector } from "./connector";
import { examplesByLanguage, examplesFor } from "./examples";
import { supersetPolicy } from "./access";
import { type EditScopeCheck, type Identity, canEdit, editPolicyFrom, hostPolicyFrom, identityOf, pathRefusal, supersetAuth } from "./identity";
import { personalDashboards } from "./personal";
import { actorOf, personalRoutes } from "./personal-routes";
import { fileRecords } from "./records";
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
   * Whose access narrows what each user sees (env LENSPACK_HOST_POLICY wins): "off" (the default for now), the
   * service account's, as before; "superset", the user's own Superset dataset access and row-level security.
   * Needs lenspack_superset.py's /api/v1/lenspack/access for dataset access and templated clauses.
   */
  hostPolicy?: "superset" | "off";
  /** The audit log in the state directory (audit.jsonl, monthly files). false turns it off. */
  audit?: false | { retentionDays?: number };
  /** Superset datasets by id, or by table name (schema.table or table). */
  datasets: (number | string)[];
  dashboards?: number[];
  overlay?: Overlay;
  /**
   * People's own dashboards and saved layouts (docs/my-dashboards.md). The switch is the personalDashboards
   * feature (on by default); the limits may also come from LENSPACK_MAX_DASHBOARDS_PER_USER and
   * LENSPACK_MAX_SAVED_CONFIGS_PER_USER, and an admin can change them on a running server.
   */
  personal?: { maxDashboardsPerUser?: number; maxSavedConfigsPerUser?: number };
  /**
   * Where the chat may change dashboards (docs/my-dashboards.md): "superset" (the default), any dashboard
   * Superset lets the person edit; "own", only their own dashboards, so shared ones stay as they are and people
   * make their own copy to change. Admins are exempt unless adminsExempt is false. LENSPACK_EDIT_SCOPE and
   * LENSPACK_EDIT_SCOPE_ADMINS_EXEMPT win; an admin can change it on a running server.
   */
  editScope?: "superset" | "own" | { scope?: "superset" | "own"; adminsExempt?: boolean };
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
  // People's own dashboards and saved layouts: kept in files in the state directory, behind RecordStore.
  const links = fileRecords<PersonalDashboard>(join(stateDir, "personal-dashboards.json"), log);
  const layouts = fileRecords<SavedLayout>(join(stateDir, "saved-layouts.json"), log);
  const store = supersetBoards({
    inner: memoryStore(),
    client,
    pack,
    binding,
    dashboards,
    stateFile: statePath,
    log,
    // A chart Lenspack adds to someone's own dashboard is theirs in Superset.
    ownersOf: async (board) => {
      const link = dashboards[board] === undefined ? null : await links.get(String(dashboards[board]));
      return link ? [link.ownerId] : undefined;
    },
  });
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
  if (hostPolicy === "off") log(`host policy off: anyone signed in to Superset can read all ${datasets.length} configured dataset(s) through Lenspack, without Superset's dataset access or row-level security (hostPolicy: superset applies them)`);

  /** Binds a dashboard Lenspack knows the person may use (one they are on, or one just made for them). */
  async function bindId(id: number) {
    const board = `superset-${id}`;
    if (dashboards[board] === undefined) {
      dashboards[board] = id;
      await store.pull(board, true);
      log(`bound dashboard ${id}`);
    }
    return board;
  }
  const configLimits = personalLimitsFrom(config.personal, env);
  const limits = () => {
    const saved = admin.settings.get<{ maxDashboardsPerUser?: number; maxSavedConfigsPerUser?: number }>("personal") ?? {};
    return {
      on: admin.features.on("personalDashboards"),
      maxDashboardsPerUser: saved.maxDashboardsPerUser ?? configLimits.maxDashboardsPerUser,
      maxSavedLayoutsPerUser: saved.maxSavedConfigsPerUser ?? configLimits.maxSavedLayoutsPerUser,
    };
  };
  const personal = personalDashboards({ client, store, pack, bindBoard: bindId, links, layouts, limits, audit: auditLog?.audit, log });

  // Where the chat may change dashboards: the config's (or environment's) scope, unless an admin set one.
  const configScope = editScopeFrom(config.editScope, env);
  const editScope = (): EditScope => {
    const saved = admin.settings.get<Partial<EditScope>>("editScope") ?? {};
    return { scope: saved.scope ?? configScope.scope, adminsExempt: saved.adminsExempt ?? configScope.adminsExempt };
  };
  const scopeWarning = () => editScopeWarning(editScope(), { personalOn: admin.features.on("personalDashboards"), editsOn: admin.features.on("boardEdits") });
  /** Whether the dashboard Superset signed for is one of this person's own (made or copied through Lenspack). */
  const isOwn = async (id: Identity) => {
    if (typeof id.d !== "number") return false;
    const link = await links.get(String(id.d));
    return !!link && (link.ownerId === id.i || link.owner === id.u);
  };
  const scoped: EditScopeCheck = async (id) => {
    const scope = editScope();
    const v = mayEditInScope(actorOf(id), scope, limits(), { hostEdit: true, own: scope.scope === "own" ? await isOwn(id) : false });
    return v.ok ? null : v.why;
  };
  log(`edit scope ${configScope.scope}${configScope.scope === "own" ? ` (admins ${configScope.adminsExempt ? "exempt" : "not exempt"})` : ""}`);
  {
    const w = scopeWarning();
    if (w) log(`warning: ${w}`);
  }

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

  const auth = supersetAuth(() => idKey, editPolicy, () => admin.features.on("boardEdits"), hostPolicy === "superset" ? supersetPolicy({ client, binding, log }) : undefined, scoped);
  const supersetBase = (req: IncomingMessage) => (base ? "" : (pageVars(req).supersetUrl ?? ""));
  const mine = personalRoutes({
    personal,
    identity: (req) => identityOf(req, () => idKey),
    canEdit: async (id) => {
      if (!canEdit(id, editPolicy, admin.features.on("boardEdits"))) return { edit: false };
      return (await scoped(id)) ? { edit: false, byScope: true } : { edit: true };
    },
    // What the person may use of the pack, decided by policy from what Superset says about them.
    scope: async (req) => {
      const caller = await auth.identify(req);
      const d = caller && decide(principalOf(caller), pack, { host: {} });
      return d ? { ctx: d.ctx, capabilities: connector.capabilities } : null;
    },
    bind: bindId,
    shownBoard: async (board, ctx) => {
      const b = await store.get(board);
      return b ? { config: shownConfig(b.config, ctx), title: b.config.title } : null;
    },
    limits,
    setLimits: (body) => {
      const next: Record<string, number> = { ...(admin.settings.get<Record<string, number>>("personal") ?? {}) };
      for (const [k, v] of Object.entries(body)) {
        if (k !== "maxDashboardsPerUser" && k !== "maxSavedConfigsPerUser") return { ok: false, error: `unknown setting "${k}" (maxDashboardsPerUser, maxSavedConfigsPerUser)` };
        if (v === null) delete next[k];
        else if (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000) next[k] = v as number;
        else return { ok: false, error: `${k} must be a whole number from 0 to 10000, or null` };
      }
      admin.settings.set("personal", Object.keys(next).length ? next : undefined);
      return { ok: true };
    },
    editScope: () => ({ ...editScope(), defaults: configScope, warning: scopeWarning() }),
    setEditScope: (body) => {
      const next: Partial<EditScope> = { ...(admin.settings.get<Partial<EditScope>>("editScope") ?? {}) };
      for (const [k, v] of Object.entries(body)) {
        if (k === "scope") {
          if (v === null) delete next.scope;
          else if (v === "superset" || v === "own") next.scope = v;
          else return { ok: false, error: 'scope must be "superset" or "own", or null' };
        } else if (k === "adminsExempt") {
          if (v === null) delete next.adminsExempt;
          else if (typeof v === "boolean") next.adminsExempt = v;
          else return { ok: false, error: "adminsExempt must be true or false, or null" };
        } else return { ok: false, error: `unknown setting "${k}" (scope, adminsExempt)` };
      }
      admin.settings.set("editScope", Object.keys(next).length ? next : undefined);
      const w = scopeWarning();
      if (w) log(`warning: ${w}`);
      return { ok: true };
    },
    audit: auditLog?.audit,
    base: supersetBase,
    reply: (res, status, body) => json(res, status, body, NO_STORE),
  });

  const port = Number(config.port ?? env.LENSPACK_PORT ?? 8795);
  const host = config.host ?? env.LENSPACK_HOST ?? "127.0.0.1";
  startRuntime({
    hosts: [{ name: pack.pack, pack, packYaml, connector, store, ctx: {}, boards: [] }],
    app: {
      auth,
      audit: auditLog?.audit,
      ...admin.app,
      // The chat's tools for the person's own dashboards and layouts, on the dashboard Superset signed for.
      personal: (req, turn) => {
        const id = identityOf(req, () => idKey);
        if (!id || typeof id.d !== "number" || turn.boardId !== `superset-${id.d}` || !limits().on) return undefined;
        // Refused by the edit scope alone: Superset would let them edit, the deployment keeps the chat to their own.
        const byScope = !!turn.readOnly && canEdit(id, editPolicy, admin.features.on("boardEdits"));
        return personal.port(actorOf(id), { dashboard: id.d, board: turn.boardId, view: id.v !== false, edit: !turn.readOnly, byScope }, supersetBase(req));
      },
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
          // Only when on, so the page reads as before while it is off.
          ...(hostPolicy === "superset" ? { hostPolicy } : {}),
          dashboards: Object.values(dashboards),
          // People's own dashboards and saved layouts: the switch and the limits (PUT /_superset/settings/personal).
          personal: limits(),
          // Where the chat may change dashboards (PUT /_superset/settings/edit-scope), with a warning when no one can.
          editScope: { ...editScope(), defaults: configScope, warning: scopeWarning() },
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
        const asset = /^\/(chat\.js|overlay\.js|mine\.js|chat\.css)$/.exec(url.pathname);
        if (asset) return send(res, 200, readFileSync(join(web, asset[1]!), "utf8"), TYPES[asset[1]!.slice(asset[1]!.lastIndexOf("."))]!);
        const who = await signedIn();
        if (!who) return json(res, 401, { error: "sign in to Superset first" }, NO_STORE);
        await settingsPage(req, res, url, who);
        if (res.headersSent) return;
        if (await mine(req, res, url)) return;
        if (url.pathname === "/_superset/bind") {
          const bound = await bind(url.searchParams.get("dashboard") ?? "", identityOf(req, () => idKey)?.d);
          return bound ? json(res, 200, bound, NO_STORE) : json(res, 403, { error: "Superset did not check your access to this dashboard." }, NO_STORE);
        }
        if (url.pathname === "/_superset/dashboards") {
          const list = await client.get<{ result: { id: number; dashboard_title: string; changed_on_delta_humanized: string }[] }>("/api/v1/dashboard/?q=(page_size:100,order_column:changed_on_delta_humanized,order_direction:desc)");
          return json(res, 200, list.result.map((d) => ({ id: d.id, title: d.dashboard_title, changed: d.changed_on_delta_humanized })), NO_STORE);
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
