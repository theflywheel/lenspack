import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";

import { type FilterClause, filterClauseSchema } from "@lenspack/core";
import { type Pack, operands, parseExpr } from "@lenspack/spec";
import { z } from "zod";

import { join, resolve } from "node:path";

import { oidcAdapter } from "./oidc";
import { passwordAdapter } from "./password";

// Who is asking, and what they may see and change. An auth adapter says who
// a caller is: the built-in admin with a password (the default), an OpenID
// Connect sign-in, the login proxy in front, or a bearer token. Above every
// adapter alike, lenspack applies the answer: the rights (editors,
// maintainers, usage) by user and role, the tenant and row scope to every
// query, and each pack's access rules to what the caller may see at all. A board someone makes is theirs: others see it once it is shared,
// and change it only by saving a copy. The pack's own boards, from its board
// files, are everyone's to read and a maintainer's to change.

export type Principal = {
  user: string;
  /** Narrows every query to this tenant. Must agree with a tenant the pack is pinned to. */
  tenant?: string;
  /** Row scope: filters every query carries, whatever the board asks. */
  scope?: FilterClause[];
  /** May make boards of their own, and change (ops, layout, revert, chat), share and delete them. */
  edit?: boolean;
  /** May also change the pack's own boards, for everyone. Implies edit. */
  maintain?: boolean;
  /** The packs this caller may open; absent means all. */
  packs?: string[];
  /** Roles and groups from the identity provider: what a pack's access rules match. */
  roles?: string[];
  /** May read the AI usage page, which names every user. Absent: as maintain. */
  usage?: boolean;
  /**
   * Set when the caller may read a board and ask about it, but not change it: the chat still answers,
   * and every edit tool replies with this message (e.g. "you can view this dashboard but not edit it").
   * Absent, a caller without the edit right gets 403 from the chat, as before.
   */
  readOnly?: string;
};

/** Decides who a request is. null: not signed in (401). */
export type Access = (req: IncomingMessage) => Principal | null | Promise<Principal | null>;

/**
 * Who an adapter says a caller is: a user and their roles, and what the
 * adapter itself grants (a token's rights, the admin's). The rights by role
 * are added above it (principalOf).
 */
export type Identity = { user: string; roles: string[]; tenant?: string; scope?: FilterClause[]; packs?: string[]; edit?: boolean; maintain?: boolean; usage?: boolean };

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
export type Rights = { editors: string[]; maintainers: string[]; usage?: string[] };
export const NO_RIGHTS: Rights = { editors: [], maintainers: [] };

/** The principal an identity is under the rights by user and role, whichever adapter named it. */
export function principalOf(id: Identity, rules: Rights = NO_RIGHTS): Principal {
  const { user, roles } = id;
  // A role: entry matches roles only, so a user named like one gets nothing from it.
  const among = (list: string[]) => list.some((e) => e === "*" || (e.startsWith("role:") ? roles.includes(e.slice(5)) : e === user));
  const maintain = !!id.maintain || among(rules.maintainers);
  const usage = id.usage ?? (rules.usage ? among(rules.usage) : maintain);
  return {
    user,
    roles,
    edit: maintain || !!id.edit || among(rules.editors),
    ...(maintain ? { maintain } : {}),
    usage,
    ...(id.tenant ? { tenant: id.tenant } : {}),
    ...(id.scope ? { scope: id.scope } : {}),
    ...(id.packs ? { packs: id.packs } : {}),
  };
}

/**
 * Who may open a pack, and what of it they see. Rules are tried in order and
 * the first whose roles the caller has decides: hide (or only) names the
 * dimensions and measures they may not (or only may) use, and scope adds row
 * filters to every query they run. A caller no rule matches does not see the
 * pack. A pack with no rules is open to everyone signed in.
 */
export const packRuleSchema = z
  .object({
    /** Roles or groups this rule is for; "*" for everyone signed in. */
    roles: z.array(z.string().min(1)).min(1),
    hide: z.array(z.string().min(1)).optional(),
    only: z.array(z.string().min(1)).optional(),
    scope: scopeSchema,
  })
  .strict()
  .refine((r) => !(r.hide && r.only), { message: "a rule has hide or only, not both" });
export type PackRule = z.infer<typeof packRuleSchema>;

/** What one caller may use of a pack. */
export type Grant = { hidden: ReadonlySet<string>; scope: FilterClause[] };
export const FULL_GRANT: Grant = { hidden: new Set(), scope: [] };

/**
 * The keys a rule keeps from its callers. A measure computed from a hidden
 * one is hidden with it: a ratio or a per-level target says what its parts are.
 * An unknown key is an error, so a typo cannot leave a key showing.
 */
export function hiddenKeys(pack: Pack, rule: PackRule): ReadonlySet<string> {
  const keys = [...pack.dimensions.map((d) => d.key), ...pack.measures.map((m) => m.key)];
  for (const k of [...(rule.hide ?? []), ...(rule.only ?? [])]) if (!keys.includes(k)) throw new Error(`an access rule of pack "${pack.pack}" names "${k}", which is not one of its dimensions or measures`);
  const hidden = new Set(rule.only ? keys.filter((k) => !rule.only!.includes(k)) : (rule.hide ?? []));
  const parts = (m: Pack["measures"][number]) => [...(m.derived ? operands(parseExpr(m.derived)) : []), ...Object.values(m.levels ?? {})];
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of pack.measures)
      if (!hidden.has(m.key) && parts(m).some((k) => hidden.has(k))) {
        hidden.add(m.key);
        grew = true;
      }
  }
  return hidden;
}

const grants = new WeakMap<PackRule, Grant>();
/** The caller's grant on a pack under its rules, or null: they may not open it. */
export function grantOf(pack: Pack, rules: PackRule[] | undefined, who: Principal): Grant | null {
  if (!rules) return FULL_GRANT;
  const rule = rules.find((r) => r.roles.some((role) => role === "*" || (who.roles ?? []).includes(role)));
  if (!rule) return null;
  let grant = grants.get(rule);
  if (!grant) grants.set(rule, (grant = { hidden: hiddenKeys(pack, rule), scope: rule.scope ?? [] }));
  return grant;
}

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

/** An adapter's identities as principals, under the rights by user and role. */
export const withRights = (adapter: AuthAdapter, rights: Rights): Access => async (req) => {
  const id = await adapter.identify(req);
  return id ? principalOf(id, rights) : null;
};

/** Appends one JSON line per event. */
export function fileAudit(path: string): Audit {
  return (event) => appendFileSync(path, `${JSON.stringify(event)}\n`);
}
