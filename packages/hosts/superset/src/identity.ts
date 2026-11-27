// Who is asking, as Superset says. Lenspack is reached only through Superset's own /lenspack/ route
// (lenspack_superset.py), which checks the Superset session and then signs a short identity header
// for each request: the user, whether they are a Superset admin, the dashboard the request is about,
// and whether Superset would let them view and edit that dashboard. Lenspack keeps no users and
// trusts nothing else: a request without a valid, fresh signature is not signed in.
//
// The rights on a dashboard hold for that dashboard only. Lenspack reads the board from its own
// route (apiRoute, the parts the board API acts on) and refuses a request whose board is not the
// one Superset signed for, so a path that names one dashboard to Superset and another to Lenspack
// gets nowhere. The admin pages (settings, the admin panel, the audit log, the usage page) go by Lenspack's own
// admins rule over the signed Superset role names (auth.admins, by default Superset's Admin role), never by a board
// right and never by the signed admin flag itself.
//
// The signing key is derived from Superset's SECRET_KEY on the Superset side and handed to
// Lenspack's service account on request, so neither side needs a second shared secret.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { type Identity as Caller, type EditScopeFacts, type Rights } from "@lenspack/policy";
import { type AuthAdapter, NO_STORE, apiRoute, json, withRights } from "@lenspack/serve";

import type { HostPolicy } from "./access";

export const IDENTITY_HEADER = "x-lenspack-identity";

/** What Superset signs for one request. */
export type Identity = {
  /** Superset username. */
  u: string;
  /**
   * Superset admin. It counts only as Superset's own right to edit every dashboard (canEdit); Lenspack's admin pages
   * go by the admins rule over `r` instead (supersetRights).
   */
  a: boolean;
  /** The dashboard this request is about, when it is about one. */
  d?: number | null;
  /** The board the rights below are for, as Superset read it from the path: superset-<d>. Older plugins sign only d. */
  b?: string;
  /** The pack in that path. Older plugins do not sign it. */
  p?: string;
  /** Superset would let this user edit that dashboard (owner with can_write on Dashboard, or admin). */
  e?: boolean;
  /** Superset would let this user view that dashboard. */
  v?: boolean;
  /** The user's Superset role names. */
  r?: string[];
  /**
   * Superset lets this user write dashboards at all (can_write on Dashboard, or admin): making, copying, deleting
   * and laying out their own dashboards need it. Older plugins do not sign it; then only a Superset admin may.
   */
  w?: boolean;
  /** The user's Superset id, so a dashboard Lenspack makes for them can be theirs in Superset. Older plugins do not sign it. */
  i?: number;
  /** Signed at, unix seconds. */
  t: number;
};

/** "superset": edit what Superset lets you edit (the default). "signed-in": anyone signed in may edit. */
export type EditPolicy = "superset" | "signed-in";

export const READ_ONLY_MESSAGE =
  "You can view this dashboard but not edit it in Superset, so nothing was changed. Ask a dashboard owner or an admin to make the change, or ask a question about the data instead.";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** The header value: base64url(JSON) "." hex HMAC-SHA256 of that base64url string. */
export function signIdentity(identity: Identity, key: string): string {
  const body = b64url(JSON.stringify(identity));
  return `${body}.${createHmac("sha256", key).update(body).digest("hex")}`;
}

/** The identity in a header value, or null when it is missing, forged, malformed or stale. */
export function verifyIdentity(value: string | undefined, key: string, opts: { now?: number; maxAgeSeconds?: number } = {}): Identity | null {
  if (!value || !key) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1), "hex");
  const want = createHmac("sha256", key).update(body).digest();
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  let id: Identity;
  try {
    id = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!id || typeof id.u !== "string" || !id.u || typeof id.t !== "number") return null;
  const now = opts.now ?? Date.now() / 1000;
  // Superset signs per request, so a header older than this is a replay (clocks: one host or NTP).
  if (Math.abs(now - id.t) > (opts.maxAgeSeconds ?? 300)) return null;
  return id;
}

export function editPolicyFrom(value: string | undefined): EditPolicy {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "superset") return "superset";
  if (v === "signed-in") return "signed-in";
  throw new Error(`LENSPACK_EDIT_POLICY must be "superset" or "signed-in", not "${value}"`);
}

/**
 * The role rules from superset.yaml's auth (admins, usage, users: lists of Superset role names) and the environment
 * (LENSPACK_ADMIN_ROLES, LENSPACK_USAGE_ROLES, LENSPACK_USER_ROLES: comma-separated, and they win), checked.
 * Superset signs people in, so auth takes nothing else.
 */
export function roleRulesFrom(auth: unknown, env: Record<string, string | undefined> = {}): SupersetRoleRules {
  if (auth !== undefined && auth !== null && (typeof auth !== "object" || Array.isArray(auth))) throw new Error("auth must be a map, like auth: { admins: [Admin] }");
  const given = (auth ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(given)) if (k !== "admins" && k !== "usage" && k !== "users") throw new Error(`auth.${k} is not a setting in Superset mode, where Superset signs people in: auth takes admins, usage and users (lists of Superset role names)`);
  const list = (key: "admins" | "usage" | "users", envName: string): readonly string[] | undefined => {
    const fromEnv = env[envName];
    if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.split(",").map((r) => r.trim()).filter(Boolean);
    const v = given[key];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.some((r) => typeof r !== "string" || !r.trim())) throw new Error(`auth.${key} must be a list of Superset role names, like [Admin]`);
    return v.map((r: string) => r.trim());
  };
  const admins = list("admins", "LENSPACK_ADMIN_ROLES");
  const usage = list("usage", "LENSPACK_USAGE_ROLES");
  const users = list("users", "LENSPACK_USER_ROLES");
  return { ...(admins ? { admins } : {}), ...(usage ? { usage } : {}), ...(users ? { users } : {}) };
}

/** The identity a request carries, or null. */
export function identityOf(req: IncomingMessage, key: () => string | null): Identity | null {
  const k = key();
  if (!k) return null;
  const raw = req.headers[IDENTITY_HEADER];
  return verifyIdentity(Array.isArray(raw) ? raw[0] : raw, k);
}

/** What one identity may do under a policy. */
export const EDITS_OFF_MESSAGE =
  "Changing dashboards through the chat is turned off on this deployment, so nothing was changed. Make the change in Superset, or ask a question about the data instead.";

/** Whether this person may change the dashboard through the chat: the off switch first, then the policy. */
export function canEdit(id: Identity, policy: EditPolicy, editsOn = true): boolean {
  return editsOn && (policy === "signed-in" || id.a || id.e === true);
}

/** Superset roles that hold Lenspack's admin role when the config names none (auth.admins): Superset's own Admin. */
export const DEFAULT_SUPERSET_ADMINS: readonly string[] = ["Admin"];

/**
 * The user's Superset role names as signed. A plugin too old to sign them (no r) still signs the admin flag, which
 * Superset sets for its Admin role: that counts as the role, so the default rule reads it as before.
 */
export const rolesOf = (id: Identity): string[] => (Array.isArray(id.r) ? id.r.filter((r): r is string => typeof r === "string") : id.a === true ? [...DEFAULT_SUPERSET_ADMINS] : []);

/**
 * Who holds Lenspack's admin role and the usage right, and who may use the assistant at all, under Superset, by
 * Superset role name (superset.yaml auth).
 */
export type SupersetRoleRules = { admins?: readonly string[]; usage?: readonly string[]; users?: readonly string[] };

/**
 * Superset role names as Lenspack's rights by role: the admins rule (default Superset's Admin) and the usage right
 * (who may see user names on the usage board; default the same roles as admins), and the users rule (who may use
 * the assistant at all; default everyone signed in, and admins always). Edit rights stay Superset's own
 * (editPolicy). A name may carry lenspack.yaml's "role:" prefix; it means the same.
 */
export function supersetRights(o: SupersetRoleRules = {}): Rights {
  const asRoles = (names: readonly string[]) => names.map((n) => (n.startsWith("role:") ? n : `role:${n}`));
  const admins = o.admins ?? DEFAULT_SUPERSET_ADMINS;
  return { editors: [], maintainers: [], admins: asRoles(admins), usage: asRoles(o.usage ?? admins), ...(o.users ? { users: asRoles(o.users) } : {}) };
}

/**
 * Who the signed identity is to lenspack: the user and their Superset role names, which the deployment's rights
 * (supersetRights) read for the admin role and the usage right, and Superset's own edit right on the dashboard.
 */
export function callerOf(id: Identity, policy: EditPolicy, editsOn = true): Caller {
  const roles = rolesOf(id);
  if (!editsOn) return { user: id.u, roles, readOnly: EDITS_OFF_MESSAGE };
  if (canEdit(id, policy)) return { user: id.u, roles, edit: true, maintain: true };
  // Asks are fine; every edit tool answers with the refusal, which the model passes on.
  return { user: id.u, roles, readOnly: READ_ONLY_MESSAGE };
}

/**
 * What the deployment adds about one identity, as facts for policy: its edit scope (for one Superset lets edit),
 * boards it may not open (other people's own dashboards) and, under dashboardScope: listed, the only boards the
 * assistant is on (onlyBoards). All only narrow.
 */
export type CallerFacts = (id: Identity, o: { edit: boolean }) => Promise<{ editScope?: EditScopeFacts; hiddenBoards?: string[]; onlyBoards?: string[] }>;

/** Lenspack's name for a Superset dashboard's board. */
const DASHBOARD_BOARD = /^superset-\d+$/;

/** The board an identity's dashboard rights are for: b, else superset-<d> (as plugins before b sign it), else none. */
export function signedBoard(id: Identity): string | null {
  if (typeof id.b === "string" && id.b) return id.b;
  return typeof id.d === "number" && Number.isSafeInteger(id.d) ? `superset-${id.d}` : null;
}

/** A "." or ".." path segment (also as %2e), or an encoded slash or backslash. Superset's route forwards none of them. */
const DOTTED = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|%2f|%5c|\\/i;

/** Why a request target's path is refused before anything reads it, or null. */
export function pathRefusal(target: string | undefined): string | null {
  const path = (target ?? "/").split("?")[0]!;
  return DOTTED.test(path) ? "a path with a dot segment or an encoded slash is not accepted" : null;
}

/**
 * Whether one request may go ahead under its signed identity, and whether the identity's dashboard rights (e) apply
 * to it. They apply only when the board API's own route names the board Superset signed for (and the pack, when
 * signed). Refused: a dot segment or an encoded slash in the path; a dashboard board Superset did not sign for; any
 * other board, pack or none on a request that carries a dashboard's rights; a dashboard the user may not view.
 */
export function boardCheck(id: Identity, target: string | undefined): { refused: string | null; onBoard: boolean } {
  const bad = pathRefusal(target);
  if (bad) return { refused: bad, onBoard: false };
  const route = apiRoute(target);
  // Off the board API (the settings page, binding a dashboard), nothing goes by a board right.
  if (!route.api) return { refused: null, onBoard: false };
  const signed = signedBoard(id);
  const other = "This request names another dashboard than the one Superset checked your rights on, so it was refused.";
  if (signed === null) return { refused: route.board && DASHBOARD_BOARD.test(route.board) ? other : null, onBoard: false };
  if (route.board !== signed) return { refused: other, onBoard: false };
  if (id.p !== undefined && decodePart(route.pack) !== id.p) return { refused: other, onBoard: false };
  if (id.v === false) return { refused: "You don't have access to this dashboard in Superset.", onBoard: false };
  return { refused: null, onBoard: true };
}

const decodePart = (s: string | undefined) => {
  try {
    return s === undefined ? undefined : decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Superset's signed header as lenspack's sign-in, the only one in Superset mode: an unsigned request is not signed in.
 * A dashboard's rights count only on that dashboard's board (boardCheck); a request that names another is refused
 * with 403 before the board API reads it, and is not signed in at all for anything that skips that step.
 * With a host policy (hostPolicy: superset), the user's own Superset roles, dataset access and row-level security
 * come with them, and policy narrows every query by those rather than by the service account's.
 */
export function supersetAuth(key: () => string | null, policy: EditPolicy, editsOn: () => boolean = () => true, host?: HostPolicy, extra?: CallerFacts, rights: Rights = supersetRights()): AuthAdapter {
  return {
    kind: "superset",
    // Superset's role names, read by the deployment's role rules: the admin role and the usage right.
    rights,
    handle: async (req, res) => {
      const id = identityOf(req, key);
      const refused = id ? boardCheck(id, req.url).refused : null;
      if (!refused) return false;
      json(res, 403, { error: refused }, NO_STORE);
      return true;
    },
    identify: async (req) => {
      const id = identityOf(req, key);
      if (!id) return null;
      const check = boardCheck(id, req.url);
      if (check.refused) return null;
      let caller = callerOf(check.onBoard ? id : { ...id, e: false }, policy, editsOn());
      // The deployment's own facts for policy (boardRights narrows by them, never widens): read per request.
      const facts = extra ? await extra(id, { edit: !!caller.edit }) : {};
      if (facts.editScope) caller = { ...caller, editScope: facts.editScope };
      if (facts.onlyBoards) caller = { ...caller, onlyBoards: facts.onlyBoards };
      const ownHidden = facts.hiddenBoards ?? [];
      if (!host) return ownHidden.length ? { ...caller, hiddenBoards: ownHidden } : caller;
      const access = await host(id.u, id.r);
      // The dashboard Superset just checked this user may view opens, whatever an older answer said.
      const signed = check.onBoard ? signedBoard(id) : null;
      const fromHost = access.hiddenBoards?.filter((b) => b !== signed);
      const hiddenBoards = fromHost || ownHidden.length ? [...(fromHost ?? []), ...ownHidden] : undefined;
      return { ...caller, ...access, ...(hiddenBoards ? { hiddenBoards } : {}) };
    },
  };
}

/**
 * "superset" (the default): each user's Superset roles, dataset access and RLS narrow what they see, failing closed.
 * "off", only when chosen: every answer uses Lenspack's service account (an Admin), so anyone signed in reads every
 * configured dataset in full.
 */
export function hostPolicyFrom(value: string | undefined): "superset" | "off" {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "superset") return "superset";
  if (v === "off") return "off";
  throw new Error(`LENSPACK_HOST_POLICY (hostPolicy) must be "superset" or "off", not "${value}"`);
}

/** The same as an access hook, for createApp without the runtime. */
export const supersetAccess = (key: () => string | null, policy: EditPolicy, editsOn?: () => boolean, rights: Rights = supersetRights()) => withRights(supersetAuth(key, policy, editsOn, undefined, undefined, rights), rights);
