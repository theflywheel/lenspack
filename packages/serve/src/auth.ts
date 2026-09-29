import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";

import { type FilterClause, filterClauseSchema } from "@lenspack/core";
import { z } from "zod";

// Who is asking, and what they may see and change. lenspack keeps no users of
// its own: the deployment says who a caller is (a bearer token it issued, or
// headers from the login proxy in front of it), and lenspack applies the
// answer — the tenant and row scope to every query, the edit right to every
// change.

export type Principal = {
  user: string;
  /** Narrows every query to this tenant. Must agree with a tenant the pack is pinned to. */
  tenant?: string;
  /** Row scope: filters every query carries, whatever the board asks. */
  scope?: FilterClause[];
  /** May change boards (ops, layout, revert, chat, create, delete). */
  edit?: boolean;
  /** The packs this caller may open; absent means all. */
  packs?: string[];
};

/** Decides who a request is. null: not signed in (401). */
export type Access = (req: IncomingMessage) => Principal | null | Promise<Principal | null>;

export type AuditEvent = {
  at: string;
  user: string;
  pack?: string;
  board?: string;
  action: string;
  outcome: "ok" | "refused" | "denied";
  detail?: string;
};
export type Audit = (event: AuditEvent) => void;

const scopeSchema = z.array(filterClauseSchema).optional();

export const authSchema = z.discriminatedUnion("kind", [
  // Explicitly open: anyone who reaches the port may read and edit.
  z.object({ kind: z.literal("none") }),
  // Bearer tokens the deployment issues. Each token is an env: reference.
  z.object({
    kind: z.literal("tokens"),
    users: z
      .array(
        z.object({
          user: z.string().min(1),
          token: z.string().min(1),
          edit: z.boolean().default(false),
          tenant: z.string().optional(),
          scope: scopeSchema,
          packs: z.array(z.string()).optional(),
        }),
      )
      .min(1),
  }),
  // A login proxy in front (oauth2-proxy, an ingress with SSO) names the user
  // in a header. Headers are trusted only with the proxy's shared secret, so a
  // caller that reaches lenspack directly cannot claim to be anyone.
  z.object({
    kind: z.literal("proxy"),
    secret: z.string().min(1),
    secretHeader: z.string().default("x-lenspack-proxy-secret"),
    userHeader: z.string().default("x-forwarded-user"),
    tenantHeader: z.string().optional(),
    /** Users who may edit; "*" for everyone the proxy lets in. */
    editors: z.array(z.string()).default([]),
  }),
]);
export type AuthConfig = z.infer<typeof authSchema>;

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Equal-time comparison, so a token cannot be guessed a byte at a time. */
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** The Access a lenspack.yaml `auth:` block describes (secrets already resolved). */
export function accessFrom(auth: AuthConfig): Access | undefined {
  switch (auth.kind) {
    case "none":
      return undefined;
    case "tokens":
      return (req) => {
        const m = /^Bearer\s+(\S+)$/i.exec(header(req, "authorization") ?? "");
        if (!m) return null;
        // Every entry is compared, so timing does not reveal which one matched.
        let found: (typeof auth.users)[number] | null = null;
        for (const u of auth.users) if (same(m[1]!, u.token)) found = u;
        if (!found) return null;
        return { user: found.user, edit: found.edit, ...(found.tenant ? { tenant: found.tenant } : {}), ...(found.scope ? { scope: found.scope } : {}), ...(found.packs ? { packs: found.packs } : {}) };
      };
    case "proxy":
      // Checked after env: references are read: a short secret is guessable.
      if (auth.secret.length < 16) throw new Error("auth.proxy secret must be at least 16 characters");
      return (req) => {
        const secret = header(req, auth.secretHeader);
        if (!secret || !same(secret, auth.secret)) return null;
        const user = header(req, auth.userHeader);
        if (!user) return null;
        const tenant = auth.tenantHeader ? header(req, auth.tenantHeader) : undefined;
        return { user, edit: auth.editors.includes("*") || auth.editors.includes(user), ...(tenant ? { tenant } : {}) };
      };
  }
}

/** Appends one JSON line per event. */
export function fileAudit(path: string): Audit {
  return (event) => appendFileSync(path, `${JSON.stringify(event)}\n`);
}
