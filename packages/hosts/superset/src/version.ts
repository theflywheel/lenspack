import type { SupersetClient } from "./client";
import { MAPBOX_LIGHT } from "./query";

// Superset 6.1 is the version this package targets; 5.0 still works. The two differ for Lenspack only where
// Superset's own defaults differ (maps' basemap, below). Everything Lenspack sends and reads is the same.

export type SupersetVersion = { version: string | null; major: number };

/**
 * Superset's version: from lenspack_superset.py (/api/v1/lenspack/version, every version), else Superset 6.1's own
 * /version, else 5 (a Superset 5 with a plugin from before the version route).
 */
export async function supersetVersion(client: SupersetClient): Promise<SupersetVersion> {
  for (const [path, pick] of [
    ["/api/v1/lenspack/version", (r: any) => r?.result?.superset],
    ["/version", (r: any) => r?.version_string],
  ] as const) {
    try {
      const v = pick(await client.get(path));
      const major = typeof v === "string" ? Number(/^(\d+)\./.exec(v)?.[1]) : NaN;
      if (Number.isInteger(major) && major > 0) return { version: v, major };
    } catch {
      /* not there: try the next */
    }
  }
  return { version: null, major: 5 };
}

/** Superset 6's default basemap, OpenStreetMap streets: no key needed, and in Superset's default content security policy. */
export const OSM_STREETS = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** The basemap of maps Lenspack writes when the overlay names none: Superset's own default for its version (Superset 5
 * takes Mapbox styles only, and draws them only with its MAPBOX_API_KEY). */
export const defaultMapStyle = (major: number) => (major >= 6 ? OSM_STREETS : MAPBOX_LIGHT);
