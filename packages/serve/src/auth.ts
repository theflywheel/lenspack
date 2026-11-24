import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { filterClauseSchema } from "@lenspack/core";
import { type Identity, NO_RIGHTS, type Principal as Settled, type Rights, principalOf } from "@lenspack/policy";
import { z } from "zod";

import { join, resolve } from "node:path";

import { oidcAdapter } from "./oidc";
import { passwordAdapter } from "./password";

// How a caller signs in. An auth adapter says who a caller is: the built-in
// admin with a password (the default), an OpenID Connect sign-in, the login
// proxy in front, or a bearer token. Above every adapter alike, the rights by
// user and role and each pack's access rules apply (@lenspack/policy).

export { type Identity, NO_RIGHTS, type PackRule, type Rights, hiddenKeys, packRuleSchema, principalOf } from "@lenspack/policy";

/** What an access hook answers: an Identity. The name is kept for hooks written against it; @lenspack/policy's Principal is the settled one. */
export type Principal = Identity;

/** Decides who a request is. null: not signed in (401). */
export type Access = (req: IncomingMessage) => Identity | null | Promise<Identity | null>;

/** One way of signing in. auth.kind in lenspack.yaml (or LENSPACK_AUTH) picks it. */
export interface AuthAdapter {
  readonly kind: string;
  /** Who a request is; null: not signed in. */
  identify(req: IncomingMessage): Identity | null | Promise<Identity | null>;
  /** Answers the adapter's own paths (/auth/login, /auth/callback, /auth/logout); false for any other. */
  handle?(req: IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<boolean>;
  /** Where a page request without a session is sent; absent, the page is served (a proxy in front signs people in). */
  signInPath?(url: URL): string;
  /** The UI's sign-out link. */
  signOutUrl?: string;
}

const scopeSchema = z.array(filterClauseSchema).optional();

// Who gets which right, for the sign-ins that name users rather than list
// them: a user name, "role:<name>" for anyone with that role or group, or "*".
const roleRules = {
  /** May make and change boards of their own. */
  editors: z.array(z.string()).default([]),
  /** May also change the pack's own boards. */
  maintainers: z.array(z.string()).default([]),
  /** May read the AI usage page; absent, the maintainers may. */
  usage: z.array(z.string()).optional(),
};

export const authSchema = z.discriminatedUnion("kind", [
  // Explicitly open, for a local demo: anyone who reaches the port may read
  // and edit. It listens on 127.0.0.1 unless host: says otherwise.
  z.object({ kind: z.literal("none") }),
  // The default: one built-in user, admin, with every right and the role
  // admin. The password is LENSPACK_ADMIN_PASSWORD (or a scrypt hash in
  // LENSPACK_ADMIN_PASSWORD_HASH); with neither, one is made at first start
  // and written once to <dir>/admin-password.txt.
  z.object({
    kind: z.literal("password"),
    password: z.string().min(1).optional(),
    passwordHash: z.string().min(1).optional(),
    /** Where a made password's hash, its one-time file and the session key are kept; default LENSPACK_STATE_DIR, else .lenspack next to lenspack.yaml. */
    dir: z.string().optional(),
    /** The address people use (https://lens.example.com): changes must come from it; https marks the cookie Secure. */
    baseUrl: z.string().url().optional(),
    sessionSecret: z.string().min(1).optional(),
    sessionHours: z.number().positive().max(720).default(8),
    ...roleRules,
  }),
  // Bearer tokens the deployment issues. Each token is an env: reference.
  z.object({
    kind: z.literal("tokens"),
    users: z
      .array(
        z.object({
          user: z.string().min(1),
          token: z.string().min(1),
          edit: z.boolean().default(false),
          maintain: z.boolean().default(false),
          tenant: z.string().optional(),
          scope: scopeSchema,
          packs: z.array(z.string()).optional(),
          roles: z.array(z.string()).optional(),
          usage: z.boolean().optional(),
        }),
      )
      .min(1),
    ...roleRules,
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
    /** The proxy's roles or groups header, comma-separated (oauth2-proxy: x-forwarded-groups). */
    rolesHeader: z.string().optional(),
    ...roleRules,
    /** Where the UI's sign-out link goes: the proxy's sign-out, which may pass on to the identity provider's. */
    signOutUrl: z.string().optional(),
  }),
  // lenspack signs people in itself, with an OpenID Connect provider.
  z.object({
    kind: z.literal("oidc"),
    /** The issuer URL; its /.well-known/openid-configuration is read. */
    issuer: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).optional(),
    /** Where people reach lenspack; the identity provider sends them back to <baseUrl>/auth/callback. */
    baseUrl: z.string().url(),
    /** Signs the session cookie: 32+ characters, an env: reference. */
    sessionSecret: z.string().min(1),
    /** How long a sign-in lasts; roles are read again at the next. */
    sessionHours: z.number().positive().max(720).default(8),
    scopes: z.array(z.string()).default(["openid", "profile", "email"]),
    userClaim: z.string().default("preferred_username"),
    /** Claims (dotted paths) that hold roles or groups: "groups", "realm_access.roles", "resource_access.<client>.roles". */
    rolesClaims: z.array(z.string()).default(["groups"]),
    tenantClaim: z.string().optional(),
    ...roleRules,
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

/** The auth block in force: lenspack.yaml's, or LENSPACK_AUTH's kind, or the default, password. */
export function effectiveAuth(auth: AuthConfig | undefined, env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const kind = env.LENSPACK_AUTH?.trim();
  if (kind && kind !== auth?.kind) {
    const parsed = authSchema.safeParse({ kind });
    if (!parsed.success) throw new Error(`LENSPACK_AUTH=${kind} needs its settings in lenspack.yaml (auth: { kind: ${kind}, ... }), or is not a kind (none, password, oidc, proxy, tokens)`);
    return parsed.data;
  }
  return auth ?? authSchema.parse({ kind: "password" });
}

/**
 * The adapter an auth block describes (secrets already resolved), and the
 * rights above it. none has no adapter: the server is open.
 */
export function authFrom(auth: AuthConfig, opts: { dir?: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {}): { adapter?: AuthAdapter; rights: Rights } {
  const env = opts.env ?? process.env;
  switch (auth.kind) {
    case "none":
      return { rights: NO_RIGHTS };
    case "password": {
      // The yaml's password or hash if it names one, else the environment's; a password beats a hash.
      const named = auth.password !== undefined || auth.passwordHash !== undefined;
      const password = named ? auth.password : env.LENSPACK_ADMIN_PASSWORD || undefined;
      const passwordHash = named ? auth.passwordHash : env.LENSPACK_ADMIN_PASSWORD_HASH || undefined;
      const base = opts.dir ?? process.cwd();
      const dir = auth.dir ? resolve(base, auth.dir) : env.LENSPACK_STATE_DIR ? resolve(env.LENSPACK_STATE_DIR) : join(base, ".lenspack");
      const adapter = passwordAdapter({
        ...(password ? { password } : passwordHash ? { passwordHash } : {}),
        dir,
        sessionHours: auth.sessionHours,
        ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
        ...(auth.sessionSecret ? { sessionSecret: auth.sessionSecret } : {}),
        log: opts.log,
      });
      return { adapter, rights: auth };
    }
    case "oidc":
      return { adapter: oidcAdapter(auth), rights: auth };
    case "tokens":
      return {
        rights: auth,
        adapter: {
          kind: "tokens",
          identify: (req) => {
            const m = /^Bearer\s+(\S+)$/i.exec(header(req, "authorization") ?? "");
            if (!m) return null;
            // Every entry is compared, so timing does not reveal which one matched.
            let found: (typeof auth.users)[number] | null = null;
            for (const u of auth.users) if (same(m[1]!, u.token)) found = u;
            if (!found) return null;
            return {
              user: found.user,
              roles: found.roles ?? [],
              edit: found.edit || found.maintain,
              maintain: found.maintain,
              ...(found.usage !== undefined ? { usage: found.usage } : {}),
              ...(found.tenant ? { tenant: found.tenant } : {}),
              ...(found.scope ? { scope: found.scope } : {}),
              ...(found.packs ? { packs: found.packs } : {}),
            };
          },
        },
      };
    case "proxy":
      // Checked after env: references are read: a short secret is guessable.
      if (auth.secret.length < 16) throw new Error("auth.proxy secret must be at least 16 characters");
      return {
        rights: auth,
        adapter: {
          kind: "proxy",
          ...(auth.signOutUrl ? { signOutUrl: auth.signOutUrl } : {}),
          identify: (req) => {
            const secret = header(req, auth.secretHeader);
            if (!secret || !same(secret, auth.secret)) return null;
            const user = header(req, auth.userHeader);
            if (!user) return null;
            const tenant = auth.tenantHeader ? header(req, auth.tenantHeader) : undefined;
            const roles = auth.rolesHeader ? (header(req, auth.rolesHeader) ?? "").split(",").map((r) => r.trim()).filter(Boolean) : [];
            return { user, roles, ...(tenant ? { tenant } : {}) };
          },
        },
      };
  }
}

/** The Access a lenspack.yaml `auth:` block describes (secrets already resolved): its adapter with the rights above it. */
export function accessFrom(auth: AuthConfig, opts: Parameters<typeof authFrom>[1] = {}): Access | undefined {
  const { adapter, rights } = authFrom(auth, opts);
  return adapter ? withRights(adapter, rights) : undefined;
}

/** An adapter's identities as settled principals, under the rights by user and role. */
export const withRights = (adapter: AuthAdapter, rights: Rights): ((req: IncomingMessage) => Promise<Settled | null>) => async (req) => {
  const id = await adapter.identify(req);
  return id ? principalOf(id, rights) : null;
};
