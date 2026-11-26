import { TELEMETRY_GROUPS, type SwitchChange, type SwitchValues, itemBlock, itemById, switchDefaults, itemsOn, switchable } from "@lenspack/agent";

import type { Features } from "./features";
import type { SettingsStore } from "./settings";

// The telemetry switchboard's values (the catalogue and its rules are @lenspack/agent switchboard.ts): telemetry as a
// whole is the "telemetry" feature switch; each section and each item has a switch of its own. The deployment's
// config sets them (telemetry.groups, telemetry.items), and admins change them from the Telemetry tab. Each change
// is kept with who made it and when, and read on every record, so it applies at once.

export const RETENTION = { min: 1, max: 3650 };
export const goodRetention = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= RETENTION.min && v <= RETENTION.max;

/** The deployment's telemetry config. questionText is the older name of items.question-text. */
export type TelemetryConfig = { retentionDays?: number; groups?: Record<string, boolean>; items?: Record<string, boolean>; questionText?: boolean };

/** What the settings page keeps: changes only, each switch with who changed it. */
type Saved = { retentionDays?: number; groups?: Record<string, boolean>; items?: Record<string, boolean>; changed?: Record<string, { at: string; by: string }> };

export type SwitchUpdate =
  | { ok: true; changes: { key: string; from: boolean | number | null; to: boolean | number | null }[] }
  | { ok: false; status: number; error: string; confirm?: { key: string; label: string; sensitive: string; consent: string | null } };

const flag = (v: string | undefined) => (["true", "on", "1", "yes"].includes((v ?? "").trim().toLowerCase()) ? true : ["false", "off", "0", "no"].includes((v ?? "").trim().toLowerCase()) ? false : undefined);

/** Checks a config's switches: known sections and items, true or false. Throws in words an operator can act on. */
function checkedSwitches(where: string, v: unknown, known: (k: string) => boolean): Record<string, boolean> {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where} must be a map of names to true or false`);
  for (const [k, x] of Object.entries(v)) {
    if (!known(k)) throw new Error(`${where}.${k} is not a telemetry ${where.endsWith("groups") ? "section" : "item with a switch"}; see docs/features/telemetry.md`);
    if (typeof x !== "boolean") throw new Error(`${where}.${k} must be true or false`);
  }
  return v as Record<string, boolean>;
}

export function telemetrySwitches(o: {
  settings: SettingsStore;
  features: Features;
  config?: TelemetryConfig;
  env?: NodeJS.ProcessEnv;
  /** The older speech.keepAudio (config, LENSPACK_SPEECH_KEEP_AUDIO, the settings page): the default of items.voice-audio. */
  keepAudio?: () => boolean | undefined;
  /** Whether voice can run now (its switch and a speech key), for the checklist. */
  voiceReady?: () => boolean;
  /** The consent notice users acknowledge before kept recordings: shown in the confirm step for them. */
  consentNotice?: () => string | null;
  now?: () => Date;
}) {
  const env = o.env ?? process.env;
  const c = o.config ?? {};
  if (c.retentionDays !== undefined && !goodRetention(c.retentionDays)) throw new Error(`telemetry.retentionDays must be a whole number of days from ${RETENTION.min} to ${RETENTION.max}`);
  if (c.questionText !== undefined && typeof c.questionText !== "boolean") throw new Error("telemetry.questionText must be true or false");
  const groupIds = new Set(TELEMETRY_GROUPS.map((g) => g.id));
  const isItem = (k: string) => !!itemById(k) && switchable(itemById(k)!);
  const configGroups = checkedSwitches("telemetry.groups", c.groups, (k) => groupIds.has(k));
  const configItems = checkedSwitches("telemetry.items", c.items, isItem);
  const envDays = Number(env.LENSPACK_TELEMETRY_RETENTION_DAYS);
  const envText = flag(env.LENSPACK_TELEMETRY_QUESTION_TEXT);
  const catalogue = switchDefaults();
  // The deployment's values: the catalogue, then the config, then the environment's older names.
  const deployment = () => {
    const items = { ...catalogue.items, ...configItems };
    const text = envText ?? c.questionText;
    if (text !== undefined && configItems["question-text"] === undefined) items["question-text"] = text;
    const audio = o.keepAudio?.();
    if (audio !== undefined && configItems["voice-audio"] === undefined) items["voice-audio"] = audio;
    return { retentionDays: goodRetention(envDays) ? envDays : (c.retentionDays ?? 90), groups: { ...catalogue.groups, ...configGroups }, items };
  };
  const saved = () => o.settings.get<Saved>("telemetry") ?? {};

  function values(): SwitchValues & { retentionDays: number } {
    const d = deployment();
    const s = saved();
    return { telemetry: o.features.on("telemetry"), retentionDays: s.retentionDays ?? d.retentionDays, groups: { ...d.groups, ...s.groups }, items: { ...d.items, ...s.items } };
  }
  const changed = (): Record<string, SwitchChange> => saved().changed ?? {};
  /** The feature switches items depend on, as they stand. */
  const featureValues = (forChecklist = false): Record<string, boolean> => ({ ...o.features.values(), ...(forChecklist && o.voiceReady ? { voice: o.voiceReady() } : {}) });

  return {
    values,
    changed,
    featureValues,
    /** The items recording now (read on every record). */
    on: () => itemsOn(values(), featureValues()),
    retentionDays: () => values().retentionDays,

    /**
     * An admin's changes: {"telemetry": bool, "groups.<id>": bool, "items.<id>": bool, "retentionDays": n}, null
     * for the deployment's value. Turning a privacy-sensitive item on needs "confirm": true (the page's confirm
     * step); without it nothing changes and the answer says what to confirm. All or nothing.
     */
    update(body: Record<string, unknown>, by: string): SwitchUpdate {
      const aliases: Record<string, string> = { questionText: "items.question-text", keepAudio: "items.voice-audio" };
      const entries = Object.entries(body).filter(([k]) => k !== "confirm").map(([k, v]) => [aliases[k] ?? k, v] as const);
      if (!entries.length) return { ok: false, status: 400, error: "name a switch: telemetry, groups.<section>, items.<item> or retentionDays" };
      const now = (o.now ?? (() => new Date()))().toISOString();
      const before = values();
      const next: Saved = structuredClone(saved());
      const changes: { key: string; from: boolean | number | null; to: boolean | number | null }[] = [];
      let master: boolean | null | undefined;
      const features = featureValues();
      for (const [key, v] of entries) {
        if (key === "retentionDays") {
          if (v !== null && !goodRetention(v)) return { ok: false, status: 400, error: `retentionDays is a whole number of days from ${RETENTION.min} to ${RETENTION.max}` };
          if (v === null) delete next.retentionDays;
          else next.retentionDays = v;
          changes.push({ key, from: before.retentionDays, to: v });
          continue;
        }
        if (v !== null && typeof v !== "boolean") return { ok: false, status: 400, error: `${key} must be true, false or null` };
        if (key === "telemetry") {
          master = v;
          changes.push({ key, from: before.telemetry, to: v });
          continue;
        }
        const [kind, id] = key.split(/\.(.*)/s) as [string, string | undefined];
        if (kind === "groups" && id && groupIds.has(id)) {
          const to = v ?? deployment().groups[id]!;
          next.groups = { ...next.groups };
          if (v === null) delete next.groups[id];
          else next.groups[id] = v;
          changes.push({ key, from: before.groups[id] ?? true, to });
          continue;
        }
        const s = kind === "items" && id ? itemById(id) : undefined;
        if (!s) return { ok: false, status: 400, error: `${key} is not a telemetry switch: name telemetry, groups.<section>, items.<item> or retentionDays` };
        if (!switchable(s)) return { ok: false, status: 409, error: s.notTelemetry ? `${s.label} is not telemetry: ${s.notTelemetry}` : `${s.label} is kept by the ${s.feature} feature; change that switch instead` };
        const block = itemBlock(s, features);
        if (block?.kind === "feature" || block?.kind === "voice") return { ok: false, status: 409, error: `${s.label} is owned by the ${block.feature} switch, which is off; turn that on first` };
        const to = v ?? deployment().items[id!]!;
        // Privacy-sensitive items: turning one on is confirmed with its note in front of the admin.
        if (to && !before.items[id!] && s.sensitive && body.confirm !== true) return { ok: false, status: 409, error: `turning on ${s.label} needs confirming`, confirm: { key, label: s.label, sensitive: s.sensitive, consent: s.consent ? (o.consentNotice?.() ?? null) : null } };
        next.items = { ...next.items };
        if (v === null) delete next.items[id!];
        else next.items[id!] = v;
        changes.push({ key, from: before.items[id!] ?? s.default, to });
      }
      if (master !== undefined) {
        const r = o.features.update({ telemetry: master });
        if (!r.ok) return { ok: false, status: 400, error: r.error };
      }
      next.changed = { ...next.changed };
      for (const ch of changes) if (ch.key !== "retentionDays") next.changed[ch.key] = { at: now, by };
      o.settings.set("telemetry", next);
      return { ok: true, changes };
    },

    /** For the settings page: the values, where they came from, and the ranges. */
    view(writable: boolean) {
      const v = values();
      return { enabled: v.telemetry, retentionDays: v.retentionDays, defaults: deployment(), source: o.settings.get("telemetry") ? "settings" : "default", retentionRange: RETENTION, itemsOn: [...itemsOn(v, featureValues())], writable };
    },
  };
}
export type TelemetrySwitches = ReturnType<typeof telemetrySwitches>;
