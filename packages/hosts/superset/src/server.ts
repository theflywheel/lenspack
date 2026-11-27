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

import { type PersonalDashboard, type SavedLayout, type ScopeClause, memoryStore } from "@lenspack/core";
import { type EditScope, adminSurfaceFrom, boardRights, boardScopeLine, boardsInScope, surfacePlan, decide, editScopeFacts, editScopeFrom, editScopeWarning, hiddenPersonalBoards, inBoardScope, personalLimitsFrom, principalOf, shownConfig } from "@lenspack/policy";
import { type AdminConfig, type Budget, NO_STORE, type Runtime, TYPES, accessRights, adminAccessSetup, adminRoutes, adminSettings, adminSignIn, json, packLayerStore, presentedKey, asSettingsWriter, revisionTag, resolveSecrets, rotatingAudit, scriptJson, settingsGrants, settingsRoster, settingsStore, startRuntime, userAccessSetup } from "@lenspack/serve";
import { NOT_TURNED_ON_MESSAGE, type PackLayer, type PackRisk, applyPackLayer, type Principal, type QuerySafetyConfig, adminRights, mayUse, packRisks, recordRights } from "@lenspack/policy";
import { guardedConnector, querySlots } from "@lenspack/engine";
import YAML from "yaml";

import { identityKeeper, identityKey, serviceAccount } from "./bootstrap";
import { type Binding, type Overlay, fetchDatasets, packScope } from "./catalogue";
import { supersetClient } from "./client";
import { SUPERSET_CAPABILITIES, supersetConnector } from "./connector";
import { OUT_OF_SCOPE_MESSAGE, dashboardBoard, dashboardLabel, dashboardScopeFrom, madeBoards } from "./dashboard-scope";
import { examplesByLanguage, examplesFor } from "./examples";
import { accessFallbackFrom, supersetPolicy, viewableDashboards } from "./access";
import { type CallerFacts, DEFAULT_SUPERSET_ADMINS, type Identity, callerOf, canEdit, editPolicyFrom, hostPolicyFrom, identityOf, pathRefusal, roleRulesFrom, rolesOf, signedClient, supersetAuth, supersetRights, userIdOf } from "./identity";
import { type LivePack, buildPack, packRuntime } from "./pack-runtime";
import { personalDashboards } from "./personal";
import { supersetQuerySafety } from "./query-safety";
import { datasetFacts, dryRun, dryRunText, exampleRefusals } from "./dry-run";
import { actorOf, personalRoutes } from "./personal-routes";
import { plainPath, requestPaths } from "./paths";
import { fileRecords } from "./records";
import { supersetBoards } from "./store";
import { supersetActions } from "./actions";
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
  /**
   * With hostPolicy: superset, what happens when Superset answers 404 for the plugin's access route (env
   * LENSPACK_ACCESS_FALLBACK wins). "none" (the default): that request is refused, as for any failure to check access,
   * and the route is asked again on the next. "rls-only", only for a Superset that runs an old plugin without the
   * route: Superset's row-level security rules alone apply to that request, and every dataset counts as readable
   * (a warning says so at every start).
   */
  accessFallback?: "none" | "rls-only";
  /**
   * Who holds Lenspack's admin role (the settings, the admin panel, the audit log, the usage page), by Superset role
   * name: admins, default [Admin]; and who also sees user names there: usage, default the same roles as admins.
   * LENSPACK_ADMIN_ROLES and LENSPACK_USAGE_ROLES (comma-separated) win. Neither widens anyone's data access.
   */
  auth?: {
    admins?: string[];
    usage?: string[];
    users?: string[];
    /**
     * Who is an admin (docs/access/admin-access.md): "superset-role" (the default: the admins rule over Superset roles),
     * "superset-users" (only adminUsers, and the people they grant admin to), or "password" (named passwords from
     * LENSPACK_ADMIN_PASSWORDS or LENSPACK_ADMIN_PASSWORDS_FILE, on a sign-in of its own). password combines with either
     * of the others ("superset-role,password"). LENSPACK_ADMIN_ACCESS wins.
     */
    adminAccess?: string | string[];
    /** Owners under superset-users: Superset user names or id:<n>. LENSPACK_ADMIN_USERS (comma-separated) wins. */
    adminUsers?: string[];
    /**
     * Who may use the assistant: "superset-role" (the default: the users rule, or everyone signed in when it names no
     * role), "granted" (people admins add on the admin pages), "everyone", or a combination like "superset-role,granted".
     * LENSPACK_USER_ACCESS wins.
     */
    userAccess?: string | string[];
    /** People who may always use it under granted: Superset user names or id:<n>. LENSPACK_USERS (comma-separated) wins. */
    seedUsers?: string[];
  };
  /** The audit log in the state directory (audit.jsonl, monthly files). false turns it off. */
  audit?: false | { retentionDays?: number };
  /**
   * Where the admin pages are (docs/features/admin-panel.md#where-the-admin-pages-are). surface: "split" (the default:
   * Superset's Settings → AI assistant page holds what Superset needs, the admin panel the rest), "superset" (everything
   * on Superset's page, inside Superset's frame), or "separate" (everything on the admin panel; Superset's page links to
   * it). LENSPACK_ADMIN_SURFACE wins. Under auth.adminAccess: password, the pages are always separate.
   */
  admin?: { surface?: "split" | "superset" | "separate" };
  /** Superset datasets by id, or by table name (schema.table or table). */
  datasets: (number | string)[];
  /**
   * The pack's own row scope: filters every answer carries, for everyone, whatever they ask or pick on a dashboard
   * (one campaign: [{ dimension: campaign, op: eq, value: "2026-spring" }]). Each names a dimension; one with an
   * `entity` narrows only that dataset. A question on a dataset that can't be narrowed by it is refused (OUT_OF_SCOPE).
   * It narrows what Lenspack answers, not what Superset's own charts draw.
   */
  scope?: ScopeClause[];
  /**
   * Superset dashboard ids to read at start (LENSPACK_DASHBOARDS, comma-separated, wins). Under dashboardScope:
   * listed, also the only dashboards the assistant works on.
   */
  dashboards?: number[];
  /**
   * Which dashboards the assistant works on (env LENSPACK_DASHBOARD_SCOPE wins): "any" (the default), every dashboard
   * the person may open in Superset; "listed", only those in `dashboards`, and people's own copies of them made
   * through Lenspack. Elsewhere there is no button, and every route that takes a dashboard refuses it.
   */
  dashboardScope?: "any" | "listed";
  overlay?: Overlay;
  /**
   * People's own dashboards and saved layouts (docs/features/personal-dashboards.md). The switch is the personalDashboards
   * feature (on by default); the limits may also come from LENSPACK_MAX_DASHBOARDS_PER_USER and
   * LENSPACK_MAX_SAVED_CONFIGS_PER_USER, and an admin can change them on a running server.
   */
  personal?: { maxDashboardsPerUser?: number; maxSavedConfigsPerUser?: number };
  /**
   * Where the chat may change dashboards (docs/features/personal-dashboards.md): "superset" (the default), any dashboard
   * Superset lets the person edit; "own", only their own dashboards, so shared ones stay as they are and people
   * make their own copy to change. Admins are exempt unless adminsExempt is false. LENSPACK_EDIT_SCOPE and
   * LENSPACK_EDIT_SCOPE_ADMINS_EXEMPT win; an admin can change it on a running server.
   */
  editScope?: "superset" | "own" | { scope?: "superset" | "own"; adminsExempt?: boolean };
  /**
   * Limits on the queries Lenspack sends to Superset (docs/operating/query-safety.md): rows, groups and series points per
   * query, time ranges, queries per turn, at once and how long each may take; `heavy` for the limits of a dataset marked
   * heavy, and `datasets` (by id, table name or entity key) for one dataset's own. LENSPACK_QUERY_* and
   * LENSPACK_HEAVY_DATASETS win; an admin can tighten them on a running server (loosen only with confirm).
   */
  querySafety?: QuerySafetyConfig;
  /** Else LENSPACK_HOST, else 127.0.0.1. */
  host?: string;
  /** Else LENSPACK_PORT, else 8795. */
  port?: number;
  /** The path browsers reach this server under, when a proxy mounts it below Superset's own host (/lenspack). Else LENSPACK_PUBLIC_PATH. The fallback: a request through Superset's route says its own path (paths.ts), Superset's root included. */
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
/** The admin routes an admin API key may call (docs/access/admin-api.md); every other path refuses a key. */
const KEY_ROUTE = /^\/_(superset|admin)\/(whoami|admin|settings|turns|audit|telemetry|audio|cache|personal)(\/|$)/;

export async function serveSuperset(path: string, env: NodeJS.ProcessEnv = process.env) {
  const file = resolve(path);
  const dir = dirname(file);
  const config = resolveSecrets(YAML.parse(readFileSync(file, "utf8")) as SupersetConfig, env, { file, allowEmpty: true });
  const log = (s: string) => console.error(`lenspack-superset: ${s}`);
  const supersetUrl = config.superset?.url ?? env.LENSPACK_SUPERSET_URL;
  if (!supersetUrl) throw new Error(`${file}: say where Superset's API is, as superset.url or LENSPACK_SUPERSET_URL`);
  // Which dashboards the assistant works on: checked before anything else, so a mistake stops the start at once.
  const dashboardScope = (() => {
    try {
      return dashboardScopeFrom(config, env);
    } catch (e) {
      throw new Error(`${file}: ${(e as Error).message}`);
    }
  })();
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
  const fetchNow = () => fetchDatasets(client, config.datasets, { log });
  const datasets = await retried("building the pack", fetchNow, [2000, 5000, 10_000], log);
  // What differs between Superset 5 and 6 on this side: the default basemap of the maps Lenspack writes.
  const superset = await supersetVersion(client);
  const admin = adminSettings(stateDir, config, env);
  log(admin.featuresLine());
  // A switched-off heatmap or map is refused by the connector's capabilities, read on every check.
  const on = (f: "heatmap" | "maps") => admin.features.on(f);
  const switchedOff = () => ({ ...(on("heatmap") ? {} : { heatmap: false }), ...(on("maps") ? {} : { points: false }) });
  // The pack: the deploy config's overlay, with the changes admins made while the server ran laid over it (pack-runtime.ts,
  // docs/hosts/superset/pack-runtime.md). A column or metric the pack can't use is left out or renamed with a warning,
  // never a failed start; so are mistakes in the overlay (a measure on a column that isn't there). Saved changes that no
  // longer build are set aside for the deploy config alone, said in the log and in the settings API.
  const packStore = packLayerStore(stateDir, { log });
  /** The pack's version in force and who made it, for an open admin page to notice a change made elsewhere. */
  const packRevision = () => {
    const v = live().version;
    const by = packStore.get(v);
    return { pack: { version: v, ...(v && by ? { by: by.by, at: by.at } : {}) } };
  };
  const packs = packRuntime({
    base: config.overlay ?? {},
    // The overlay as the file writes it, env: references kept, for the export.
    raw: (YAML.parse(readFileSync(file, "utf8")) as SupersetConfig | null)?.overlay ?? {},
    scope: config.scope,
    store: packStore,
    fetch: fetchNow,
    capabilities: () => ({ ...SUPERSET_CAPABILITIES, ...switchedOff() }),
    mapStyle: defaultMapStyle(superset.major),
    swap: (l) => swapPack(l),
    log,
  });
  const first = packs.start(datasets);
  const packName = first.pack.pack;
  const live = () => packs.live();
  // In a pack outside UTC, a dataset whose series Superset can't draw in that zone is said now, not found one question at a time.
  for (const w of first.warnings) log(`warning: ${w}`);
  log(`pack ${packName}: ${Object.keys(first.pack.entities).length} datasets, ${first.pack.dimensions.length} dimensions, ${first.pack.measures.length} measures`);
  // The pack's own context: its row scope, which every query anyone runs carries (decide() adds it to theirs). The scope
  // is the deploy config's alone, so its clauses never change while the server runs.
  const scope = packScope(config.scope, first.pack);
  for (const w of scope.warnings) log(`warning: ${w}`);
  const packCtx = scope.clauses.length ? { scope: scope.clauses } : {};
  if (scope.clauses.length) log(`pack scope: ${scope.clauses.map((c) => `${c.entity ? `${c.entity}.` : ""}${c.dimension} ${c.op} ${JSON.stringify(c.value)}`).join("; ")}`);
  log(`Superset ${superset.version ?? "5.x (no version reported)"}${config.overlay?.mapStyle ? "" : `; maps drawn on ${first.binding.mapStyle}`}`);
  // Query safety: every query any caller sends (a board, the chat, the review) is checked against the deployment's
  // limits first, waits for one of maxConcurrent places, and is waited for at most timeoutSeconds.
  const safety = (() => {
    try {
      return supersetQuerySafety({ config: config.querySafety, env, binding: () => live().binding, settings: admin.settings, log });
    } catch (e) {
      throw new Error(`${file}: ${(e as Error).message}`);
    }
  })();
  for (const w of safety.warnings()) log(`warning: ${w}`);
  log(safety.line());
  const slots = querySlots(() => safety.current().server.maxConcurrent);
  const connectorFor = (binding: Binding) => guardedConnector(supersetConnector(client, binding, { log, capabilities: switchedOff }), safety.guard, { slots });
  // Risky definitions in the pack under the limits (a per-record column offered for grouping, a heavy dataset no time
  // range narrows, an example question the limits would refuse): said at start and whenever the pack changes, and in
  // the settings API. Warnings only; nothing is changed by them.
  const risksNow = (): PackRisk[] => packRisks(live().pack, safety.current(), datasetFacts(live().datasets, live().binding));
  let exampleRisks: PackRisk[] = [];
  const checkPack = async () => {
    for (const r of risksNow()) log(`${r.level === "warning" ? "warning" : "note"}: ${r.message}`);
    exampleRisks = await exampleRefusals(live().pack, connector).catch(() => []);
    for (const r of exampleRisks) log(`warning: ${r.message}`);
  };
  // Replaced whole when the pack changes (swapPack): a turn already running keeps the one it began with.
  let connector = connectorFor(first.binding);
  void checkPack();
  const dashboards: Record<string, number> = Object.fromEntries(dashboardScope.dashboards.map((d) => [dashboardBoard(d), d]));
  log(`dashboards: ${boardScopeLine(dashboardScope.scope, dashboardLabel)}`);
  // People's own dashboards and saved layouts: kept in files in the state directory, behind RecordStore.
  const links = fileRecords<PersonalDashboard>(join(stateDir, "personal-dashboards.json"), log);
  const layouts = fileRecords<SavedLayout>(join(stateDir, "saved-layouts.json"), log);
  const store = supersetBoards({
    inner: memoryStore(),
    client,
    pack: first.pack,
    binding: first.binding,
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

  // The identity key comes from Superset (derived there from its SECRET_KEY); without it nobody is signed in. It is
  // tried for until Superset gives it, never given up on: a start before Superset (or before the plugin is loaded
  // there) recovers by itself, and GET /readyz says not ready meanwhile. The start waits for it about as long as before.
  const keeper = identityKeeper({ fetch: () => identityKey(client), log });
  await Promise.race([keeper.first, new Promise((r) => setTimeout(r, 40_000).unref())]);
  const idKey = keeper.key;
  if (!idKey()) log("no identity key yet: every request is refused until Superset gives it (is lenspack_superset.py loaded in Superset?); still trying, and /readyz answers 503 until then");
  const editPolicy = editPolicyFrom(env.LENSPACK_EDIT_POLICY ?? config.editPolicy);
  // Who holds Lenspack's admin role, by Superset role name: policy settles it (principalOf), never Superset's admin flag.
  const roleRules = roleRulesFrom(config.auth, env);
  const hostRights = supersetRights(roleRules);
  // Who is an admin and who may use the assistant, each one of three ways (docs/access/admin-access.md); policy decides
  // (rightsUnder, usersUnder, adminRights), these read the settings and keep the grants admins make.
  const adminAccess = adminAccessSetup({ config: config.auth, env, grants: settingsGrants(admin.settings, "adminGrants"), roster: settingsRoster(admin.settings), adminRoles: roleRules.admins ?? DEFAULT_SUPERSET_ADMINS, adminRolesFrom: env.LENSPACK_ADMIN_ROLES?.trim() ? "LENSPACK_ADMIN_ROLES" : config.auth?.admins ? "auth.admins" : undefined, log });
  const userAccess = userAccessSetup({ config: config.auth, env, grants: settingsGrants(admin.settings, "userGrants"), roles: hostRights.users, rolesFrom: env.LENSPACK_USER_ROLES?.trim() ? "LENSPACK_USER_ROLES" : config.auth?.users ? "auth.users" : undefined });
  // Read on every request: a grant or a revoke applies to the next one.
  const rights = accessRights(hostRights, adminAccess, userAccess);
  const ownRule = roleRules.admins !== undefined && roleRules.admins.join("\n") !== DEFAULT_SUPERSET_ADMINS.join("\n");
  // In refusals: a deployment that names its own admins (roles, people or a password) is not asking for Superset admins.
  const adminName = adminAccess.modes.join(",") === "superset-role" && !ownRule ? "Superset admin" : "assistant admin";
  const settle = (id: Parameters<typeof principalOf>[0]) => principalOf(id, rights);
  /**
   * Whether the users rule leaves the person a request was signed for out: from the signed role names alone (one
   * HMAC check, no call to Superset), so the overlay script, which every Superset page already loads through
   * Superset's own route, can be answered with an empty one at no extra cost.
   */
  const leftOut = (req: IncomingMessage) => {
    if (!rights.users) return false;
    const id = identityOf(req, idKey);
    return !!id && !mayUse(settle({ user: id.u, roles: rolesOf(id), ...(userIdOf(id) !== undefined ? { userId: userIdOf(id) } : {}) }));
  };
  const hostPolicy = hostPolicyFrom(env.LENSPACK_HOST_POLICY ?? config.hostPolicy);
  const accessFallback = accessFallbackFrom(env.LENSPACK_ACCESS_FALLBACK ?? config.accessFallback);
  const auditLog = config.audit === false ? null : rotatingAudit(stateDir, { retentionDays: Number(env.LENSPACK_AUDIT_RETENTION_DAYS) || (config.audit ? config.audit.retentionDays : undefined) || 90 });
  log(`identity: ${idKey() ? "signed by Superset" : "NO KEY (still trying)"}; edit policy ${editPolicy}; host policy ${hostPolicy}${hostPolicy === "superset" && accessFallback === "rls-only" ? " (rls-only fallback on a missing access route)" : ""}; audit ${auditLog ? `${auditLog.file} (${auditLog.retentionDays} days)` : "off"}; Superset account ${account.username} (${account.source})`);
  // Who is an admin and who may use it, in one line each, with where each setting came from (never the password).
  // First uses of admin rights go to the audit log (the admins roster).
  adminAccess.auditTo(auditLog?.audit);
  log(`${adminAccess.line()}${adminAccess.has("superset-role") && roleRules.usage ? `; user names on the usage board: ${roleRules.usage.join(", ") || "(none)"}` : ""}`);
  log(userAccess.line());
  // Admin API keys (docs/access/admin-api.md): how many and their names, never a key.
  log(adminAccess.apiKeys.line());
  // Where the admin pages are: the surface asked for, unless the password mode puts them on a page of their own.
  const surfaceFrom = env.LENSPACK_ADMIN_SURFACE?.trim() ? "LENSPACK_ADMIN_SURFACE" : config.admin?.surface ? "admin.surface" : null;
  const surface = surfacePlan(adminSurfaceFrom(config.admin?.surface, env.LENSPACK_ADMIN_SURFACE), adminAccess.modes);
  const surfaceWords = { split: "split (Superset's settings page holds what Superset needs; the admin panel the rest)", superset: "superset (everything on Superset's settings page)", separate: "separate (everything on the admin panel; Superset's settings page links to it)" };
  log(`admin pages: ${surfaceWords[surface.surface]} (${surfaceFrom ? `from ${surfaceFrom}` : "the default"})`);
  const surfaceWarnings = surface.asked ? [`admin pages: ${surfaceFrom} asks for ${surface.asked}, but admins sign in with a password (access password), so the admin pages are on their own (separate)`] : [];
  for (const w of [...adminAccess.warnings, ...userAccess.warnings, ...surfaceWarnings]) log(`warning: ${w}`);
  if (hostPolicy === "off")
    for (const line of [
      "WARNING: host policy is off (hostPolicy: off or LENSPACK_HOST_POLICY=off).",
      `WARNING: anyone signed in to Superset can read all ${datasets.length} configured dataset(s) in full through Lenspack: the chat, the filter menus and the board API.`,
      "WARNING: Superset's dataset permissions and row-level security do not apply to what Lenspack answers. Remove the setting to apply them (the default, hostPolicy: superset).",
    ])
      log(line);
  if (hostPolicy === "superset" && accessFallback === "rls-only")
    for (const line of [
      "WARNING: accessFallback is rls-only (accessFallback: rls-only or LENSPACK_ACCESS_FALLBACK=rls-only).",
      "WARNING: whenever Superset answers 404 for /api/v1/lenspack/access, Superset's dataset permissions and dashboard roles do not apply to that request: every configured dataset counts as readable, and only row-level security rules narrow it.",
      "WARNING: load lenspack_superset.py in every Superset process and remove the setting (the default, none, refuses such a request instead).",
    ])
      log(line);

  // Set once the runtime starts (rt.setHost): hands the board API, the chat and saved answers a new pack.
  let setHost: Runtime["setHost"];
  /** A change to the pack is in force (pack-runtime.ts): everything that reads the pack gets the new one from the next request on. */
  async function swapPack(l: LivePack) {
    connector = connectorFor(l.binding);
    await setHost?.(packName, { pack: l.pack, packYaml: l.packYaml, connector });
    // Every bound dashboard is read again under the new pack, in the background: a chart may now match a measure, or no longer.
    void store.setPack(l.pack, l.binding);
    for (const w of [...l.warnings, ...l.scopeWarnings]) log(`warning: ${w}`);
    void checkPack();
  }

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
  const personal = personalDashboards({
    client,
    store,
    pack: () => live().pack,
    bindBoard: bindId,
    // "My dashboards" lists only those in the deployment's dashboard scope.
    boardScope: () => dashboardScope.scope,
    links,
    layouts,
    limits,
    audit: auditLog?.audit,
    log,
    // Usage telemetry (docs/features/telemetry.md, item personal-dashboards): one event per action, if that item is on.
    telemetry: (e) => void admin.app.telemetry?.event({ user: e.user, roles: e.roles, board: e.board ?? null, pack: packName }, { type: e.event, how: e.how, data: e.data }).catch((err: Error) => log(`telemetry: ${err.message}`)),
  });

  // Where the chat may change dashboards: the config's (or environment's) scope, unless an admin set one.
  const configScope = editScopeFrom(config.editScope, env);
  const editScope = (): EditScope => {
    const saved = admin.settings.get<Partial<EditScope>>("editScope") ?? {};
    return { scope: saved.scope ?? configScope.scope, adminsExempt: saved.adminsExempt ?? configScope.adminsExempt };
  };
  const scopeWarning = () => editScopeWarning(editScope(), { personalOn: admin.features.on("personalDashboards"), editsOn: admin.features.on("boardEdits") });
  /** The edit scope as facts for policy (boardRights): the person's own boards, made or copied through Lenspack. */
  const editScopeOf = async (id: Identity) => {
    const scope = editScope();
    if (scope.scope !== "own") return undefined;
    const on = limits().on;
    const own = on ? (await links.list()).filter((l) => l.ownerId === id.i || l.owner === id.u).map((l) => l.board) : [];
    return editScopeFacts(scope, { own, personalOn: on });
  };
  /**
   * The deployment's facts about a person for policy: the edit scope, other people's own dashboards, which they may
   * not open, and under dashboardScope: listed, the only dashboards the assistant is on (the listed ones and the copies
   * of them people made through Lenspack, while that feature is on).
   */
  const callerFacts: CallerFacts = async (id, o) => {
    const facts = o.edit ? await editScopeOf(id) : undefined;
    const all = await links.list();
    const hidden = hiddenPersonalBoards(actorOf(id, rights), all);
    const only = boardsInScope(dashboardScope.scope, madeBoards(all), { personalOn: limits().on });
    return { ...(facts ? { editScope: facts } : {}), ...(hidden.length ? { hiddenBoards: hidden } : {}), ...(only ? { onlyBoards: only } : {}) };
  };
  /** What policy says this person may do on the dashboard Superset signed for: Superset's rights, narrowed by the deployment's facts. */
  const rightsOn = async (id: Identity) => {
    const caller = callerOf(id, editPolicy, admin.features.on("boardEdits"));
    const facts = await callerFacts(id, { edit: !!caller.edit });
    const board = `superset-${id.d}`;
    const r = boardRights(settle({ ...caller, ...facts }), { id: board });
    // outOfScope: the deployment doesn't put the assistant on this dashboard (dashboardScope: listed).
    return { view: id.v === true && r.view, edit: r.edit, ...(r.readOnly ? { byScope: true } : {}), ...(inBoardScope(facts, board) ? {} : { outOfScope: true }) };
  };
  log(`edit scope ${configScope.scope}${configScope.scope === "own" ? ` (admins ${configScope.adminsExempt ? "exempt" : "not exempt"})` : ""}`);
  {
    const w = scopeWarning();
    if (w) log(`warning: ${w}`);
  }

  /**
   * Binds a dashboard (by id or slug) to a board on first use, so the overlay works on any dashboard in the
   * deployment's scope. Only the one Superset checked the user may view (the signed d), and only when policy puts it
   * in scope (a slug is read as its id first); a refusal for any other.
   */
  async function bind(idOrSlug: string, signed: number | null | undefined, who: { onlyBoards?: readonly string[] }) {
    const head = await client.get<{ result: { id: number; dashboard_title: string } }>(`/api/v1/dashboard/${encodeURIComponent(idOrSlug)}`);
    const id = head.result.id;
    if (signed !== id) return { refused: "Superset did not check your access to this dashboard." };
    const board = dashboardBoard(id);
    if (!inBoardScope(who, board)) return { refused: OUT_OF_SCOPE_MESSAGE, code: "out-of-scope" };
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
  // Where browsers reach this server when nothing says otherwise. Through the plugin, each request says it (with
  // Superset's own root, when Superset runs below a path of its host): see paths.ts.
  const configured = config.publicPath ?? env.LENSPACK_PUBLIC_PATH ?? "";
  const base = plainPath(configured);
  if (base === null) throw new Error(`${file}: publicPath (LENSPACK_PUBLIC_PATH) must be a plain path like /lenspack, not "${configured}"`);
  const paths = (req: IncomingMessage) => requestPaths(req, base);
  // Under admin access "password", the admin pages have a sign-in of their own at <base>/_admin/ (reachable through
  // Superset's route without a Superset session; docs/access/admin-access.md). Without a password set: refused, with why.
  const signIn = adminAccess.has("password") ? adminSignIn({ prefix: "/_admin", dir: stateDir, env, passwords: adminAccess.passwords, publicBase: (req) => paths(req).base, clientAddress: (req) => signedClient(req, idKey()), audit: auditLog?.audit, name: () => admin.brand.get().name, log }) : null;
  const passwordAdmin = signIn && !("refused" in signIn) ? signIn : null;
  if (signIn && "refused" in signIn) log(`warning: ${signIn.refused}`);
  // The assistant's name in the page's own words (brand), as text: escaped, never markup.
  const text = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const page = (name: string, vars: { base: string } & Record<string, unknown>) => {
    const brand = admin.brand.get();
    return readFileSync(join(web, name), "utf8").replaceAll("__BASE__", vars.base).replaceAll("__NAME__", text(brand.name)).replaceAll("__BUTTON__", text(brand.buttonLabel)).replace("/*__VARS__*/", `window.__lp=${scriptJson({ ...vars, brand })};`);
  };
  const supersetPort = config.superset?.publicPort ?? Number(new URL(supersetUrl).port);
  const panel = config.overlay?.panel === "dock" ? "dock" : "float";
  // The suggested questions, from the pack in force (an admin can change them while the server runs).
  const examples = () => examplesByLanguage(live().overlay.examples);
  // Where browsers reach Superset: the config's publicUrl, else what Superset's route says it was reached as, with
  // Superset's root (/superset when it runs below a path of its host).
  const pageVars = (req: IncomingMessage) => {
    const fwd = (h: string) => String(req.headers[h] ?? "").split(",")[0]!.trim();
    const at = paths(req);
    const derived = fwd("x-forwarded-host") ? `${fwd("x-forwarded-proto") || "http"}://${fwd("x-forwarded-host")}${at.root}` : null;
    return { pack: packName, panel, supersetPort, supersetUrl: config.superset?.publicUrl?.replace(/\/+$/, "") ?? derived, supersetRoot: at.root, base: at.base, examples: examples() };
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
  // The definitions overlay, open questions and the daily review (review/ in @lenspack/serve), kept in the state
  // directory; the admin panel at /_superset/admin/ (through Superset: /lenspack/_superset/admin/).
  const review = admin.review({
    stateDir,
    // Read through the pack in force: the definitions, open questions and the daily review follow a change to the pack.
    hosts: [
      {
        name: packName,
        get pack() {
          return live().pack;
        },
        get connector() {
          return connector;
        },
        ctx: packCtx,
      },
    ],
    events: auditLog ? (from) => auditLog.since(from) : undefined,
    audit: auditLog?.audit,
    prefix: "/_superset",
    adminName,
    title: packName,
    log,
  });
  const auth = supersetAuth(idKey, editPolicy, () => admin.features.on("boardEdits"), hostPolicy === "superset" ? supersetPolicy({ client, binding: () => live().binding, log, dashboards: () => Object.values(dashboards), fallback: accessFallback }) : undefined, callerFacts, rights);
  // The start of a link to a Superset page: Superset's root when this server is reached through Superset's host
  // ("" or "/superset"), else Superset's address.
  const supersetBase = (req: IncomingMessage) => {
    const at = paths(req);
    return at.base ? at.root : (pageVars(req).supersetUrl ?? "");
  };
  const mine = personalRoutes({
    personal,
    rights,
    adminName,
    identity: (req) => identityOf(req, idKey),
    rightsOn,
    // What the person may use of the pack, decided by policy from what Superset says about them, on the dashboard they are on.
    scope: async (req, board) => {
      const caller = await auth.identify(req);
      const d = caller && decide(settle(caller), live().pack, { host: packCtx, board });
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
    // Every answer says the settings' revision, so a page that just changed the limits holds the new one.
    reply: (res, status, body) => json(res, status, body, { ...NO_STORE, ETag: revisionTag(admin.settings.revision()) }),
    settingsWriter: (req, res, who, run) => asSettingsWriter(admin.settings, req, res, who, run),
  });
  startRuntime({
    hosts: [{ name: packName, pack: first.pack, packYaml: first.packYaml, connector, store, ctx: packCtx, boards: [] }],
    app: {
      // Signed in by Superset; its role names read by the deployment's role rules (supersetRights), which auth carries.
      auth,
      audit: auditLog?.audit,
      ...admin.app,
      // The chat's tools for the person's own dashboards and layouts, on the dashboard Superset signed for.
      personal: (req, turn) => {
        const id = identityOf(req, idKey);
        if (!id || typeof id.d !== "number" || turn.boardId !== `superset-${id.d}` || !limits().on) return undefined;
        // Refused by the edit scope alone: Superset would let them edit, the deployment keeps the chat to their own.
        const byScope = !!turn.readOnly && canEdit(id, editPolicy, admin.features.on("boardEdits"));
        return personal.port(actorOf(id, rights), { dashboard: id.d, board: turn.boardId, view: id.v !== false, edit: !turn.readOnly, byScope }, supersetBase(req));
      },
      // Telemetry records the user's Superset role names as Superset signed them (none signed: none), and datasets by name.
      telemetryRoles: (req) => {
        const id = identityOf(req, idKey);
        return id ? (id.r ?? []) : undefined;
      },
      telemetryDataset: (entity) => live().binding.datasets.get(entity)?.table,
      definitions: review.turn,
      // The most queries one chat turn may send (query safety).
      queriesPerTurn: safety.perTurn,
    },
    port,
    host,
    // Every model call, one JSON line in the state directory: today's spend (the budget, GET /api/_usage) is read back at start.
    usageFile: join(stateDir, "usage.jsonl"),
    budget: config.budget,
    log,
    health: () => ({ identity: !!idKey() }),
    // Not ready while there is no identity key: every request would be refused. /healthz stays 200 (liveness).
    ready: () => (idKey() ? { ready: true } : { ready: false, reason: "no identity key from Superset yet: is lenspack_superset.py loaded there?" }),
    routes: (rt) => {
      const { providers, budget } = rt;
      setHost = rt.setHost;
      // Changing the pack while it runs (<prefix>/settings/pack…): admins, decided by policy (packEditRights).
      const packRoutes = packs.routes("/_superset", { access: () => adminAccess.state(), seen: (who) => adminAccess.seen(who), audit: auditLog?.audit, adminName });
      // Superset's settings page, as the admin pages link to it.
      const supersetPage = (req: IncomingMessage) => `${paths(req).root}/ai-assistant/`;
      // The panel's page on each surface: the rest of the settings (split), everything (separate), or Superset's page
      // instead (superset). With the password alone, nobody signs in through Superset: its address for the panel leads to
      // the admin sign-in.
      const passwordOnly = adminAccess.modes.join(",") === "password";
      const adminPanel = review.routes(rt, {
        seen: adminAccess.seen,
        shell: (req) => ({ surface: surface.surface, sections: surface.panel === "none" ? "all" : surface.panel, superset: true, supersetPage: supersetPage(req) }),
        ...(passwordOnly ? { pageRedirect: (req: IncomingMessage) => `${paths(req).base}/_admin/` } : surface.panel === "none" ? { pageRedirect: supersetPage } : {}),
      });
      const settingsPage = adminRoutes({
        prefix: "/_superset",
        settings: admin,
        providers,
        budget,
        audit: auditLog,
        log,
        adminName,
        writable: () => !!idKey(),
        supersetLogs: async (since) => {
          const r = await supersetActions(client, { dashboards: Object.values(dashboards), from: since, to: new Date() });
          return { available: r.available, ...(r.reason ? { reason: r.reason } : {}), count: r.actions.length, lastSeen: r.actions.reduce<string | null>((m, a) => (m === null || a.at > m ? a.at : m), null) };
        },
        // supersetRoot: where Superset runs on its host ("" or "/superset"), for the overlay's links to Superset's pages.
        // admin: how admins sign in, and where the admin pages are, for Superset's settings page (no names, no secrets).
        info: (url, req) => ({ pack: packName, examples: examplesFor(examples(), url.searchParams.get("lang")), examplesByLang: examples(), panel, supersetRoot: paths(req).root, admin: { access: adminAccess.modes.join(","), surface: surface.surface, page: surface.hostPage, panel: surface.panel === "none" ? null : `${paths(req).base}${passwordOnly ? "/_admin/" : "/_superset/admin/"}`, signIn: adminAccess.has("password") ? `${paths(req).base}/_admin/` : null } }),
        details: () => ({
          pack: packName,
          datasets: live().datasets.map((d) => ({ id: d.id, table: d.table_name, schema: d.schema ?? null, entity: live().binding.entityOf.get(d.id) ?? null })),
          dimensions: live().pack.dimensions.length,
          measures: live().pack.measures.map((m) => ({ key: m.key, label: m.label, agg: m.agg })),
          // What the pack left out of Superset's catalogue or renamed, and why.
          warnings: live().warnings,
          // Changes admins made to the pack while the server ran (<prefix>/settings/pack): the version in force, 0 for none.
          packLayer: { version: live().version, fields: Object.keys(live().layer), ...(live().notApplied ? { notApplied: live().notApplied } : {}) },
          // The pack's own row scope, which every answer carries.
          scope: scope.clauses,
          superset: { url: supersetUrl, username: account.username, account: account.source },
          editPolicy,
          hostPolicy,
          accessFallback,
          dashboards: Object.values(dashboards),
          // Which dashboards the assistant works on: any, or only the listed ones (and people's own copies of them).
          dashboardScope: dashboardScope.scope.scope === "any" ? { scope: "any" } : { scope: "listed", dashboards: dashboardScope.scope.boards.map((b) => Number(dashboardLabel(b))) },
          // People's own dashboards and saved layouts: the switch and the limits (PUT /_superset/settings/personal).
          personal: limits(),
          // Where the chat may change dashboards (PUT /_superset/settings/edit-scope), with a warning when no one can.
          editScope: { ...editScope(), defaults: configScope, warning: scopeWarning() },
          publicPath: base,
          panel,
          // Where the admin pages are (admin.surface), and what each page shows.
          adminPages: surface,
          // Limits on the queries sent to Superset (PUT /_superset/settings/query-safety).
          querySafety: { ...safety.view(!!idKey()), packRisks: [...risksNow(), ...exampleRisks] },
        }),
        access: adminAccess,
        users: userAccess,
        revisionExtras: packRevision,
      });
      // The password sign-in's admin pages: the same panel and settings routes under /_admin, for the password admin.
      // Password admins always get every section there, whatever the surface: they have no Superset page to use.
      const passwordPanel = passwordAdmin ? review.routes(rt, { prefix: "/_admin", base: "/_admin", adminName: "assistant admin", seen: adminAccess.seen, shell: (req) => ({ signOut: passwordAdmin.signOutPath(req), access: "password", surface: "separate", sections: "all", superset: true, supersetPage: supersetPage(req) }) }) : null;
      const passwordPack = passwordAdmin ? packs.routes("/_admin", { access: () => adminAccess.state(), seen: (who) => adminAccess.seen(who), audit: auditLog?.audit, adminName: "assistant admin" }) : null;
      const passwordSettings = passwordAdmin
        ? adminRoutes({ prefix: "/_admin", settings: admin, providers, budget, audit: auditLog, log, adminName: "assistant admin", writable: () => true, access: adminAccess, users: userAccess, details: () => ({ querySafety: { ...safety.view(true), packRisks: [...risksNow(), ...exampleRisks] } }), revisionExtras: packRevision })
        : null;
      /**
       * PUT <prefix>/settings/query-safety: an admin changes the query limits on a running server. Tighter than the
       * deployment's own settings is always allowed; looser answers 409 with what would loosen, unless the request
       * says "confirm": true. Audited either way.
       */
      const querySafetyRoute = async (req: IncomingMessage, res: ServerResponse, url: URL, who: Principal, prefix: string, name: string): Promise<boolean> => {
        const dry = url.pathname === `${prefix}/settings/query-safety/dry-run`;
        if (url.pathname !== `${prefix}/settings/query-safety` && !dry) return false;
        const audit = (outcome: "ok" | "denied" | "refused", detail: string) => auditLog?.audit({ at: new Date().toISOString(), user: who.user, action: dry ? "query-safety dry run" : "settings query-safety", outcome, detail: detail.slice(0, 500) });
        if (req.method !== (dry ? "POST" : "PUT")) return json(res, 405, { error: dry ? "POST" : "PUT" }, NO_STORE), true;
        if (!adminRights(who, adminAccess.state()).administer) return audit("denied", `not a ${name}`), json(res, 403, { error: `only ${name}s can do this` }, NO_STORE), true;
        // POST …/dry-run: every query shape the pack allows, compiled by Superset with result_type "query" and read for
        // risks; nothing is run. Optional body { cap } (default 200 shapes, at most 1000).
        if (dry) {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          let cap = 200;
          try {
            const b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { cap?: unknown };
            if (b.cap !== undefined) {
              if (typeof b.cap !== "number" || !Number.isInteger(b.cap) || b.cap < 1 || b.cap > 1000) return json(res, 400, { error: "cap is a whole number of query shapes from 1 to 1000" }, NO_STORE), true;
              cap = b.cap;
            }
          } catch {
            return json(res, 400, { error: "send the options as JSON" }, NO_STORE), true;
          }
          const l = live();
          const report = await dryRun({ client, pack: l.pack, binding: l.binding, connector, safety: safety.current(), datasets: l.datasets, cap });
          audit("ok", `${report.shapes} shapes, ${report.compiled} compiled, ${report.findings.filter((f) => f.level === "danger").length} dangerous, ${report.refused.length} refused`);
          return json(res, 200, { ...report, text: dryRunText(report) }, NO_STORE), true;
        }
        let body: unknown;
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return json(res, 400, { error: "send the change as JSON" }, NO_STORE), true;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "send the change as a JSON object" }, NO_STORE), true;
        // As one writer of the settings store: a change made on an older revision (If-Match) is refused there with 409.
        await asSettingsWriter(admin.settings, req, res, who, async () => {
          const r = safety.update(body as Record<string, unknown>);
          audit(r.status === 200 ? "ok" : "refused", r.status === 200 ? JSON.stringify(body) : String(r.body.error));
          json(res, r.status, r.status === 200 ? { ...r.body, querySafety: safety.view(true) } : r.body, { ...NO_STORE, ETag: revisionTag(admin.settings.revision()) });
        });
        return true;
      };
      /** Exports and shares done in Superset itself on the dashboards Lenspack works on, from Superset's action log (admins only). */
      const actionLog = async (res: ServerResponse, url: URL, who: Principal): Promise<boolean> => {
        if (url.pathname !== "/_superset/telemetry/superset-actions" || res.req.method !== "GET") return false;
        if (!recordRights(who).telemetry) return json(res, 403, { error: `only ${adminName}s can do this` }, NO_STORE), true;
        const day = (k: string, fallback: Date) => {
          const v = url.searchParams.get(k);
          const d = v ? new Date(v) : fallback;
          return Number.isNaN(d.getTime()) ? null : d;
        };
        const to = day("to", new Date());
        const from = to && day("from", new Date(to.getTime() - 7 * 86_400_000));
        if (!to || !from) return json(res, 400, { error: "from and to must be dates, like 2026-11-01" }, NO_STORE), true;
        return json(res, 200, { from: from.toISOString(), to: to.toISOString(), ...(await supersetActions(client, { dashboards: Object.values(dashboards), from, to })) }, NO_STORE), true;
      };
      /** The admin routes alone, for a caller with no Superset signature (an admin API key): the panel's API, the settings, the records. */
      const adminOnly = async (req: IncomingMessage, res: ServerResponse, url: URL, who: Principal): Promise<boolean> => {
        if (await adminPanel(req, res, url, who)) return true;
        if (await packRoutes(req, res, url, who)) return true;
        if (await querySafetyRoute(req, res, url, who, "/_superset", adminName)) return true;
        await settingsPage(req, res, url, who);
        if (res.headersSent) return true;
        if (await mine.admin(req, res, url, who)) return true;
        return actionLog(res, url, who);
      };
      return async (req, res, url, signedIn) => {
        cors(req, res);
        if (req.method === "OPTIONS") return send(res, 204, "", "application/json");
        // Before the path is read at all: URL would resolve "..", so what the route acts on could differ from what Superset checked.
        const bad = pathRefusal(req.url);
        if (bad) return json(res, 400, { error: bad }, NO_STORE);
        if (url.pathname === "/healthz" || url.pathname === "/readyz") return;
        // An admin API key (docs/access/admin-api.md), read only when the deployment sets one: on the admin routes it is the
        // caller, whatever else the request carries; anywhere else (the chat, the data, a person's own pages) the request is
        // refused without the key being checked. Through Superset, a key reaches this server only by
        // the admin passthrough: Superset's plugin passes the header on for <root>/lenspack/_admin/… only, with the caller's
        // address signed, and on no other route. Directly on this server's address, /_superset/<route> takes it too.
        const key = adminAccess.apiKeys.on ? presentedKey(req) : null;
        if (key !== null) {
          if (!KEY_ROUTE.test(url.pathname))
            return json(res, 403, { error: "an admin API key works on the admin routes only (/_admin/whoami, /_admin/settings, /_admin/admin/api/…, /_admin/audit, …), not on the chat or the data", code: "api-key-admin-only" }, NO_STORE);
          const checked = await adminAccess.apiKeys.check(req, key, signedClient(req, idKey()));
          if ("status" in checked) return json(res, checked.status, { error: checked.error }, { ...NO_STORE, ...(checked.retryAfterS ? { "retry-after": String(checked.retryAfterS) } : {}) });
          // /_admin/<route> (the way through Superset's admin passthrough) is the same route as /_superset/<route>.
          const at = url.pathname.startsWith("/_admin/") ? new URL(`/_superset/${url.pathname.slice("/_admin/".length)}${url.search}`, url) : url;
          if (await adminOnly(req, res, at, checked.who)) return;
          if (res.headersSent) return;
          return json(res, 404, { error: "not found" }, NO_STORE);
        }
        if (url.pathname.startsWith("/api/")) return;
        // The password sign-in's admin pages, before Superset's signature is asked for: they carry none.
        if (url.pathname === "/_admin" || url.pathname.startsWith("/_admin/")) {
          if (!adminAccess.has("password")) return json(res, 404, { error: "not found: admins sign in through Superset on this deployment" }, NO_STORE);
          if (!passwordAdmin) return send(res, 503, `<!doctype html><meta charset="utf-8"><title>Admin sign-in</title><p style="font:15px system-ui;margin:40px;max-width:60ch">The admin sign-in is not set up: ${text((signIn as { refused: string }).refused)}</p>`, TYPES[".html"]!);
          if (await passwordAdmin.handle(req, res, url)) return;
          const who = passwordAdmin.identify(req);
          if (!who) {
            if (url.pathname === "/_admin" || url.pathname === "/_admin/" || url.pathname === "/_admin/index.html") {
              res.writeHead(302, { location: passwordAdmin.signInPath(req, url), ...NO_STORE });
              return void res.end();
            }
            return json(res, 401, { error: "sign in to the admin pages first" }, NO_STORE);
          }
          if (await passwordPanel!(req, res, url, who)) return;
          if (await passwordPack!(req, res, url, who)) return;
          if (await querySafetyRoute(req, res, url, who, "/_admin", "assistant admin")) return;
          await passwordSettings!(req, res, url, who);
          if (res.headersSent) return;
          return json(res, 404, { error: "not found" }, NO_STORE);
        }
        // What Superset's plugin needs to draw its "AI assistant" menu entry by itself: the assistant's name, and the
        // role names or user names that make an admin (adminMenuHint). The plugin asks at most every five minutes, as the
        // assistant's own Superset account, so drawing a menu never waits for this server. Only that account may read it
        // (it names admins), and before the users rule: the account need not be a user. Showing the entry grants nothing.
        if (url.pathname === "/_superset/menu" && req.method === "GET") {
          const id = identityOf(req, idKey);
          if (!id) return json(res, 401, { error: "sign in to Superset first" }, NO_STORE);
          if (id.u !== account.username) return json(res, 403, { error: "only the assistant's own Superset account reads this" }, NO_STORE);
          return json(res, 200, { brand: { name: admin.brand.get().name }, admin: adminAccess.menuHint() }, NO_STORE);
        }
        // The scripts are public (Superset only includes them for signed-in users); everything else needs Superset's signature.
        const asset = /^\/(chat\.js|overlay\.js|mine\.js|chat\.css)$/.exec(url.pathname);
        // Someone the users rule leaves out gets an overlay that does nothing: no button, no chat (never cached).
        if (asset?.[1] === "overlay.js" && leftOut(req)) return send(res, 200, "/* The assistant isn't turned on for this account. */\n", TYPES[".js"]!);
        if (asset) return send(res, 200, readFileSync(join(web, asset[1]!), "utf8"), TYPES[asset[1]!.slice(asset[1]!.lastIndexOf("."))]!);
        const who = await signedIn();
        if (!who) return json(res, 401, { error: "sign in to Superset first" }, NO_STORE);
        // The users rule: left out, nothing here either (admins always pass, so their pages stay theirs).
        if (!mayUse(who)) return json(res, 403, { error: NOT_TURNED_ON_MESSAGE, code: "not-turned-on" }, NO_STORE);
        if (await adminPanel(req, res, url, who)) return;
        if (await packRoutes(req, res, url, who)) return;
        if (await querySafetyRoute(req, res, url, who, "/_superset", adminName)) return;
        await settingsPage(req, res, url, who);
        if (res.headersSent) return;
        if (await mine(req, res, url)) return;
        if (await actionLog(res, url, who)) return;
        if (url.pathname === "/_superset/bind") {
          const bound = await bind(url.searchParams.get("dashboard") ?? "", identityOf(req, idKey)?.d, who);
          return "refused" in bound ? json(res, 403, { error: bound.refused, ...(bound.code ? { code: bound.code } : {}) }, NO_STORE) : json(res, 200, bound, NO_STORE);
        }
        if (url.pathname === "/_superset/dashboards") {
          const list = await client.get<{ result: { id: number; dashboard_title: string; changed_on_delta_humanized: string }[] }>("/api/v1/dashboard/?q=(page_size:100,order_column:changed_on_delta_humanized,order_direction:desc)");
          // Lenspack's account sees every dashboard: list only those Superset lets this user open. Superset answers
          // for admins too (they open all), so the one rule is boardRights over what Superset said.
          let shown = list.result;
          if (hostPolicy === "superset") {
            const open = await viewableDashboards(client, who.user, shown.map((d) => d.id));
            const hiddenBoards = shown.filter((d) => !open.has(d.id)).map((d) => `superset-${d.id}`);
            shown = shown.filter((d) => boardRights({ ...who, hiddenBoards: [...(who.hiddenBoards ?? []), ...hiddenBoards] }, { id: `superset-${d.id}` }).view);
          } else shown = shown.filter((d) => boardRights(who, { id: `superset-${d.id}` }).view);
          return json(res, 200, shown.map((d) => ({ id: d.id, title: d.dashboard_title, changed: d.changed_on_delta_humanized })), NO_STORE);
        }
        const embed = /^\/superset\/(\d+)\/?$/.exec(url.pathname);
        if (embed) return send(res, 200, page("embed.html", { ...pageVars(req), dashboard: Number(embed[1]) }), TYPES[".html"]!);
        if (url.pathname === "/") return send(res, 200, page("index.html", pageVars(req)), TYPES[".html"]!);
        return json(res, 404, { error: "not found" }, NO_STORE);
      };
    },
    onListening: ({ providers }) => {
      log(`http://${host}:${port}/ (Superset ${supersetUrl}, ${Object.keys(dashboards).length} dashboard(s) bound, chat ${providers.length ? "on" : "off"}); admin pages at ${surface.surface === "separate" && adminAccess.modes.join(",") === "password" ? `${base}/_admin/` : `${surface.panel === "none" ? "Superset's /ai-assistant/" : `${base}/_superset/admin/`}${adminAccess.has("password") ? `, and ${base}/_admin/ for named passwords` : ""}`}`);
      void review.start();
    },
  });
}

/**
 * `lenspack query-check --config superset.yaml`: the dry run (dry-run.ts) from a terminal, before go-live. It reads
 * the same config as the server (the pack with any changes admins saved, the query limits with any an admin set),
 * signs in to Superset as Lenspack's account, and asks Superset to compile each query shape with result_type
 * "query": nothing is run. Returns the report and whether anything dangerous was found (exit code 1).
 */
export async function querySafetyCheck(path: string, o: { cap?: number; url?: string; username?: string } = {}, env: NodeJS.ProcessEnv = process.env) {
  const file = resolve(path);
  const dir = dirname(file);
  const config = resolveSecrets(YAML.parse(readFileSync(file, "utf8")) as SupersetConfig, env, { file, allowEmpty: true });
  const supersetUrl = o.url ?? config.superset?.url ?? env.LENSPACK_SUPERSET_URL;
  if (!supersetUrl) throw new Error(`${file}: say where Superset's API is, as superset.url, LENSPACK_SUPERSET_URL or --url`);
  const statePath = resolve(dir, config.state ?? (env.LENSPACK_STATE_DIR ? join(env.LENSPACK_STATE_DIR, "superset-boards.json") : "state/superset-boards.json"));
  const stateDir = dirname(statePath);
  const log = (s: string) => console.error(`lenspack query-check: ${s}`);
  const account = await serviceAccount({
    url: supersetUrl,
    username: o.username ?? config.superset?.username ?? "lenspack",
    stateDir,
    password: config.superset?.password ?? env[config.superset?.passwordEnv ?? "LENSPACK_SUPERSET_PASSWORD"] ?? undefined,
    admin: { username: env.SUPERSET_ADMIN_USERNAME, password: env.SUPERSET_ADMIN_PASSWORD },
    log,
  });
  const client = supersetClient({ url: supersetUrl, username: account.username, password: account.password });
  const datasets = await fetchDatasets(client, config.datasets, { log });
  const superset = await supersetVersion(client);
  // The pack as the server would run it: the deploy config's overlay with the changes admins saved over it.
  const saved = packLayerStore(stateDir, { log }).current();
  const overlay = saved.version ? applyPackLayer(config.overlay ?? {}, saved.layer as PackLayer) : (config.overlay ?? {});
  const built = buildPack(datasets, overlay, { scope: config.scope, capabilities: SUPERSET_CAPABILITIES, mapStyle: defaultMapStyle(superset.major) });
  const settings = settingsStore(stateDir);
  const safety = supersetQuerySafety({ config: config.querySafety, env, binding: () => built.binding, settings: { get: settings.get, set: () => {} }, log });
  const connector = guardedConnector(supersetConnector(client, built.binding), safety.guard);
  const report = await dryRun({ client, pack: built.pack, binding: built.binding, connector, safety: safety.current(), datasets, cap: o.cap });
  return { report, text: dryRunText(report), dangerous: report.findings.some((f) => f.level === "danger") };
}
