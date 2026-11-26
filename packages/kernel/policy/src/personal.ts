// People's own dashboards and saved layouts: who may make, copy and delete a dashboard, and save, apply,
// rename and delete a layout. Pure functions of what the host says about the person and the dashboard (who
// they are, their host user id, whether they are an admin, whether the host lets them write dashboards at all,
// what the host lets them view and edit, who owns a dashboard) and the deployment's switch and limits. The host acts through its own service account, so
// these decisions are the only thing between a person and a dashboard that isn't theirs: they never grant
// more than the host does, and a missing fact counts as "no".

/** The deployment's switch and per-person limits. */
export type PersonalLimits = { on: boolean; maxDashboardsPerUser: number; maxSavedLayoutsPerUser: number };
export const PERSONAL_DEFAULTS: PersonalLimits = { on: true, maxDashboardsPerUser: 20, maxSavedLayoutsPerUser: 50 };

import { adminRights } from "./index";

/**
 * Who is asking, as the host signed it: their name, their roles (an admin is whoever adminRights() says) and
 * `userId`, the host's own id for them, needed to make a dashboard theirs there. `writes`: the host lets them write
 * dashboards at all (Superset: can_write on Dashboard); without it they make, copy, delete and apply nothing, as the
 * host itself would refuse them. `hostRoles` are the host's own role names, which only telemetry records (they grant
 * nothing here).
 */
export type PersonalActor = { user: string; userId?: number | null; roles?: readonly string[]; writes?: boolean; hostRoles?: readonly string[] };

/** Admins as the rest of policy knows them (adminRights), so these rules and the settings pages agree. */
const isAdmin = (who: Pick<PersonalActor, "roles">) => adminRights(who).administer;

export type PersonalRefusal = "off" | "limit" | "no-user-id" | "no-view" | "no-edit" | "no-write" | "not-yours" | "not-own";
export type Verdict = { ok: true } | { ok: false; code: PersonalRefusal; why: string };

const OK: Verdict = { ok: true };
const no = (code: PersonalRefusal, why: string): Verdict => ({ ok: false, code, why });

const OFF = no("off", "Personal dashboards and saved layouts are turned off on this deployment.");
/** The host doesn't let them write dashboards at all; an admin role in Lenspack doesn't change that. */
export const NO_WRITE_MESSAGE = "Your role lets you view dashboards but not make or change them, so nothing was made or changed. Whoever manages your access can give you a role that may.";
const NO_WRITE = no("no-write", NO_WRITE_MESSAGE);
const NO_ID = no("no-user-id", "Superset did not say who you are in a way Lenspack can give a dashboard to you (update lenspack_superset.py in Superset), so nothing was made.");

function room(limits: PersonalLimits, owned: number): Verdict {
  return owned < limits.maxDashboardsPerUser ? OK : no("limit", `You already have ${owned} dashboards of your own, the most this deployment allows (${limits.maxDashboardsPerUser}). Delete one first.`);
}

/** A new, blank dashboard of the person's own. */
export function mayCreateDashboard(who: PersonalActor, limits: PersonalLimits, owned: number): Verdict {
  if (!limits.on) return OFF;
  if (!who.writes) return NO_WRITE;
  if (!who.userId) return NO_ID;
  return room(limits, owned);
}

/** A copy of a dashboard, the person's own: only of one the host lets them view. */
export function mayCopyDashboard(who: PersonalActor, limits: PersonalLimits, owned: number, source: { view: boolean }): Verdict {
  if (!limits.on) return OFF;
  if (!source.view) return no("no-view", "You can't view that dashboard in Superset, so it can't be copied for you.");
  if (!who.writes) return NO_WRITE;
  if (!who.userId) return NO_ID;
  return room(limits, owned);
}

/**
 * Deleting a dashboard: its owner, or an admin when it is a personal dashboard (one made or copied through Lenspack).
 * `owners` are the host's user ids for the dashboard's owners, read from the host at the time. Lenspack's admin role
 * comes from its own rule, not the host's, so it reaches only what Lenspack made: any other dashboard is its owners'
 * to delete, in the host.
 */
export function mayDeleteDashboard(who: PersonalActor, limits: PersonalLimits, dashboard: { owners: number[]; personal?: boolean }): Verdict {
  if (!limits.on) return OFF;
  if (!who.writes) return NO_WRITE;
  if (who.userId && dashboard.owners.includes(who.userId)) return OK;
  if (dashboard.personal && isAdmin(who)) return OK;
  return no("not-yours", dashboard.personal ? "That dashboard isn't yours, so it was not deleted. Only its owners and admins can delete it." : "That dashboard isn't yours, so it was not deleted. Only its owners can delete it.");
}

/** Saving a dashboard's layout under a name: any dashboard the person may view, up to the limit. */
export function maySaveLayout(who: PersonalActor, limits: PersonalLimits, owned: number, source: { view: boolean }, replacing = false): Verdict {
  if (!limits.on) return OFF;
  if (!source.view) return no("no-view", "You can't view that dashboard in Superset, so its layout was not saved.");
  if (!replacing && owned >= limits.maxSavedLayoutsPerUser) return no("limit", `You already have ${owned} saved layouts, the most this deployment allows (${limits.maxSavedLayoutsPerUser}). Delete one first.`);
  return OK;
}

/** A saved layout is its owner's to see, apply, rename and delete; admins see and manage everyone's. */
export function mayManageLayout(who: PersonalActor, limits: PersonalLimits, layout: { owner: string }): Verdict {
  if (!limits.on) return OFF;
  return layout.owner === who.user || isAdmin(who) ? OK : no("not-yours", "That saved layout isn't yours.");
}

/**
 * Applying a saved layout to a dashboard: the layout must be the person's (or they an admin), and they must
 * be allowed to edit the dashboard (`edit`, as the host and the edit policy decide it for them). Otherwise
 * they can make their own copy first.
 */
export function mayApplyLayout(who: PersonalActor, limits: PersonalLimits, layout: { owner: string }, target: { edit: boolean }): Verdict {
  const mine = mayManageLayout(who, limits, layout);
  if (!mine.ok) return mine;
  if (!who.writes) return NO_WRITE;
  return target.edit ? OK : no("no-edit", "You can't edit this dashboard, so the layout was not applied. Make your own copy of it first, then apply the layout there.");
}

/** The admin view of everyone's personal dashboards and saved layouts. */
export const mayViewAllPersonal = (who: PersonalActor): Verdict => (isAdmin(who) ? OK : no("not-yours", "Only admins can see everyone's dashboards and layouts."));

/** The saved layouts a person is shown: their own; an admin, everyone's. */
/**
 * The personal dashboards this person may not open: everyone else's, unless they are an admin. Lenspack's own rule,
 * narrower than Superset's (which lets anyone open a draft dashboard with no roles by its address), so a dashboard
 * of one's own stays one's own. The host puts these in Identity.hiddenBoards, which boardRights() honours.
 */
export const hiddenPersonalBoards = (who: PersonalActor, all: readonly { board: string; owner: string; ownerId?: number | null }[]): string[] =>
  isAdmin(who) ? [] : all.filter((d) => d.owner !== who.user && !(who.userId && d.ownerId === who.userId)).map((d) => d.board);

export const layoutsShownTo = <L extends { owner: string }>(who: PersonalActor, all: L[]): L[] => (isAdmin(who) ? all : all.filter((l) => l.owner === who.user));

/** Limits from config and environment, checked; anything missing takes the default. */
export function personalLimitsFrom(config: { on?: unknown; maxDashboardsPerUser?: unknown; maxSavedConfigsPerUser?: unknown } | undefined, env: Record<string, string | undefined> = {}): PersonalLimits {
  const int = (name: string, v: unknown, fallback: number) => {
    if (v === undefined || v === null || v === "") return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new Error(`${name} must be a whole number from 0 to 10000, not "${String(v)}"`);
    return n;
  };
  return {
    on: config?.on === false ? false : PERSONAL_DEFAULTS.on,
    maxDashboardsPerUser: int("maxDashboardsPerUser", env.LENSPACK_MAX_DASHBOARDS_PER_USER ?? config?.maxDashboardsPerUser, PERSONAL_DEFAULTS.maxDashboardsPerUser),
    maxSavedLayoutsPerUser: int("maxSavedConfigsPerUser", env.LENSPACK_MAX_SAVED_CONFIGS_PER_USER ?? config?.maxSavedConfigsPerUser, PERSONAL_DEFAULTS.maxSavedLayoutsPerUser),
  };
}

/**
 * Where the chat may change dashboards. "superset" (the default): any dashboard the host lets the person edit.
 * "own": only the person's own dashboards (made or copied through Lenspack, theirs); on any other, even one
 * the host lets them edit, the edit is refused and they can make their own copy. Admins are exempt unless
 * `adminsExempt` is false. It narrows the host's rights, never widens them.
 */
export type EditScope = { scope: "superset" | "own"; adminsExempt: boolean };
export const EDIT_SCOPE_DEFAULT: EditScope = { scope: "superset", adminsExempt: true };

export const NOT_OWN_MESSAGE = "On this deployment, the chat changes only dashboards of your own, so nothing was changed on this one.";
export const NOBODY_EDITS_MESSAGE =
  "On this deployment, the chat changes only dashboards of one's own, and those are turned off, so nothing was changed. Make the change in Superset, or ask a question about the data instead.";

/** What boardRights() needs to apply an "own" edit scope to one caller (Identity.editScope). */
export type EditScopeFacts = { own: string[]; adminsExempt: boolean; why: string };

/**
 * The edit scope as facts about one caller, for boardRights(): none under "superset"; under "own", the boards that
 * are theirs (none while personal dashboards are off, so nobody but exempt admins edits) and the refusal elsewhere.
 */
export function editScopeFacts(scope: EditScope, s: { own: string[]; personalOn: boolean }): EditScopeFacts | undefined {
  if (scope.scope === "superset") return undefined;
  return s.personalOn ? { own: s.own, adminsExempt: scope.adminsExempt, why: NOT_OWN_MESSAGE } : { own: [], adminsExempt: scope.adminsExempt, why: NOBODY_EDITS_MESSAGE };
}

/** Whether the edit scope (if any) lets this caller change this board: theirs, or they are an exempt admin. */
export function inEditScope(who: { roles?: readonly string[]; editScope?: EditScopeFacts }, board?: string): boolean {
  const s = who.editScope;
  if (!s) return true;
  if (s.adminsExempt && isAdmin(who)) return true;
  return board !== undefined && s.own.includes(board);
}

/** A warning for an admin when the settings together leave the chat unable to change anything; null when they don't. */
export function editScopeWarning(scope: EditScope, s: { personalOn: boolean; editsOn: boolean }): string | null {
  if (scope.scope !== "own" || !s.editsOn || s.personalOn) return null;
  return `editScope is "own" but personal dashboards are off, so nobody${scope.adminsExempt ? " but admins" : ""} can change dashboards through the chat. Turn personalDashboards on, or set editScope back to "superset".`;
}

/** The edit scope from config (`"own"`, or `{scope, adminsExempt}`) and environment (LENSPACK_EDIT_SCOPE, LENSPACK_EDIT_SCOPE_ADMINS_EXEMPT, which win), checked. */
export function editScopeFrom(config: unknown, env: Record<string, string | undefined> = {}): EditScope {
  const c = typeof config === "string" ? { scope: config } : config && typeof config === "object" ? (config as { scope?: unknown; adminsExempt?: unknown }) : {};
  const scopeOf = (v: unknown, where: string): EditScope["scope"] => {
    const t = String(v ?? "").trim().toLowerCase();
    if (t === "" || t === "superset") return "superset";
    if (t === "own") return "own";
    throw new Error(`${where} must be "superset" or "own", not "${String(v)}"`);
  };
  const flag = (v: unknown, where: string, fallback: boolean): boolean => {
    if (v === undefined || v === null || v === "") return fallback;
    if (v === true || v === false) return v;
    const t = String(v).trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(t)) return true;
    if (["false", "0", "no", "off"].includes(t)) return false;
    throw new Error(`${where} must be true or false, not "${String(v)}"`);
  };
  return {
    scope: env.LENSPACK_EDIT_SCOPE !== undefined && env.LENSPACK_EDIT_SCOPE !== "" ? scopeOf(env.LENSPACK_EDIT_SCOPE, "LENSPACK_EDIT_SCOPE") : scopeOf(c.scope, "editScope"),
    adminsExempt: flag(env.LENSPACK_EDIT_SCOPE_ADMINS_EXEMPT ?? c.adminsExempt, "editScope.adminsExempt", EDIT_SCOPE_DEFAULT.adminsExempt),
  };
}
