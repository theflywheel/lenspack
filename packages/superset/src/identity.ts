// Who is asking, as Superset says. Lenspack is reached only through Superset's own /lenspack/ route
// (lenspack_superset.py), which checks the Superset session and then signs a short identity header
// for each request: the user, whether they are a Superset admin, the dashboard the request is about,
// and whether Superset would let them view and edit that dashboard. Lenspack keeps no users and
// trusts nothing else: a request without a valid, fresh signature is not signed in.
//
// The signing key is derived from Superset's SECRET_KEY on the Superset side and handed to
// Lenspack's service account on request, so neither side needs a second shared secret.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { type Access, type AuthAdapter, type Identity as Caller, NO_RIGHTS, withRights } from "@lenspack/serve";

export const IDENTITY_HEADER = "x-lenspack-identity";

/** What Superset signs for one request. */
export type Identity = {
  /** Superset username. */
  u: string;
  /** Superset admin (may change Lenspack's settings and read the audit log). */
  a: boolean;
  /** The dashboard this request is about, when it is about one. */
  d?: number | null;
  /** Superset would let this user edit that dashboard (owner with can_write on Dashboard, or admin). */
  e?: boolean;
  /** Superset would let this user view that dashboard. */
  v?: boolean;
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

/** Who the signed identity is to lenspack. A Superset admin has the role admin: the settings page and the audit log. */
export function callerOf(id: Identity, policy: EditPolicy, editsOn = true): Caller {
  const roles = id.a ? ["admin"] : [];
  if (!editsOn) return { user: id.u, roles, readOnly: EDITS_OFF_MESSAGE };
  if (canEdit(id, policy)) return { user: id.u, roles, edit: true, maintain: true };
  // Asks are fine; every edit tool answers with the refusal, which the model passes on.
  return { user: id.u, roles, readOnly: READ_ONLY_MESSAGE };
}

/** Superset's signed header as lenspack's sign-in, the only one in Superset mode: an unsigned request is not signed in. */
export function supersetAuth(key: () => string | null, policy: EditPolicy, editsOn: () => boolean = () => true): AuthAdapter {
  return {
    kind: "superset",
    identify: (req) => {
      const id = identityOf(req, key);
      return id ? callerOf(id, policy, editsOn()) : null;
    },
  };
}

/** The same as an access hook, for createApp without the runtime. */
export const supersetAccess = (key: () => string | null, policy: EditPolicy, editsOn?: () => boolean): Access => withRights(supersetAuth(key, policy, editsOn), NO_RIGHTS);
