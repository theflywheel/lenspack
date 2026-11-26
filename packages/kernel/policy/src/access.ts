import { ADMIN_ROLE, type Rights, matchesEntry, principalOf } from "./index";

// Who is an admin: three ways, one chosen per deployment (auth.adminAccess, or LENSPACK_ADMIN_ACCESS). The host only says
// who someone is (Superset's signed user name, id and roles; or the password sign-in); which of them administers is
// decided here, by rightsUnder() as every caller is settled and by adminRights(). The modes are named for the Superset
// host, the one that offers them: "superset-role" means the host's roles, "superset-users" the host's user names or ids.
//
//   superset-role   Superset roles grant admin: the admins rule (auth.admins, LENSPACK_ADMIN_ROLES; default Admin). The default.
//   superset-users  only named Superset users: owners from the deployment (LENSPACK_ADMIN_USERS), and the users owners
//                   grant admin to from the admin pages. No role grants admin, not even Superset's Admin.
//   password        one shared password from the deployment's secrets (LENSPACK_ADMIN_PASSWORD), on a sign-in of its own.
//                   No Superset user is an admin; whoever signs in with it is "admin:password" in the audit log.
//
// Every misconfiguration fails closed: named users with no owners, or a password mode with no password, leave nobody an
// admin; an unknown mode is refused at start (adminAccessModeFrom throws).

export const ADMIN_ACCESS_MODES = ["superset-role", "superset-users", "password"] as const;
export type AdminAccessMode = (typeof ADMIN_ACCESS_MODES)[number];

/** The deployment's way of deciding admins, with what it needs now: the owners and the granted users (names or "id:<n>"). */
export type AdminAccess = { mode: "superset-role" } | { mode: "superset-users"; owners: readonly string[]; granted: readonly string[] } | { mode: "password" };

/** The one user the password sign-in signs in, as the audit log names them. */
export const PASSWORD_ADMIN = "admin:password";

/** The mode a config value or LENSPACK_ADMIN_ACCESS names; the environment wins. Absent: superset-role. Anything else: an error. */
export function adminAccessModeFrom(config: unknown, env?: string): AdminAccessMode {
  const raw = env?.trim() ? env : config;
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return "superset-role";
  const v = String(raw).trim().toLowerCase();
  if ((ADMIN_ACCESS_MODES as readonly string[]).includes(v)) return v as AdminAccessMode;
  throw new Error(`auth.adminAccess (LENSPACK_ADMIN_ACCESS) must be superset-role, superset-users or password, not "${String(raw)}"`);
}

/**
 * A list of users as a deployment writes it ("alice, id:12", or a YAML list): each a user name or "id:<n>", trimmed,
 * without blanks or repeats. A "role:" entry is refused: under named users, roles grant nothing.
 */
export function adminUsersFrom(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : value === undefined || value === null ? [] : null;
  if (!items) throw new Error("admin users must be a list of Superset user names or id:<n>, like alice,bob,id:12");
  const out: string[] = [];
  for (const raw of items) {
    if (typeof raw !== "string" && typeof raw !== "number") throw new Error("admin users must be user names or id:<n>");
    const e = String(raw).trim();
    if (!e) continue;
    if (e.startsWith("role:")) throw new Error(`admin users name people, not roles ("${e}"): with superset-users, roles grant nothing`);
    if (e.startsWith("id:") && !/^id:\d+$/.test(e)) throw new Error(`"${e}" is not a user id: write id: and the number Superset shows, like id:12`);
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * The host's rights under the access mode, as every caller is settled (principalOf):
 *   superset-role: the host's rights as they are (its admins rule over roles);
 *   superset-users: the admin role for the owners and granted users only (none when there is no owner), and user names
 *     on the admin pages for the same people; no role grants it;
 *   password: no host user holds the admin role; the password sign-in has rights of its own (PASSWORD_ADMIN_RIGHTS).
 * Who may use the assistant, edit or read data is the same in every mode.
 */
export function rightsUnder(access: AdminAccess, host: Rights): Rights {
  if (access.mode === "superset-role") return host;
  if (access.mode === "password") return { ...host, admins: [], usage: [] };
  const named = access.owners.length ? [...access.owners, ...access.granted.filter((g) => !access.owners.includes(g))] : [];
  return { ...host, admins: named, usage: named };
}

/** The rights of the password sign-in: the password admin holds the admin role and sees user names. */
export const PASSWORD_ADMIN_RIGHTS: Rights = { editors: [], maintainers: [], admins: [PASSWORD_ADMIN], usage: [PASSWORD_ADMIN] };

/** The password admin as a settled principal: Lenspack's admin role and the usage right, nothing on the data. */
export const passwordAdmin = () => principalOf({ user: PASSWORD_ADMIN, roles: [] }, PASSWORD_ADMIN_RIGHTS);

/** Whether this principal holds the admin role through the password sign-in (for the audit's words; the decision is adminRights). */
export const viaPassword = (who: { user: string; roles?: readonly string[] }) => who.user === PASSWORD_ADMIN && !!who.roles?.includes(ADMIN_ROLE);

// Who may use the assistant at all (the button, the chat, every data route), the same way: one or more modes, chosen per
// deployment (auth.userAccess, or LENSPACK_USER_ACCESS), comma-separated when combined ("superset-role,granted": either
// one lets a person in). Admins always may. A person let in still reads only what their own Superset access allows:
// this rule only switches the assistant on for them, it never widens what they see.
//
//   superset-role  the Superset roles in auth.users (LENSPACK_USER_ROLES). Alone and with no role named, everyone signed
//                  in, as before. In a combination it counts only the roles it names.
//   granted        people admins add by Superset user name or id:<n> on the admin pages, plus any seeded from the
//                  deployment (LENSPACK_USERS). None: nobody (but admins).
//   everyone       everyone signed in to Superset, whatever else is named. For a dedicated instance, not a shared one.

export const USER_ACCESS_MODES = ["superset-role", "granted", "everyone"] as const;
export type UserAccessMode = (typeof USER_ACCESS_MODES)[number];

/** The deployment's way of deciding who may use the assistant, with what it needs now. */
export type UserAccess = { modes: readonly UserAccessMode[]; seeded: readonly string[]; granted: readonly string[] };

/** The modes a config value or LENSPACK_USER_ACCESS names ("superset-role,granted"); the environment wins. Absent: superset-role. */
export function userAccessModesFrom(config: unknown, env?: string): UserAccessMode[] {
  const raw = env?.trim() ? env : config;
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return ["superset-role"];
  const parts = (Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,+\s]+/)).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const out: UserAccessMode[] = [];
  for (const p of parts) {
    if (!(USER_ACCESS_MODES as readonly string[]).includes(p)) throw new Error(`auth.userAccess (LENSPACK_USER_ACCESS) takes superset-role, granted and everyone, comma-separated, not "${p}"`);
    if (!out.includes(p as UserAccessMode)) out.push(p as UserAccessMode);
  }
  if (!out.length) throw new Error("auth.userAccess (LENSPACK_USER_ACCESS) names no mode: use superset-role, granted or everyone");
  return out;
}

/**
 * The users rule (Rights.users) under the user-access modes, as every caller is settled (principalOf, which always lets
 * admins in): undefined means everyone signed in. `roles` is the host's own users rule (auth.users as "role:" entries),
 * undefined when it names none.
 */
export function usersUnder(access: UserAccess, roles: readonly string[] | undefined): string[] | undefined {
  const m = new Set(access.modes);
  if (m.has("everyone")) return undefined;
  // superset-role alone, naming no role: everyone signed in, as before user access had modes.
  if (m.size === 1 && m.has("superset-role")) return roles ? [...roles] : undefined;
  const out: string[] = [];
  if (m.has("superset-role")) out.push(...(roles ?? []));
  if (m.has("granted")) for (const u of [...access.seeded, ...access.granted]) if (!out.includes(u)) out.push(u);
  return out;
}

/**
 * Whether this person may use the assistant under the user-access modes: an admin always, else whoever the rule names.
 * The same answer principalOf() settles as `uses` under rightsUnder()'s users rule; pure, for any caller.
 */
export function mayUseUnder(who: { user: string; userId?: string | number; roles?: readonly string[] }, access: UserAccess, roles: readonly string[] | undefined, admin = false): boolean {
  if (admin) return true;
  const rule = usersUnder(access, roles);
  return rule === undefined || rule.some((e) => e === "*" || matchesEntry(who, e, who.roles ?? []));
}
