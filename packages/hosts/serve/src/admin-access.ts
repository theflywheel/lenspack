import { type AdminAccess, type AdminAccessMode, type AdminRights, type Rights, type UserAccess, type UserAccessMode, adminAccessModesFrom, adminMenuHint, adminRights, adminUsersFrom, rightsUnder, userAccessModesFrom, usersUnder } from "@lenspack/policy";

import { adminApiKeys, adminApiKeysFrom } from "./admin-api-key";
import { type AdminPassword, adminPasswordsFrom } from "./admin-signin";
import type { AuditEvent } from "./audit";
import type { SettingsStore } from "./settings";

// How a deployment decides who is an admin (@lenspack/policy, access.ts), read from its config and environment, with the
// one piece of state it needs: the admins that owners grant from the admin pages under "superset-users". The decision
// stays in the kernel (rightsUnder, adminRights); this file reads the settings, keeps the grants and says what is in force.

/** One admin an owner granted: who, by whom, when. `user` is a Superset user name, or "id:<n>". */
export type AdminGrant = { user: string; by: string; at: string };

/** Where granted admins are kept. The settings store's file by default (settingsGrants); a durable store may stand in. */
export interface AdminGrantStore {
  list(): readonly AdminGrant[];
  /** Adds one; false when already there. */
  add(grant: AdminGrant): boolean;
  /** Removes one; false when it was not there. */
  remove(user: string): boolean;
}

/**
 * Grants kept in settings.json, like every other change an admin makes on a running server: admins an owner granted
 * (section "adminGrants") or people an admin let use the assistant (section "userGrants").
 */
export function settingsGrants(settings: SettingsStore, section: "adminGrants" | "userGrants" = "adminGrants"): AdminGrantStore {
  const read = () => settings.get<AdminGrant[]>(section) ?? [];
  return {
    list: read,
    add(g) {
      const now = read();
      if (now.some((x) => x.user === g.user)) return false;
      settings.set(section, [...now, g]);
      return true;
    },
    remove(user) {
      const now = read();
      const next = now.filter((x) => x.user !== user);
      if (next.length === now.length) return false;
      settings.set(section, next.length ? next : undefined);
      return true;
    },
  };
}

/** Plain words for a mode, for the admin pages and the start-up line. */
export const ADMIN_ACCESS_LABELS: Record<AdminAccessMode, string> = {
  "superset-role": "Superset roles",
  "superset-users": "named Superset users",
  password: "named passwords",
};

export type AdminAccessConfig = {
  /** superset-role (default), superset-users, password, or password with one of the others; LENSPACK_ADMIN_ACCESS wins. */
  adminAccess?: string | string[];
  /** Owners under superset-users: Superset user names or id:<n>; LENSPACK_ADMIN_USERS (comma-separated) wins. */
  adminUsers?: string[] | string;
};

/** One person who has used admin rights, and how they qualified: the admins roster. */
export type AdminSeen = {
  user: string;
  userId?: string | number;
  /** role, owner, grant or password; and the role's or password's name. */
  via: NonNullable<AdminRights["via"]>;
  detail?: string;
  firstSeen: string;
  lastSeen: string;
  /** When their visit before this one ended: who became an admin since is news to them. */
  prevVisit?: string;
};

/** Where the roster is kept. The settings store's file by default (settingsRoster); a durable store may stand in. */
export interface AdminRosterStore {
  list(): readonly AdminSeen[];
  put(entry: AdminSeen): void;
}

/** The roster in settings.json (section "adminRoster"), beside the grants. */
export function settingsRoster(settings: SettingsStore): AdminRosterStore {
  const read = () => settings.get<AdminSeen[]>("adminRoster") ?? [];
  return {
    list: read,
    put(e) {
      const now = read();
      const i = now.findIndex((x) => x.user === e.user);
      settings.set("adminRoster", i < 0 ? [...now, e] : now.map((x, j) => (j === i ? e : x)));
    },
  };
}

/** How someone qualifies, in words, for the roster and the audit line. */
export function viaWords(r: Pick<AdminSeen, "via" | "detail">): string {
  if (r.via === "role") return r.detail ? `Superset role ${r.detail}` : "a Superset role";
  if (r.via === "owner") return "owner";
  if (r.via === "grant") return "granted by an owner";
  if (r.via === "api-key") return `API key ${r.detail ?? ""}`.trim();
  return r.detail && r.detail !== "password" ? `named password ${r.detail}` : "the shared password";
}

export type AdminAccessSetup = ReturnType<typeof adminAccessSetup>;

/**
 * The access modes in force and what they need. Throws on an unknown mode, a refused combination, a bad user list or a
 * bad password entry (the server does not start); a mode that leaves nobody an admin (named users with no owner, the
 * password with none set) starts, says so in a warning, and lets nobody in that way.
 */
export function adminAccessSetup(o: { config?: AdminAccessConfig; env?: NodeJS.ProcessEnv; grants: AdminGrantStore; roster?: AdminRosterStore; adminRoles?: readonly string[]; adminRolesFrom?: string; now?: () => number; log?: (line: string) => void }) {
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now;
  const fromEnv = !!env.LENSPACK_ADMIN_ACCESS?.trim();
  const modes = adminAccessModesFrom(o.config?.adminAccess, env.LENSPACK_ADMIN_ACCESS);
  const has = (m: AdminAccessMode) => modes.includes(m);
  const modeFrom = fromEnv ? "LENSPACK_ADMIN_ACCESS" : o.config?.adminAccess !== undefined ? "auth.adminAccess" : "default";
  const ownersEnv = env.LENSPACK_ADMIN_USERS?.trim();
  const owners = has("superset-users") ? adminUsersFrom(ownersEnv ? ownersEnv : o.config?.adminUsers) : [];
  const ownersFrom = ownersEnv ? "LENSPACK_ADMIN_USERS" : o.config?.adminUsers !== undefined ? "auth.adminUsers" : null;
  // Read only when the mode is on: a password set for another mode stops nothing, and is said to do nothing.
  const passwords: AdminPassword[] = has("password") ? adminPasswordsFrom(env) : [];
  const passwordSources = [...new Set(passwords.map((p) => p.from))];
  const passwordSet = passwords.length > 0;
  const roles = o.adminRoles ?? ["Admin"];
  let audit: ((e: AuditEvent) => void) | undefined;
  const roleEntries = roles.map((r) => (r.startsWith("role:") || r === "*" ? r : `role:${r}`));
  const granted = () => (has("superset-users") ? o.grants.list().map((g) => g.user).filter((u) => !owners.includes(u)) : []);
  // Admin API keys: beside the modes, read in every one (admin-api-key.ts). A bad entry stops the server at start.
  const apiKeys = adminApiKeys({ keys: adminApiKeysFrom(env), audit: (e) => audit?.(e), log: o.log, now });
  const state = (): AdminAccess => ({ modes, roles: roleEntries, owners, granted: granted(), passwords: passwords.map((p) => p.name), apiKeys: apiKeys.names });
  const warnings: string[] = [];
  if (has("superset-users") && !owners.length) warnings.push("admin access includes superset-users, but no owner is named: nobody is an admin that way. Set LENSPACK_ADMIN_USERS (Superset user names or id:<n>, comma-separated).");
  if (has("password") && !passwordSet) warnings.push("admin access includes password, but no admin password is set: nobody signs in that way. Set LENSPACK_ADMIN_PASSWORDS (name:secret pairs) or LENSPACK_ADMIN_PASSWORDS_FILE from the deployment's secrets.");
  if (!has("superset-users") && (ownersEnv || o.config?.adminUsers !== undefined)) warnings.push(`LENSPACK_ADMIN_USERS is set but admin access is ${modes.join(",")}: it has no effect. Add superset-users to LENSPACK_ADMIN_ACCESS to use it.`);
  if (!has("password") && (env.LENSPACK_ADMIN_PASSWORDS || env.LENSPACK_ADMIN_PASSWORDS_FILE || env.LENSPACK_ADMIN_PASSWORD || env.LENSPACK_ADMIN_PASSWORD_HASH))
    warnings.push(`an admin password is set but admin access is ${modes.join(",")}: it has no effect. Add password to LENSPACK_ADMIN_ACCESS to use it.`);
  if (has("superset-role") && roles.length === 1 && roles[0] === "Admin")
    warnings.push("admins are Superset's own Admin role: every Superset Admin is an assistant admin. A role of its own (LENSPACK_ADMIN_ROLES) keeps the two apart; superset-users stops Superset Admins from making themselves admins.");

  // Each mode's words; the last one's parentheses take the "access …" part, as the single-mode lines always read.
  const lineFor = (m: AdminAccessMode): { text: string; tail?: string } => {
    if (m === "superset-role") return { text: `Superset role${roles.length === 1 ? "" : "s"} ${roles.join(", ") || "(none)"}${o.adminRolesFrom ? ` from ${o.adminRolesFrom}` : ""}` };
    if (m === "superset-users") return { text: `named Superset users (${owners.length} owner${owners.length === 1 ? "" : "s"}${ownersFrom ? ` from ${ownersFrom}` : ""}, ${granted().length} granted)`, ...(owners.length ? {} : { tail: ": NOBODY, no owner named" }) };
    return passwordSet ? { text: `named passwords (${passwords.length} from ${passwordSources.join(", ")})` } : { text: "named passwords (none set)", tail: ": NOBODY signs in with a password" };
  };

  return {
    modes,
    has,
    modeFrom,
    owners,
    ownersFrom,
    grants: o.grants,
    state,
    warnings,
    /** What a host's menu needs to show its admin entry by itself (adminMenuHint): a hint, never a right. */
    menuHint: () => adminMenuHint(state()),
    /** The admin passwords, for the admin sign-in (adminSignIn). Their secrets go nowhere else. */
    passwords,
    /** The admin API keys (admin-api-key.ts): their names, and the check a request's key goes through. */
    apiKeys,
    /** Whether the admin sign-in is on: the password mode with a password set. */
    passwordSignIn: has("password") && passwordSet,
    /** Where the "first use" audit lines go (the host's audit log, made after this). */
    auditTo(fn: ((e: AuditEvent) => void) | undefined) {
      audit = fn;
    },
    /**
     * Someone just used admin rights: on the roster, with how they qualify. The first time (or a new way to qualify),
     * an audit line says so. Their last-seen time is written at most every 10 minutes; a gap of 30 starts a new visit.
     */
    seen(who: { user: string; userId?: string | number; roles?: readonly string[]; usage?: boolean }) {
      if (!o.roster) return;
      const r = adminRights(who, state());
      if (!r.administer || !r.via) return;
      const t = now();
      const at = new Date(t).toISOString();
      const old = o.roster.list().find((e) => e.user === who.user);
      const how = { via: r.via, ...(r.detail ? { detail: r.detail } : {}) };
      if (!old) {
        o.roster.put({ user: who.user, ...(who.userId !== undefined ? { userId: who.userId } : {}), ...how, firstSeen: at, lastSeen: at });
        audit?.({ at, user: who.user, action: "admin first use", outcome: "ok", detail: viaWords(how) });
        return;
      }
      const changed = old.via !== how.via || old.detail !== how.detail;
      const gap = t - Date.parse(old.lastSeen);
      if (!changed && gap < 10 * 60_000) return;
      o.roster.put({ ...old, ...how, ...(how.detail ? {} : { detail: undefined }), lastSeen: at, ...(gap >= 30 * 60_000 ? { prevVisit: old.lastSeen } : {}) });
      if (changed) audit?.({ at, user: who.user, action: "admin qualifies another way", outcome: "ok", detail: `${viaWords(old)} → ${viaWords(how)}` });
    },
    /** The start-up line: each mode, where it came from, and who it names. Never a password. */
    line(): string {
      const how = `access ${modes.join(",")}, ${modeFrom === "default" ? "the default" : `from ${modeFrom}`}`;
      const parts = modes.map(lineFor);
      const last = parts[parts.length - 1]!.text;
      const words = [...parts.slice(0, -1).map((x) => x.text), last.endsWith(")") ? `${last.slice(0, -1)}; ${how})` : `${last} (${how})`].join(", or ");
      return `admins: ${words}${parts.map((x) => x.tail ?? "").join("")}`;
    },
    /** What the admin pages show: the modes in plain words and where they are set, the owners and grants, and the roster. */
    view(me?: { owner: boolean; user?: string }) {
      const roster = [...(o.roster?.list() ?? [])].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
      const mine = me?.user ? roster.find((e) => e.user === me.user) : undefined;
      const since = mine?.prevVisit;
      return {
        mode: modes.join(","),
        modes,
        label: modes.map((m) => ADMIN_ACCESS_LABELS[m]).join(" or "),
        from: modeFrom,
        ...(has("superset-role") ? { roles, rolesFrom: o.adminRolesFrom ?? "default" } : {}),
        ...(has("superset-users") ? { owners, ownersFrom, granted: o.grants.list().filter((g) => !owners.includes(g.user)), canGrant: !!me?.owner } : {}),
        ...(has("password") ? { passwordSet, passwordNames: passwords.map((p) => p.name), passwordsFrom: passwordSources } : {}),
        // The admin API keys' names and where they are set, in every mode (never a key).
        apiKeys: { names: apiKeys.names, from: apiKeys.sources },
        roster: roster.map(({ prevVisit: _p, ...e }) => ({ ...e, how: viaWords(e) })),
        // Who first used admin rights after this admin's previous visit ended: news for them.
        newSince: since ? roster.filter((e) => e.user !== me!.user && e.firstSeen > since).map((e) => ({ user: e.user, how: viaWords(e), firstSeen: e.firstSeen })) : [],
        warnings,
      };
    },
  };
}

/** Plain words for a user-access mode. */
export const USER_ACCESS_LABELS: Record<UserAccessMode, string> = {
  "superset-role": "Superset roles",
  granted: "people granted here",
  everyone: "everyone signed in",
};

export type UserAccessConfig = {
  /** superset-role (default), granted, everyone, or a combination ("superset-role,granted"); LENSPACK_USER_ACCESS wins. */
  userAccess?: string | string[];
  /** People who may always use it under granted, from the deployment: user names or id:<n>; LENSPACK_USERS wins. */
  seedUsers?: string[] | string;
};

export type UserAccessSetup = ReturnType<typeof userAccessSetup>;

/**
 * Who may use the assistant, in force: the modes, the host's users rule over roles (auth.users as "role:" entries, or
 * undefined), the seeded people and the grants. Throws on an unknown mode; "granted" with nobody granted starts, says so
 * and lets nobody in but admins.
 */
export function userAccessSetup(o: { config?: UserAccessConfig; env?: NodeJS.ProcessEnv; grants: AdminGrantStore; roles?: readonly string[]; rolesFrom?: string }) {
  const env = o.env ?? process.env;
  const modes = userAccessModesFrom(o.config?.userAccess, env.LENSPACK_USER_ACCESS);
  const modesFrom = env.LENSPACK_USER_ACCESS?.trim() ? "LENSPACK_USER_ACCESS" : o.config?.userAccess !== undefined ? "auth.userAccess" : "default";
  const has = (m: UserAccessMode) => modes.includes(m);
  const seedEnv = env.LENSPACK_USERS?.trim();
  const seeded = has("granted") ? adminUsersFrom(seedEnv ? seedEnv : o.config?.seedUsers) : [];
  const seededFrom = seedEnv ? "LENSPACK_USERS" : o.config?.seedUsers !== undefined ? "auth.seedUsers" : null;
  const granted = () => (has("granted") ? o.grants.list().map((g) => g.user).filter((u) => !seeded.includes(u)) : []);
  const state = (): UserAccess => ({ modes, seeded, granted: granted() });
  const roles = o.roles;
  const warnings: string[] = [];
  if (has("everyone")) warnings.push("user access is everyone: anyone signed in to Superset may use the assistant. Use it on a dedicated instance, not a shared one.");
  if (has("granted") && !has("everyone") && !seeded.length && !o.grants.list().length && !(has("superset-role") && roles?.length))
    warnings.push("user access is granted, and nobody is granted yet: only admins can use the assistant until an admin adds people on the admin pages (or LENSPACK_USERS seeds some).");
  if (has("superset-role") && modes.length > 1 && !has("everyone") && !roles?.length) warnings.push("user access combines superset-role with granted, but no role is named (auth.users, LENSPACK_USER_ROLES): roles let nobody in, only grants do.");
  return {
    modes,
    modesFrom,
    seeded,
    seededFrom,
    grants: o.grants,
    granting: has("granted"),
    state,
    warnings,
    /** The users rule now (undefined: everyone signed in). */
    rule: () => usersUnder(state(), roles),
    line(): string {
      const how = `access ${modes.join(",")}, ${modesFrom === "default" ? "the default" : `from ${modesFrom}`}`;
      const rule = usersUnder(state(), roles);
      if (rule === undefined) return `users: everyone signed in (${how})`;
      const names = (roles ?? []).map((r) => r.replace(/^role:/, ""));
      const parts = modes.map((m) => (m === "superset-role" ? (names.length ? `Superset role${names.length === 1 ? "" : "s"} ${names.join(", ")}` : "no Superset role") : `${seeded.length} seeded${seededFrom ? ` from ${seededFrom}` : ""} and ${granted().length} granted`));
      return `users: ${parts.join(", or ")} and admins (${how})`;
    },
    view() {
      return {
        modes,
        label: modes.map((m) => USER_ACCESS_LABELS[m]).join(" or "),
        from: modesFrom,
        ...(has("superset-role") ? { roles: (roles ?? []).map((r) => r.replace(/^role:/, "")), rolesFrom: o.rolesFrom ?? null } : {}),
        ...(has("granted") ? { seeded, seededFrom, granted: o.grants.list().filter((g) => !seeded.includes(g.user)).length } : {}),
        everyone: usersUnder(state(), roles) === undefined,
        warnings,
      };
    },
  };
}

/**
 * The host's rights with both rules applied and read on every request, so a grant or a revoke applies to the next page
 * load or request: the admins and usage rules under the admin access mode, the users rule under the user-access modes.
 */
export function accessRights(host: Rights, admin?: AdminAccessSetup, user?: UserAccessSetup): Rights {
  return {
    editors: host.editors,
    maintainers: host.maintainers,
    get admins() {
      return admin ? rightsUnder(admin.state(), host).admins : host.admins;
    },
    get usage() {
      return admin ? rightsUnder(admin.state(), host).usage : host.usage;
    },
    get users() {
      return user ? user.rule() : host.users;
    },
  } as Rights;
}
