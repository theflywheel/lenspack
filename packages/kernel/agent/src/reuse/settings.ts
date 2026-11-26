// The answer store's settings: the deployment's defaults (the config's `cache:`), and an admin's
// changes on a running server (settings.json, section "cache", PUT <prefix>/settings/cache).

/** Where a host keeps settings an admin changed: one value per section. */
export type SettingsLike = { get<T>(key: string): T | undefined; set(key: string, value: unknown): void };

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
  /** Refreshing the most-asked answers before the day's busy times, so the first questions are answered from them. */
  prewarm: PrewarmSettings;
};

export type PrewarmSettings = {
  enabled: boolean;
  /** Local times ("06:30") to refresh at, in timeZone. */
  times: string[];
  /** An IANA time zone; null: each pack's own (pack timeZone), else UTC. */
  timeZone: string | null;
  /** How many answers per board and access scope, the most asked first. */
  topN: number;
  /** The most one refresh may spend on small rewrite calls, in US$; past it, only answers that need no model are refreshed. */
  maxUsd: number;
};

export const PREWARM_DEFAULTS: PrewarmSettings = { enabled: false, times: ["06:30", "16:30"], timeZone: null, topN: 10, maxUsd: 0.05 };
export const CACHE_DEFAULTS: CacheSettings = { enabled: true, ttlHours: 168, router: "on", maxEntries: 500, freshMinutes: 10, prewarm: PREWARM_DEFAULTS };

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
    } else if (k === "prewarm") {
      out.prewarm = prewarmFrom(v, `${where}.prewarm`) as PrewarmSettings;
    } else throw new Error(`${where}: unknown setting "${k}" (${Object.keys(CACHE_DEFAULTS).join(", ")})`);
  }
  return out;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A partial prewarm section, checked. */
export function prewarmFrom(input: unknown, where = "cache.prewarm"): Partial<PrewarmSettings> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error(`${where} must be a map`);
  const out: Partial<PrewarmSettings> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "enabled") {
      if (typeof v !== "boolean") throw new Error(`${where}.enabled must be true or false`);
      out.enabled = v;
    } else if (k === "times") {
      if (!Array.isArray(v) || v.length > 24 || !v.every((x) => typeof x === "string" && TIME.test(x))) throw new Error(`${where}.times is a list of up to 24 times like "06:30"`);
      out.times = [...new Set(v as string[])].sort();
    } else if (k === "timeZone") {
      if (v !== null && (typeof v !== "string" || !validZone(v))) throw new Error(`${where}.timeZone must be an IANA time zone such as "Africa/Lagos", or null`);
      out.timeZone = v as string | null;
    } else if (k === "topN") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 100) throw new Error(`${where}.topN is a whole number from 1 to 100`);
      out.topN = v;
    } else if (k === "maxUsd") {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) throw new Error(`${where}.maxUsd is a number from 0 to 100`);
      out.maxUsd = v;
    } else throw new Error(`${where}: unknown setting "${k}" (${Object.keys(PREWARM_DEFAULTS).join(", ")})`);
  }
  return out;
}

const validZone = (z: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

export type CacheSettingsStore = {
  get(): CacheSettings;
  view(writable: boolean): CacheSettings & { defaults: CacheSettings; source: "default" | "settings"; writable: boolean };
  /** `{field: value | null}`; null puts a field back to the deployment's value. */
  update(body: Record<string, unknown>): { ok: true } | { ok: false; error: string };
};

export function cacheSettings(settings: SettingsLike | null, config?: unknown): CacheSettingsStore {
  const fromConfig = cacheSettingsFrom(config);
  const defaults: CacheSettings = { ...CACHE_DEFAULTS, ...fromConfig, prewarm: { ...PREWARM_DEFAULTS, ...fromConfig.prewarm } };
  const saved = () => settings?.get<Partial<CacheSettings>>("cache") ?? {};
  const get = (): CacheSettings => {
    const s = saved();
    return { ...defaults, ...s, prewarm: { ...defaults.prewarm, ...s.prewarm } };
  };
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
        const checked = cacheSettingsFrom(set);
        // A prewarm change merges into the saved one: { prewarm: { topN: 5 } } keeps its times.
        if (checked.prewarm) checked.prewarm = { ...(next.prewarm as object | undefined), ...checked.prewarm };
        Object.assign(next, checked);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      settings.set("cache", Object.keys(next).length ? next : undefined);
      return { ok: true };
    },
  };
}
