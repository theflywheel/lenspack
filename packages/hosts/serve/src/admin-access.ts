import { type AdminAccess, type AdminAccessMode, type Rights, type UserAccess, type UserAccessMode, adminAccessModeFrom, adminUsersFrom, rightsUnder, userAccessModesFrom, usersUnder } from "@lenspack/policy";

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
  password: "one shared password",
};

export type AdminAccessConfig = {
  /** superset-role (default), superset-users or password; LENSPACK_ADMIN_ACCESS wins. */
  adminAccess?: string;
  /** Owners under superset-users: Superset user names or id:<n>; LENSPACK_ADMIN_USERS (comma-separated) wins. */
  adminUsers?: string[] | string;
};

export type AdminAccessSetup = ReturnType<typeof adminAccessSetup>;

/**
 * The access mode in force and what it needs. Throws on an unknown mode or a bad user list (the server does not start);
 * a mode that leaves nobody an admin (named users with no owner, the password with none set) starts, says so in a
 * warning, and lets nobody in.
 */
export function adminAccessSetup(o: { config?: AdminAccessConfig; env?: NodeJS.ProcessEnv; grants: AdminGrantStore; adminRoles?: readonly string[]; adminRolesFrom?: string }) {
  const env = o.env ?? process.env;
  const fromEnv = !!env.LENSPACK_ADMIN_ACCESS?.trim();
  const mode = adminAccessModeFrom(o.config?.adminAccess, env.LENSPACK_ADMIN_ACCESS);
  const modeFrom = fromEnv ? "LENSPACK_ADMIN_ACCESS" : o.config?.adminAccess !== undefined ? "auth.adminAccess" : "default";
  const ownersEnv = env.LENSPACK_ADMIN_USERS?.trim();
  const owners = mode === "superset-users" ? adminUsersFrom(ownersEnv ? ownersEnv : o.config?.adminUsers) : [];
  const ownersFrom = ownersEnv ? "LENSPACK_ADMIN_USERS" : o.config?.adminUsers !== undefined ? "auth.adminUsers" : null;
  const passwordSet = !!(env.LENSPACK_ADMIN_PASSWORD || env.LENSPACK_ADMIN_PASSWORD_HASH);
  const granted = () => (mode === "superset-users" ? o.grants.list().map((g) => g.user).filter((u) => !owners.includes(u)) : []);
  const state = (): AdminAccess => (mode === "superset-users" ? { mode, owners, granted: granted() } : { mode });
  const warnings: string[] = [];
  if (mode === "superset-users" && !owners.length) warnings.push("admin access is superset-users, but no owner is named: nobody is an admin. Set LENSPACK_ADMIN_USERS (Superset user names or id:<n>, comma-separated).");
  if (mode === "password" && !passwordSet) warnings.push("admin access is password, but no password is set: nobody is an admin. Set LENSPACK_ADMIN_PASSWORD (12+ characters) from the deployment's secrets.");
  if (mode !== "superset-users" && (ownersEnv || o.config?.adminUsers !== undefined)) warnings.push(`LENSPACK_ADMIN_USERS is set but admin access is ${mode}: it has no effect. Set LENSPACK_ADMIN_ACCESS=superset-users to use it.`);
  const roles = o.adminRoles ?? ["Admin"];
  return {
    mode,
    modeFrom,
    owners,
    ownersFrom,
    grants: o.grants,
    state,
    warnings,
    /** Whether the password sign-in is on: password mode with a password set. */
    passwordSignIn: mode === "password" && passwordSet,
    /** The start-up line: the mode, where it came from, and who it names. Never the password. */
    line(): string {
      const how = `access ${mode}, ${modeFrom === "default" ? "the default" : `from ${modeFrom}`}`;
      if (mode === "superset-role") return `admins: Superset role${roles.length === 1 ? "" : "s"} ${roles.join(", ") || "(none)"}${o.adminRolesFrom ? ` from ${o.adminRolesFrom}` : ""} (${how})`;
      if (mode === "superset-users") {
        const g = granted().length;
        return `admins: named Superset users (${owners.length} owner${owners.length === 1 ? "" : "s"}${ownersFrom ? ` from ${ownersFrom}` : ""}, ${g} granted; ${how})${owners.length ? "" : ": NOBODY, no owner named"}`;
      }
      return `admins: one shared password (${passwordSet ? `${env.LENSPACK_ADMIN_PASSWORD ? "LENSPACK_ADMIN_PASSWORD" : "LENSPACK_ADMIN_PASSWORD_HASH"} set` : "NOT SET: nobody is an admin"}; ${how})`;
    },
    /** What the admin pages show: the mode in plain words and where it is set, and under named users the owners and grants. */
    view(me?: { owner: boolean }) {
      return {
        mode,
        label: ADMIN_ACCESS_LABELS[mode],
        from: modeFrom,
        ...(mode === "superset-role" ? { roles, rolesFrom: o.adminRolesFrom ?? "default" } : {}),
        ...(mode === "superset-users" ? { owners, ownersFrom, granted: o.grants.list().filter((g) => !owners.includes(g.user)), canGrant: !!me?.owner } : {}),
        ...(mode === "password" ? { passwordSet } : {}),
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
