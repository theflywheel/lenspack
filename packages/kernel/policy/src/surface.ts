import type { AdminAccessMode } from "./access";

// Where a deployment's admin pages are. A host with a settings page of its own (Superset) offers them one of three
// ways, picked by config (admin.surface) or LENSPACK_ADMIN_SURFACE:
//
//   split     the host's settings page holds what the host needs (the name, the connection, languages, datasets);
//             the admin panel holds the rest. The default, as before.
//   superset  everything on the host's settings page, inside the host's own frame; the panel's address leads there.
//   separate  everything on the admin panel; the host's settings page only links to it.
//
// The surface says where, never who: who is an admin is the admin access mode (access.ts), decided the same on every
// surface. One rule ties them: the password mode alone signs every admin in on a page of its own, so it is always
// separate; combined with another mode, password admins use that page and everyone else the surface asked for.

export const ADMIN_SURFACES = ["split", "superset", "separate"] as const;
export type AdminSurface = (typeof ADMIN_SURFACES)[number];

/** What each page shows: every section, only the host's, all but the host's, or a link to the other page. */
export type AdminSections = "all" | "host" | "lenspack" | "link";

/** The surface a config value or LENSPACK_ADMIN_SURFACE names; the environment wins. Absent: split. Unknown: an error. */
export function adminSurfaceFrom(config: unknown, env?: string): AdminSurface {
  const raw = env?.trim() ? env : config;
  if (raw === undefined || raw === null || raw === "") return "split";
  const v = String(raw).trim().toLowerCase();
  if ((ADMIN_SURFACES as readonly string[]).includes(v)) return v as AdminSurface;
  throw new Error(`admin.surface (LENSPACK_ADMIN_SURFACE) must be split, superset or separate, not "${String(raw)}"`);
}

export type SurfacePlan = {
  /** The surface in force. */
  surface: AdminSurface;
  /** The surface asked for, when the admin access mode overrode it. */
  asked?: AdminSurface;
  /** What the host's settings page shows. */
  hostPage: AdminSections;
  /** What the admin panel shows; "none" when its address leads to the host's page instead. */
  panel: AdminSections | "none";
};

/**
 * The surface in force under the admin access modes, and what each page shows on it. With the password alone, nobody
 * signs in through the host, so the pages are separate. Combined with another mode, the host's admins get the surface
 * asked for, and password admins get every section on their own sign-in's pages (the host serves those apart).
 */
export function surfacePlan(asked: AdminSurface, access: AdminAccessMode | readonly AdminAccessMode[]): SurfacePlan {
  const modes = typeof access === "string" ? [access] : access;
  const surface: AdminSurface = modes.length === 1 && modes[0] === "password" ? "separate" : asked;
  const pages: Record<AdminSurface, Pick<SurfacePlan, "hostPage" | "panel">> = {
    split: { hostPage: "host", panel: "lenspack" },
    superset: { hostPage: "all", panel: "none" },
    separate: { hostPage: "link", panel: "all" },
  };
  return { surface, ...(surface !== asked ? { asked } : {}), ...pages[surface] };
}
