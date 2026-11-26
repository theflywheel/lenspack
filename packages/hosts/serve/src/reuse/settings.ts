// The answer store's settings: the deployment's defaults (the config's `cache:`), and an admin's
// changes on a running server (settings.json, section "cache", PUT <prefix>/settings/cache).

import type { SettingsStore } from "../settings";

export type CacheSettings = {
  /** Serve saved answers and keep new ones. The `cache` feature switch must be on as well. */
  enabled: boolean;
  /** An entry older than this is dropped, and the full assistant answers again (and keeps a new one). */
  ttlHours: number;
  /** A small model call that pairs a question with a saved one worded differently. */
  router: "on" | "off";
  /** At most this many entries; the least recently used unpinned one goes first. */
  maxEntries: number;
  /** A saved answer is shown as it is (no query) for this long after its data was read; after, its queries run again. */
  freshMinutes: number;
};

export const CACHE_DEFAULTS: CacheSettings = { enabled: true, ttlHours: 168, router: "on", maxEntries: 500, freshMinutes: 10 };

const LIMITS = { ttlHours: [1, 24 * 90], maxEntries: [10, 20_000], freshMinutes: [0, 24 * 60] } as const;

/** A partial cache settings object, checked: unknown fields and values out of range are errors. */
export function cacheSettingsFrom(input: unknown, where = "cache"): Partial<CacheSettings> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error(`${where} must be a map`);
  const out: Partial<CacheSettings> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "enabled") {
      if (typeof v !== "boolean") throw new Error(`${where}.enabled must be true or false`);
      out.enabled = v;
    } else if (k === "router") {
      if (v !== "on" && v !== "off") throw new Error(`${where}.router must be on or off`);
      out.router = v;
    } else if (k === "ttlHours" || k === "maxEntries" || k === "freshMinutes") {
      const [min, max] = LIMITS[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (k === "maxEntries" && !Number.isInteger(v))) throw new Error(`${where}.${k} is a number from ${min} to ${max}`);
      out[k] = v;
    } else throw new Error(`${where}: unknown setting "${k}" (enabled, ttlHours, router, maxEntries, freshMinutes)`);
  }
  return out;
}

export type CacheSettingsStore = {
  get(): CacheSettings;
  view(writable: boolean): CacheSettings & { defaults: CacheSettings; source: "default" | "settings"; writable: boolean };
  /** `{field: value | null}`; null puts a field back to the deployment's value. */
  update(body: Record<string, unknown>): { ok: true } | { ok: false; error: string };
};

export function cacheSettings(settings: SettingsStore | null, config?: unknown): CacheSettingsStore {
  const defaults: CacheSettings = { ...CACHE_DEFAULTS, ...cacheSettingsFrom(config) };
  const saved = () => settings?.get<Partial<CacheSettings>>("cache") ?? {};
  const get = () => ({ ...defaults, ...saved() });
  return {
    get,
    view: (writable) => ({ ...get(), defaults, source: Object.keys(saved()).length ? "settings" : "default", writable }),
    update(body) {
      if (!settings) return { ok: false, error: "settings cannot be changed on this server" };
      const next: Record<string, unknown> = { ...saved() };
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === null) delete next[k];
        else set[k] = v;
      }
      const unknown = Object.keys(body).find((k) => !(k in CACHE_DEFAULTS));
      if (unknown) return { ok: false, error: `cache: unknown setting "${unknown}" (${Object.keys(CACHE_DEFAULTS).join(", ")})` };
      try {
        Object.assign(next, cacheSettingsFrom(set));
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      settings.set("cache", Object.keys(next).length ? next : undefined);
      return { ok: true };
    },
  };
}
