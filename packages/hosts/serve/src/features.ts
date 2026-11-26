// Off switches: parts of the assistant a deployment can turn off, each on by default. A value comes
// from, lowest first: these defaults, the config's `features:`, LENSPACK_FEATURES, then an admin on
// the host's settings page (kept in settings.json, section "features"). The browser hears the
// effective values from <prefix>/info (admin.ts) and hides what is off; the server refuses what is off as well
// (edits, heatmaps, maps, the reviewer, speech to text), so turning a part off doesn't rely on the page.

import type { SettingsStore } from "./settings";

export const FEATURES = ["overlay", "voice", "spaceHold", "languageMenu", "markdown", "inPlaceRefresh", "newChat", "boardEdits", "heatmap", "maps", "reviewer", "turnCost", "cache"] as const;
export type Feature = (typeof FEATURES)[number];
export type FeatureValues = Partial<Record<Feature, boolean>>;

/** What each switch does, for the settings page. */
export const FEATURE_HELP: Record<Feature, { label: string; help: string }> = {
  overlay: { label: "Ask Lenspack button", help: "The button and chat panel on dashboards. Off hides the assistant from every dashboard." },
  voice: { label: "Voice input", help: "The mic in the chat (also needs a speech-to-text key). Off hides the mic and refuses transcriptions." },
  spaceHold: { label: "Hold Space to talk", help: "Holding Space starts the mic. Off leaves only the mic button." },
  languageMenu: { label: "Language menu", help: "The chat's language picker. Off uses the deployment's default language." },
  markdown: { label: "Formatted replies", help: "Bold, lists and tables in replies. Off shows replies as plain text." },
  inPlaceRefresh: { label: "Refresh in place", help: "After a change, redraw the dashboard without reloading the page. Off reloads the page." },
  newChat: { label: "New chat button", help: "The button that clears the conversation." },
  boardEdits: { label: "Dashboard edits", help: "Changing dashboards through the chat. Off makes the assistant answer questions only, for everyone." },
  heatmap: { label: "Heatmaps", help: "Heatmap charts made through the chat. Off refuses new heatmaps; existing ones stay." },
  maps: { label: "Maps", help: "Point maps made and read through the chat. Off refuses map queries; existing map charts stay in Superset." },
  reviewer: { label: "Reviewer", help: "A second model call that checks each dashboard change. Off saves a call per change." },
  turnCost: { label: "Cost per answer", help: "A line under each reply with what the turn cost (an estimate from list prices), and a running total in the chat menu. Off hides them; the audit log still records each turn's cost." },
  cache: { label: "Saved answers", help: "A question asked before is answered from its saved plan, with fresh data and no model call (the reply says so and offers Ask fresh); the most-asked questions become suggestions. Off: every question runs the full assistant." },
};

const isFeature = (k: string): k is Feature => (FEATURES as readonly string[]).includes(k);

/** The config's `features:` map, checked: unknown names and non-booleans are errors, not ignored. */
export function featuresFromConfig(input: unknown, where = "features"): FeatureValues {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error(`${where} must be a map of feature: true|false`);
  const out: FeatureValues = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!isFeature(k)) throw new Error(`${where}: unknown feature "${k}" (one of ${FEATURES.join(", ")})`);
    if (typeof v !== "boolean") throw new Error(`${where}.${k} must be true or false`);
    out[k] = v;
  }
  return out;
}

/** LENSPACK_FEATURES: "voice=off,heatmap=false,maps=on", or "-voice,+maps", or a JSON object. */
export function featuresFromEnv(value: string | undefined): FeatureValues {
  const s = (value ?? "").trim();
  if (!s) return {};
  if (s.startsWith("{")) return featuresFromConfig(JSON.parse(s), "LENSPACK_FEATURES");
  const out: FeatureValues = {};
  for (const part of s.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^([+-]?)([A-Za-z]+)(?:\s*=\s*(\S+))?$/.exec(part);
    if (!m || !isFeature(m[2]!)) throw new Error(`LENSPACK_FEATURES: can't read "${part}" (features: ${FEATURES.join(", ")})`);
    const word = m[3]?.toLowerCase();
    if (m[3] !== undefined && m[1]) throw new Error(`LENSPACK_FEATURES: "${part}" has both a sign and a value`);
    const on = word === undefined ? m[1] !== "-" : ["on", "true", "1", "yes"].includes(word) ? true : ["off", "false", "0", "no"].includes(word) ? false : null;
    if (on === null) throw new Error(`LENSPACK_FEATURES: "${part}": use on or off`);
    out[m[2] as Feature] = on;
  }
  return out;
}

export type Features = {
  /** Whether a part is on now. */
  on(f: Feature): boolean;
  /** Every switch's effective value. */
  values(): Record<Feature, boolean>;
  /** For GET /_superset/settings: effective values, what they'd be without the admin, where each comes from. */
  view(writable: boolean): {
    values: Record<Feature, boolean>;
    defaults: Record<Feature, boolean>;
    source: Record<Feature, "default" | "config" | "env" | "settings">;
    options: { key: Feature; label: string; help: string }[];
    writable: boolean;
  };
  /** PUT /_superset/settings/features: `{feature: true|false|null}`; null drops the admin's value. */
  update(body: Record<string, unknown>): { ok: true; changed: FeatureValues & Partial<Record<Feature, null>> } | { ok: false; error: string };
};

export function features(opts: { config?: unknown; env?: string; settings: SettingsStore }): Features {
  const fromConfig = featuresFromConfig(opts.config);
  const fromEnv = featuresFromEnv(opts.env);
  const base = Object.fromEntries(FEATURES.map((f) => [f, fromEnv[f] ?? fromConfig[f] ?? true])) as Record<Feature, boolean>;
  const saved = (): FeatureValues => opts.settings.get<FeatureValues>("features") ?? {};
  const values = () => {
    const s = saved();
    return Object.fromEntries(FEATURES.map((f) => [f, typeof s[f] === "boolean" ? s[f]! : base[f]])) as Record<Feature, boolean>;
  };
  return {
    on: (f) => values()[f],
    values,
    view: (writable) => {
      const s = saved();
      const source = Object.fromEntries(
        FEATURES.map((f) => [f, typeof s[f] === "boolean" ? "settings" : fromEnv[f] !== undefined ? "env" : fromConfig[f] !== undefined ? "config" : "default"]),
      ) as Record<Feature, "default" | "config" | "env" | "settings">;
      return { values: values(), defaults: { ...base }, source, options: FEATURES.map((key) => ({ key, ...FEATURE_HELP[key] })), writable };
    },
    update: (body) => {
      const next: FeatureValues = { ...saved() };
      const changed: Record<string, boolean | null> = {};
      for (const [k, v] of Object.entries(body)) {
        if (!isFeature(k)) return { ok: false, error: `unknown feature "${k}" (one of ${FEATURES.join(", ")})` };
        if (v === null) delete next[k];
        else if (typeof v === "boolean") next[k] = v;
        else return { ok: false, error: `${k} must be true, false or null` };
        changed[k] = v as boolean | null;
      }
      opts.settings.set("features", Object.keys(next).length ? next : undefined);
      return { ok: true, changed: changed as FeatureValues & Partial<Record<Feature, null>> };
    },
  };
}
