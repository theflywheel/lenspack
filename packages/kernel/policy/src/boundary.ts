import { filterClauseSchema } from "@lenspack/core";

import { ADMIN_ACCESS_MODES, type AdminAccess, type AdminAccessMode, USER_ACCESS_MODES, type UserAccess, type UserAccessMode, adminUsersFrom, usersUnder } from "./access";
import type { BoardScope } from "./board-scope";
import type { Rights } from "./index";

// The deployment's data boundary while the server runs: what the assistant may read, for whom, and who administers it.
// The deploy config sets it; an admin (or an admin API key) may only NARROW it at runtime, never widen it past the
// deploy config. The reason: a deployment's Superset may hold other teams' or other countries' data, and a leaked
// admin key must not be able to widen the assistant's reach. Widening needs the deploy config, and a restart.
//
//   datasets         keep fewer of the deploy config's datasets
//   scope            add filter clauses every answer carries (the deploy config's always stay)
//   dashboards       put the assistant on fewer dashboards: under dashboardScope "any", on the listed ones only; under
//                    "listed", on fewer of them
//   hostPolicy       "off" may become "superset" (each person's own Superset access), never the reverse
//   accessFallback   "rls-only" may become "none", never the reverse
//   editPolicy       "signed-in" may become "superset" (who Superset lets edit), never the reverse
//   adminAccess      fewer of the deploy config's admin access modes
//   adminRoles       fewer of the Superset roles that make an admin (auth.admins)
//   usageRoles       fewer of the roles that see user names on the usage pages (auth.usage)
//   adminUsers       fewer owners (auth.adminUsers)
//   userAccess       fewer of the deploy config's user access modes; any modes when it lets everyone signed in
//   userRoles        fewer of the roles that may use the assistant (auth.users); any roles when everyone signed in may
//   seedUsers        fewer seeded people (auth.seedUsers)
//
// Exclusions (overlay.exclude) are the pack's own part of the boundary: the pack layer adds them, never removes one
// (pack-layer.ts).

export const BOUNDARY_FIELDS = ["datasets", "scope", "dashboards", "hostPolicy", "accessFallback", "editPolicy", "adminAccess", "adminRoles", "usageRoles", "adminUsers", "userAccess", "userRoles", "seedUsers"] as const;
export type BoundaryField = (typeof BOUNDARY_FIELDS)[number];

/** The boundary as the deploy config sets it (each list as it writes it; roles by Superset role name). */
export type Boundary = {
  datasets: readonly (string | number)[];
  /** Filter clauses as the deploy config writes them ({ dimension, op, value }, with an optional entity). */
  scope: readonly unknown[];
  dashboards: BoardScope;
  hostPolicy: "superset" | "off";
  accessFallback: "none" | "rls-only";
  editPolicy: "superset" | "signed-in";
  adminAccess: readonly AdminAccessMode[];
  adminRoles: readonly string[];
  usageRoles: readonly string[];
  adminUsers: readonly string[];
  userAccess: readonly UserAccessMode[];
  /** Undefined: the deploy config names no user role (everyone signed in, under superset-role alone). */
  userRoles?: readonly string[];
  seedUsers: readonly string[];
};

/** An admin's narrowing, field by field; a field left out follows the deploy config. `scope` holds the added clauses only, `dashboards` the boards kept. */
export type BoundaryNarrowing = {
  datasets?: (string | number)[];
  scope?: unknown[];
  dashboards?: string[];
  hostPolicy?: "superset";
  accessFallback?: "none";
  editPolicy?: "superset";
  adminAccess?: AdminAccessMode[];
  adminRoles?: string[];
  usageRoles?: string[];
  adminUsers?: string[];
  userAccess?: UserAccessMode[];
  userRoles?: string[];
  seedUsers?: string[];
};

const text = (v: unknown) => String(v).trim().toLowerCase();
const isList = (v: unknown): v is unknown[] => Array.isArray(v);
const widen = (field: string, what: string) => `${field}: ${what} would widen the deployment's boundary; a change here may only narrow it, and widening needs the deploy config`;

/** Whether the deploy config lets everyone signed in use the assistant. */
const everyone = (b: Boundary) => usersUnder({ modes: b.userAccess, seeded: b.seedUsers, granted: [] }, b.userRoles?.map((r) => `role:${r}`)) === undefined;

/**
 * Why a narrowing can't be used, field by field: a value that would widen the deploy config's boundary, or one that is
 * not the field's shape; and, with the narrowing already saved, whether the fields together would let everyone signed
 * in use an assistant the deploy config keeps to some. Empty: it narrows (or keeps) the boundary. `null` for a field is
 * a reset and passes.
 */
export function boundaryRefusals(deploy: Boundary, asked: Record<string, unknown>, saved?: BoundaryNarrowing): string[] {
  const out = fieldRefusals(deploy, asked);
  if (out.length || !saved) return out;
  // Fewer user modes and fewer roles each narrow, but superset-role alone with no role named is everyone signed in.
  if (!everyone(deploy) && everyone(narrowedBoundary(deploy, narrowingWith(saved, asked)))) out.push(widen("userAccess", "superset-role alone, with no user role named, lets everyone signed in use the assistant, so it"));
  return out;
}

function fieldRefusals(deploy: Boundary, asked: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(asked)) {
    if (!(BOUNDARY_FIELDS as readonly string[]).includes(k)) {
      out.push(`${k} is not part of the boundary (${BOUNDARY_FIELDS.join(", ")})`);
      continue;
    }
    if (v === null) continue;
    const subset = (label: string, given: unknown, of: readonly (string | number)[], o: { nonEmpty?: boolean; caseless?: boolean } = {}) => {
      if (!isList(given) || given.some((x) => (typeof x !== "string" || !x.trim()) && typeof x !== "number")) return void out.push(`${label} is a list`);
      if (o.nonEmpty && !given.length) return void out.push(`${label} keeps at least one`);
      const known = new Set(of.map((x) => (o.caseless === false ? String(x) : text(x))));
      for (const x of given) if (!known.has(o.caseless === false ? String(x) : text(x))) out.push(widen(label, `"${String(x)}" is not in the deploy config's ${label} (${of.join(", ") || "none"}), so adding it`));
    };
    switch (k as BoundaryField) {
      case "datasets":
        subset("datasets", v, deploy.datasets, { nonEmpty: true });
        break;
      case "scope": {
        if (!isList(v)) {
          out.push("scope is a list of filter clauses, like [{ dimension: campaign, op: eq, value: 2026-spring }]");
          break;
        }
        v.forEach((c, i) => {
          const { entity, ...clause } = (c && typeof c === "object" && !Array.isArray(c) ? c : {}) as Record<string, unknown>;
          if (entity !== undefined && (typeof entity !== "string" || !entity)) return void out.push(`scope[${i}].entity is a dataset's key`);
          const r = filterClauseSchema.safeParse(clause);
          if (!r.success) out.push(`scope[${i}] is a filter clause { dimension, op, value }: ${r.error.issues.map((x) => `${x.path.join(".") || "(clause)"} ${x.message}`).join("; ")}`);
        });
        break;
      }
      case "dashboards": {
        if (!isList(v) || !v.length || v.some((b) => typeof b !== "string" || !b)) {
          out.push("dashboards keeps at least one dashboard");
          break;
        }
        if (deploy.dashboards.scope === "listed") {
          const listed = new Set(deploy.dashboards.boards);
          for (const b of v as string[]) if (!listed.has(b)) out.push(widen("dashboards", `"${b}" is not one of the deploy config's listed dashboards, so adding it`));
        }
        break;
      }
      case "hostPolicy":
        if (v !== "superset") out.push(v === "off" ? widen("hostPolicy", '"off"') : 'hostPolicy may only be set to "superset" here');
        break;
      case "accessFallback":
        if (v !== "none") out.push(v === "rls-only" ? widen("accessFallback", '"rls-only"') : 'accessFallback may only be set to "none" here');
        break;
      case "editPolicy":
        if (v !== "superset") out.push(v === "signed-in" ? widen("editPolicy", '"signed-in"') : 'editPolicy may only be set to "superset" here');
        break;
      case "adminAccess":
        if (!isList(v) || v.some((m) => !(ADMIN_ACCESS_MODES as readonly string[]).includes(m as string))) out.push(`adminAccess is a list of ${ADMIN_ACCESS_MODES.join(", ")}`);
        else subset("adminAccess", v, deploy.adminAccess, { nonEmpty: true, caseless: false });
        break;
      case "adminRoles":
        subset("adminRoles", v, deploy.adminRoles, { caseless: false });
        break;
      case "usageRoles":
        subset("usageRoles", v, deploy.usageRoles, { caseless: false });
        break;
      case "adminUsers":
        try {
          adminUsersFrom(v);
          subset("adminUsers", v, deploy.adminUsers, { caseless: false });
        } catch (e) {
          out.push(`adminUsers: ${(e as Error).message}`);
        }
        break;
      case "seedUsers":
        try {
          adminUsersFrom(v);
          subset("seedUsers", v, deploy.seedUsers, { caseless: false });
        } catch (e) {
          out.push(`seedUsers: ${(e as Error).message}`);
        }
        break;
      case "userAccess":
        if (!isList(v) || !v.length || v.some((m) => !(USER_ACCESS_MODES as readonly string[]).includes(m as string))) out.push(`userAccess is a list of one or more of ${USER_ACCESS_MODES.join(", ")}`);
        // Everyone signed in already: any modes narrow it. Else only fewer of the deploy config's.
        else if (!everyone(deploy)) subset("userAccess", v, deploy.userAccess, { caseless: false });
        break;
      case "userRoles":
        // Everyone signed in may use it: any roles narrow that. Else only fewer of the deploy config's roles.
        if (everyone(deploy)) {
          if (!isList(v) || v.some((r) => typeof r !== "string" || !r.trim())) out.push("userRoles is a list of Superset role names");
        } else subset("userRoles", v, deploy.userRoles ?? [], { caseless: false });
        break;
    }
  }
  return out;
}

/** The boundary in force: the deploy config's, narrowed field by field (scope: the deploy config's clauses, then the added ones). */
export function narrowedBoundary(deploy: Boundary, n: BoundaryNarrowing): Boundary {
  const keep = <T extends string | number>(of: readonly T[], kept: readonly (string | number)[] | undefined, caseless = false): T[] => {
    if (!kept) return [...of];
    const k = new Set(kept.map((x) => (caseless ? text(x) : String(x))));
    return of.filter((x) => k.has(caseless ? text(x) : String(x)));
  };
  return {
    datasets: keep(deploy.datasets, n.datasets, true),
    scope: [...deploy.scope, ...(n.scope ?? [])],
    dashboards: n.dashboards ? { scope: "listed", boards: deploy.dashboards.scope === "listed" ? keep(deploy.dashboards.boards, n.dashboards) : [...new Set(n.dashboards)] } : deploy.dashboards,
    hostPolicy: n.hostPolicy ?? deploy.hostPolicy,
    accessFallback: n.accessFallback ?? deploy.accessFallback,
    editPolicy: n.editPolicy ?? deploy.editPolicy,
    adminAccess: keep(deploy.adminAccess, n.adminAccess),
    adminRoles: keep(deploy.adminRoles, n.adminRoles),
    usageRoles: keep(deploy.usageRoles, n.usageRoles),
    adminUsers: keep(deploy.adminUsers, n.adminUsers),
    userAccess: n.userAccess ? (everyone(deploy) ? [...n.userAccess] : keep(deploy.userAccess, n.userAccess)) : deploy.userAccess,
    userRoles: n.userRoles ? (everyone(deploy) ? [...n.userRoles] : keep(deploy.userRoles ?? [], n.userRoles)) : deploy.userRoles,
    seedUsers: keep(deploy.seedUsers, n.seedUsers),
  };
}

/** A narrowing with some fields changed: each named field replaces the saved one, null hands it back to the deploy config. */
export function narrowingWith(saved: BoundaryNarrowing, change: Record<string, unknown>): BoundaryNarrowing {
  const next: Record<string, unknown> = { ...saved };
  for (const [k, v] of Object.entries(change)) {
    if (!(BOUNDARY_FIELDS as readonly string[]).includes(k)) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as BoundaryNarrowing;
}

/** The parts of a saved narrowing that still narrow this deploy config, and the ones that no longer do (it changed since). */
export function narrowingStillValid(deploy: Boundary, saved: BoundaryNarrowing): { kept: BoundaryNarrowing; dropped: string[] } {
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(saved)) {
    const why = boundaryRefusals(deploy, { [k]: v });
    if (why.length) dropped.push(...why);
    else kept[k] = v;
  }
  return { kept: kept as BoundaryNarrowing, dropped };
}

/** An admin access state narrowed: fewer modes, fewer owners, fewer admin roles. Decisions read this (adminRights, rightsUnder). */
export function narrowAdminAccess(access: AdminAccess, b: Pick<Boundary, "adminAccess" | "adminUsers" | "adminRoles">): AdminAccess {
  const roles = new Set(b.adminRoles.map((r) => `role:${r}`));
  return {
    ...access,
    modes: access.modes.filter((m) => b.adminAccess.includes(m)),
    owners: access.owners.filter((o) => b.adminUsers.includes(o)),
    ...(access.roles ? { roles: access.roles.filter((r) => (r === "*" ? b.adminRoles.includes("*") : !r.startsWith("role:") || roles.has(r))) } : {}),
  };
}

/** A user access state narrowed: the boundary's modes and seeded people. */
export function narrowUserAccess(access: UserAccess, b: Pick<Boundary, "userAccess" | "seedUsers">): UserAccess {
  return { ...access, modes: [...b.userAccess], seeded: access.seeded.filter((s) => b.seedUsers.includes(s)) };
}

/** The host's rights with role entries narrowed: admins and usage to the boundary's roles, and the users rule to its user roles. */
export function narrowRights(host: Rights, b: Pick<Boundary, "adminRoles" | "usageRoles" | "userRoles">): Rights {
  const only = (entries: readonly string[], roles: readonly string[]) => entries.filter((e) => (e === "*" ? roles.includes("*") : !e.startsWith("role:") || roles.includes(e.slice(5))));
  return {
    ...host,
    admins: only(host.admins ?? [], b.adminRoles),
    usage: only(host.usage ?? [], b.usageRoles),
    ...(b.userRoles !== undefined ? { users: b.userRoles.map((r) => `role:${r}`) } : {}),
  };
}
