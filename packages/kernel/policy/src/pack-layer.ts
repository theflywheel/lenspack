import type { AdminAccess } from "./access";
import { adminRights } from "./index";

// The pack's runtime layer: what admins may change in a running deployment's pack without a redeploy, and what only
// the deploy config sets. The deploy config's overlay is the base; admins' changes are a layer over it, kept by the
// host in its state directory. This file is the rule: which parts the layer may hold, how it is laid over the base,
// and what no change at runtime may do. The host builds, checks and swaps the pack; it never decides these.
//
//   may change at runtime   the pack's words and its reading of the data: description, instructions, labels, hints,
//                           measures, example questions, notDimensions, hierarchies, and more exclusions.
//   config only             the pack's identity and keys (pack, entities), where it is (timeZone), maps (geo, mapStyle),
//                           the chat's starting form (panel), and the data boundary: datasets, scope, dashboards,
//                           dashboardScope, access, budget caps, the models offered. None of these is in the overlay's
//                           runtime part; the ones outside the overlay are never read from the layer at all.
//
// Exclusions are the one part of the data boundary inside the overlay. The layer may add exclusions, never remove one:
// the pack it gives always excludes at least what the deploy config excludes.

/** The parts of the overlay an admin may change while the server runs, in the order they are shown. */
export const PACK_RUNTIME_FIELDS = ["description", "instructions", "labels", "hints", "measures", "examples", "notDimensions", "hierarchies", "exclude"] as const;
export type PackRuntimeField = (typeof PACK_RUNTIME_FIELDS)[number];

/** The parts of the overlay only the deploy config sets, and why, in words for an admin. */
export const PACK_CONFIG_FIELDS: Readonly<Record<string, string>> = {
  pack: "the pack's name, which its saved definitions, saved answers and addresses are kept under",
  entities: "each dataset's key, which measure keys and the deploy config's scope name",
  timeZone: "where the deployment is: it decides what today and last month mean for everyone, and the schedules are set from it at start",
  geo: "which columns are a dataset's coordinates, which can be people's locations",
  mapStyle: "the map tiles browsers fetch, from a server outside the deployment",
  panel: "how the chat opens, a deployment setting rather than part of the pack",
};

/** The deployment's data boundary outside the overlay: never part of the layer. */
export const PACK_DATA_BOUNDARY = ["datasets", "scope", "dashboards", "dashboardScope", "auth", "budget", "models"] as const;

/** An admin's changes over the deploy config's overlay: a value per runtime field it changes, `exclude` the added exclusions only. */
export type PackLayer = Partial<Record<PackRuntimeField, unknown>>;
type Exclude = { columns?: string[]; datasets?: (string | number)[] };
type OverlayLike = Record<string, unknown> & { exclude?: Exclude };

const RUNTIME = new Set<string>(PACK_RUNTIME_FIELDS);

/** Who may read and change the pack at runtime: an admin (adminRights), as for every other setting. */
export function packEditRights(who: { user?: string; userId?: string | number | null; roles?: readonly string[]; usage?: boolean }, access?: AdminAccess): { read: boolean; edit: boolean; why?: string } {
  const { administer } = adminRights(who, access);
  return administer ? { read: true, edit: true } : { read: false, edit: false, why: "only admins can read or change the pack" };
}

const lower = (v: unknown) => String(v).trim().toLowerCase();
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Exclusions in one shape: columns compared without case, datasets by id or name as text. */
function exclusions(e: unknown): { columns: string[]; datasets: (string | number)[] } {
  const x = (e && typeof e === "object" ? e : {}) as Exclude;
  return { columns: list(x.columns).map(String), datasets: list(x.datasets) as (string | number)[] };
}

/** What `given` excludes beyond `base`, as written in `given`. */
function addedExclusions(base: unknown, given: unknown): Exclude {
  const b = exclusions(base);
  const g = exclusions(given);
  const bc = new Set(b.columns.map(lower));
  const bd = new Set(b.datasets.map(lower));
  const columns = [...new Set(g.columns.filter((c) => !bc.has(lower(c))))];
  const datasets = g.datasets.filter((d, i) => !bd.has(lower(d)) && g.datasets.findIndex((x) => lower(x) === lower(d)) === i);
  return { ...(columns.length ? { columns } : {}), ...(datasets.length ? { datasets } : {}) };
}

/** Both sets of exclusions, the base's first. */
function unionExclusions(base: unknown, added: unknown): Exclude {
  const b = exclusions(base);
  const more = addedExclusions(base, added);
  const columns = [...b.columns, ...(more.columns ?? [])];
  const datasets = [...b.datasets, ...(more.datasets ?? [])];
  return { ...(columns.length ? { columns } : {}), ...(datasets.length ? { datasets } : {}) };
}

/** The same value, whatever the order of an object's keys. */
export function sameValue(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));
}

/**
 * Why a change can't be made, before anything is built: a field the layer doesn't hold (config only, the data boundary,
 * or not a field at all), or exclusions that leave out one the deploy config makes. `change` holds each field's value as
 * the pack would use it (exclusions in full, the config's with any more); `null` hands a field back to the config.
 */
export function packChangeRefusals(change: Record<string, unknown>, base: OverlayLike): string[] {
  const out: string[] = [];
  for (const k of Object.keys(change)) {
    if (RUNTIME.has(k)) continue;
    if (PACK_CONFIG_FIELDS[k]) out.push(`${k} is set in the deploy config only (${PACK_CONFIG_FIELDS[k]})`);
    else if ((PACK_DATA_BOUNDARY as readonly string[]).includes(k)) out.push(`${k} is part of the deployment's data boundary and is set in the deploy config only`);
    else out.push(`${k} is not a part of the pack that can be changed here (${PACK_RUNTIME_FIELDS.join(", ")})`);
  }
  const ex = change.exclude;
  if (ex !== undefined && ex !== null) {
    if (typeof ex !== "object" || Array.isArray(ex) || Object.keys(ex).some((k) => k !== "columns" && k !== "datasets")) out.push("exclude is { columns: [...], datasets: [...] }");
    else {
      const x = ex as Exclude;
      if (x.columns !== undefined && (!Array.isArray(x.columns) || x.columns.some((c) => typeof c !== "string" || !c.trim()))) out.push("exclude.columns is a list of column names");
      if (x.datasets !== undefined && (!Array.isArray(x.datasets) || x.datasets.some((d) => (typeof d !== "string" || !d.trim()) && typeof d !== "number"))) out.push("exclude.datasets is a list of dataset ids or table names");
    }
  }
  // Exclusions only grow: every one the deploy config makes must still be there (null keeps the config's alone).
  if (ex !== null && ex !== undefined && typeof ex === "object") {
    const g = exclusions(ex);
    const gc = new Set(g.columns.map(lower));
    const gd = new Set(g.datasets.map(lower));
    const b = exclusions(base.exclude);
    for (const c of b.columns) if (!gc.has(lower(c))) out.push(`exclude.columns: "${c}" is excluded by the deploy config, and a change here can only add exclusions, never remove one`);
    for (const d of b.datasets) if (!gd.has(lower(d))) out.push(`exclude.datasets: "${d}" is excluded by the deploy config, and a change here can only add exclusions, never remove one`);
  }
  return out;
}

/** The overlay the pack is built from: the base, with each field the layer holds in its place, and both sets of exclusions. */
export function applyPackLayer<O extends OverlayLike>(base: O, layer: PackLayer): O {
  const out: Record<string, unknown> = { ...base };
  for (const f of PACK_RUNTIME_FIELDS) {
    if (!(f in layer) || layer[f] === undefined) continue;
    if (f === "exclude") {
      const u = unionExclusions(base.exclude, layer.exclude);
      if (u.columns || u.datasets) out.exclude = u;
    } else out[f] = layer[f];
  }
  return out as O;
}

/**
 * The layer that gives `given` over `base`: each runtime field `given` sets that differs from the base's, and the
 * exclusions it adds. A field `given` leaves out (or sets to null) follows the base. Fields outside the runtime part are
 * ignored here; packChangeRefusals says why they can't be changed.
 */
export function packLayerFrom(base: OverlayLike, given: Record<string, unknown>): PackLayer {
  const layer: PackLayer = {};
  for (const f of PACK_RUNTIME_FIELDS) {
    const v = given[f];
    if (v === undefined || v === null) continue;
    if (f === "exclude") {
      const added = addedExclusions(base.exclude, v);
      if (added.columns || added.datasets) layer.exclude = added;
    } else if (!sameValue(v, base[f])) layer[f] = v;
  }
  return layer;
}

/** The runtime fields as the pack uses them under a layer: what an admin edits, and what Save sends back. */
export function packRuntimeView(base: OverlayLike, layer: PackLayer): Partial<Record<PackRuntimeField, unknown>> {
  const effective = applyPackLayer(base, layer);
  const out: Partial<Record<PackRuntimeField, unknown>> = {};
  for (const f of PACK_RUNTIME_FIELDS) if (effective[f] !== undefined && effective[f] !== null) out[f] = effective[f];
  return out;
}

/**
 * A layer with some fields changed: each field in `change` replaces the layer's (as the pack would use it; exclusions in
 * full), and `null` hands it back to the deploy config. Fields not named keep what the layer had.
 */
export function packLayerWith(base: OverlayLike, layer: PackLayer, change: Record<string, unknown>): PackLayer {
  const given: Record<string, unknown> = packRuntimeView(base, layer);
  for (const [k, v] of Object.entries(change)) {
    if (!RUNTIME.has(k)) continue;
    if (v === null) delete given[k];
    else given[k] = v;
  }
  return packLayerFrom(base, given);
}

/** The runtime fields whose value differs between two layers over the same base. */
export function packFieldsChanged(base: OverlayLike, a: PackLayer, b: PackLayer): PackRuntimeField[] {
  const x = applyPackLayer(base, a);
  const y = applyPackLayer(base, b);
  return PACK_RUNTIME_FIELDS.filter((f) => !sameValue(x[f], y[f]));
}
