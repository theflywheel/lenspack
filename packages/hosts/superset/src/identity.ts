// Who is asking, as Superset says. Lenspack is reached only through Superset's own /lenspack/ route
// (lenspack_superset.py), which checks the Superset session and then signs a short identity header
// for each request: the user, whether they are a Superset admin, the dashboard the request is about,
// and whether Superset would let them view and edit that dashboard. Lenspack keeps no users and
// trusts nothing else: a request without a valid, fresh signature is not signed in.
//
// The rights on a dashboard hold for that dashboard only. Lenspack reads the board from its own
// route (apiRoute, the parts the board API acts on) and refuses a request whose board is not the
// one Superset signed for, so a path that names one dashboard to Superset and another to Lenspack
// gets nowhere. The usage page and the settings go by the signed admin flag, never by a board right.
//
// The signing key is derived from Superset's SECRET_KEY on the Superset side and handed to
// Lenspack's service account on request, so neither side needs a second shared secret.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { type Identity as Caller, type EditScopeFacts, NO_RIGHTS } from "@lenspack/policy";
import { type AuthAdapter, NO_STORE, apiRoute, json, withRights } from "@lenspack/serve";

import type { HostPolicy } from "./access";

export const IDENTITY_HEADER = "x-lenspack-identity";

/** What Superset signs for one request. */
export type Identity = {
  /** Superset username. */
  u: string;
  /** Superset admin (may change Lenspack's settings and read the audit log). */
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

/**
 * Who the signed identity is to lenspack. A Superset admin has the role admin (the settings page and the audit log)
 * and the usage right: the usage page names every user's spend, so it goes by the admin flag, never by a dashboard's
 * edit right.
 */
export function callerOf(id: Identity, policy: EditPolicy, editsOn = true): Caller {
  const roles = id.a ? ["admin"] : [];
  const usage = id.a === true;
  if (!editsOn) return { user: id.u, roles, usage, readOnly: EDITS_OFF_MESSAGE };
  if (canEdit(id, policy)) return { user: id.u, roles, usage, edit: true, maintain: true };
  // Asks are fine; every edit tool answers with the refusal, which the model passes on.
  return { user: id.u, roles, usage, readOnly: READ_ONLY_MESSAGE };
}

/**
 * What the deployment adds about one identity, as facts for policy: its edit scope (for one Superset lets edit) and
 * boards it may not open (other people's own dashboards). Both only narrow.
 */
export type CallerFacts = (id: Identity, o: { edit: boolean }) => Promise<{ editScope?: EditScopeFacts; hiddenBoards?: string[] }>;

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
export function supersetAuth(key: () => string | null, policy: EditPolicy, editsOn: () => boolean = () => true, host?: HostPolicy, extra?: CallerFacts): AuthAdapter {
  return {
    kind: "superset",
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
      const ownHidden = facts.hiddenBoards ?? [];
      if (!host) return ownHidden.length ? { ...caller, hiddenBoards: ownHidden } : caller;
      const access = await host(id.u, id.r);
      // The dashboard Superset just checked this user may view opens, whatever an older answer said.
      const signed = check.onBoard ? signedBoard(id) : null;
      const fromHost = access.hiddenBoards?.filter((b) => b !== signed);
      const hiddenBoards = fromHost || ownHidden.length ? [...(fromHost ?? []), ...ownHidden] : undefined;
      // "admin" stays the signed admin flag's: a Superset role of that name grants nothing here.
      return { ...caller, roles: [...(caller.roles ?? []), ...(id.r ?? []).filter((r) => r !== "admin")], ...access, ...(hiddenBoards ? { hiddenBoards } : {}) };
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
export const supersetAccess = (key: () => string | null, policy: EditPolicy, editsOn?: () => boolean) => withRights(supersetAuth(key, policy, editsOn), NO_RIGHTS);
