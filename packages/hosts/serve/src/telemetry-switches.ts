import { type FieldGroup, type SwitchChange, type SwitchValues, FIELD_CATEGORIES, categoryChanges, fieldById, fieldLock, fieldsOn, isLegacyItem, isLegacySection, lockWords, legacyItemById, resolveFields, switchable } from "@lenspack/agent";
import type { ContextField, DeploymentContext } from "@lenspack/policy";

import type { Features } from "./features";
import type { SettingsStore } from "./settings";

// The telemetry switchboard's values (the catalogue and its rules are @lenspack/agent switchboard.ts): telemetry as a
// whole is the "telemetry" feature switch; each field group has a switch of its own, and a category switch turns
// the switches inside it on or off together. The deployment's config sets them (telemetry.fields, or the older
// telemetry.items and telemetry.groups), and admins change them from the Telemetry tab. Each change is kept with who
// made it and when, and read on every record, so it applies at once.

export const RETENTION = { min: 1, max: 3650 };
export const goodRetention = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= RETENTION.min && v <= RETENTION.max;

/**
 * The deployment's telemetry config. fields: the field switches. items and groups: the older metric and section
 * switches, read as field switches (switchboard.ts legacyChanges). questionText is the older name of fields.question-text.
 */
export type TelemetryConfig = { retentionDays?: number; fields?: Record<string, boolean>; groups?: Record<string, boolean>; items?: Record<string, boolean>; questionText?: boolean };

/** What the settings page keeps: changes only, each switch with who changed it. groups and items are older saves, still read. */
type Saved = { retentionDays?: number; fields?: Record<string, boolean>; groups?: Record<string, boolean>; items?: Record<string, boolean>; changed?: Record<string, { at: string; by: string }> };

export type SwitchUpdate =
  | { ok: true; changes: { key: string; from: boolean | number | null; to: boolean | number | null }[] }
  | { ok: false; status: number; error: string; confirm?: { key: string; label: string; sensitive: string; consent: string | null } };

const flag = (v: string | undefined) => (["true", "on", "1", "yes"].includes((v ?? "").trim().toLowerCase()) ? true : ["false", "off", "0", "no"].includes((v ?? "").trim().toLowerCase()) ? false : undefined);

/** Checks a config's switches: known names, true or false. Throws in words an operator can act on. */
function checkedSwitches(where: string, v: unknown, known: (k: string) => boolean, what: string): Record<string, boolean> {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where} must be a map of names to true or false`);
  for (const [k, x] of Object.entries(v)) {
    if (!known(k)) throw new Error(`${where}.${k} is not ${what}; see docs/features/telemetry.md`);
    if (typeof x !== "boolean") throw new Error(`${where}.${k} must be true or false`);
  }
  return v as Record<string, boolean>;
}

const isField = (k: string) => !!fieldById(k) && switchable(fieldById(k)!);

/** Checks a config's telemetry switches, for a server with or without a settings page. */
export function checkedTelemetryConfig(c: TelemetryConfig) {
  return {
    fields: checkedSwitches("telemetry.fields", c.fields, isField, "a telemetry field with a switch"),
    items: checkedSwitches("telemetry.items", c.items, isLegacyItem, "a telemetry item with a switch (the older names)"),
    groups: checkedSwitches("telemetry.groups", c.groups, isLegacySection, "a telemetry section (the older names)"),
  };
}

const mappedContext = (c: DeploymentContext) => new Set(Object.values(c).flatMap((e) => (Object.keys(e) as ContextField[]).filter((k) => e[k])));

export function telemetrySwitches(o: {
  settings: SettingsStore;
  features: Features;
  config?: TelemetryConfig;
  env?: NodeJS.ProcessEnv;
  /** The deployment's context: a field that reads one nobody mapped is locked until it is. */
  context?: () => DeploymentContext;
  /** The older speech.keepAudio (config, LENSPACK_SPEECH_KEEP_AUDIO, the settings page): the default of fields.voice-audio. */
  keepAudio?: () => boolean | undefined;
  /** Whether voice can run now (its switch and a speech key), for the checklist and the locks. */
  voiceReady?: () => boolean;
  /** The consent notice users acknowledge before kept recordings: shown in the confirm step for them. */
  consentNotice?: () => string | null;
  now?: () => Date;
}) {
  const env = o.env ?? process.env;
  const c = o.config ?? {};
  if (c.retentionDays !== undefined && !goodRetention(c.retentionDays)) throw new Error(`telemetry.retentionDays must be a whole number of days from ${RETENTION.min} to ${RETENTION.max}`);
  if (c.questionText !== undefined && typeof c.questionText !== "boolean") throw new Error("telemetry.questionText must be true or false");
  const checked = checkedTelemetryConfig(c);
  const envDays = Number(env.LENSPACK_TELEMETRY_RETENTION_DAYS);
  const envText = flag(env.LENSPACK_TELEMETRY_QUESTION_TEXT);
  /** The deployment's layer: its older names (with the environment's and speech.keepAudio as item defaults), then its field switches. */
  const deploymentLayer = () => {
    const items = { ...checked.items };
    const set = (id: string, v: boolean | undefined) => {
      if (v !== undefined && items[id] === undefined && checked.fields[id] === undefined) items[id] = v;
    };
    set("question-text", envText ?? c.questionText);
    set("voice-audio", o.keepAudio?.());
    return { groups: checked.groups, items, fields: checked.fields };
  };
  const saved = () => o.settings.get<Saved>("telemetry") ?? {};
  const resolved = () => resolveFields(deploymentLayer(), saved());
  const deployment = () => ({ retentionDays: goodRetention(envDays) ? envDays : (c.retentionDays ?? 90), fields: resolved().deployment });

  function values(): SwitchValues & { retentionDays: number } {
    const s = saved();
    return { telemetry: o.features.on("telemetry"), retentionDays: s.retentionDays ?? deployment().retentionDays, fields: resolved().values };
  }
  const changed = (): Record<string, SwitchChange> => saved().changed ?? {};
  /** The feature switches field groups depend on, as they stand (with voice only when it can run, for the checklist and the locks). */
  const featureValues = (forChecklist = false): Record<string, boolean> => ({ ...o.features.values(), ...(forChecklist && o.voiceReady ? { voice: o.voiceReady() } : {}) });
  /** What locks a switch here: the kernel's rule (switchboard.ts fieldLock) on this deployment's features and context. */
  const lockOf = (f: FieldGroup, superset: boolean) => fieldLock(f, { features: featureValues(true), mapped: mappedContext(o.context?.() ?? {}), superset });

  return {
    values,
    changed,
    featureValues,
    /** The field groups recording now (read on every record). */
    on: () => fieldsOn(values(), featureValues()),
    retentionDays: () => values().retentionDays,

    /**
     * An admin's changes: {"telemetry": bool, "fields.<id>": bool, "categories.<id>": bool, "retentionDays": n}, null
     * for the deployment's value. A category turns on every switch in it that is not privacy-sensitive, or turns
     * every one off; locked switches are left as they are. Turning a privacy-sensitive field on needs "confirm": true
     * (the page's confirm step); without it nothing changes and the answer says what to confirm. All or nothing.
     * superset: whether this host reads Superset's action log (it runs inside Superset).
     */
    update(body: Record<string, unknown>, by: string, opts: { superset?: boolean } = {}): SwitchUpdate {
      const superset = !!opts.superset;
      // The older names of the fields that kept their ids: questionText, keepAudio and items.<sensitive field>.
      const aliases: Record<string, string> = { questionText: "fields.question-text", keepAudio: "fields.voice-audio" };
      const entries = Object.entries(body)
        .filter(([k]) => k !== "confirm")
        .map(([k, v]) => [aliases[k] ?? (k.startsWith("items.") && isField(k.slice(6)) ? `fields.${k.slice(6)}` : k), v] as const);
      if (!entries.length) return { ok: false, status: 400, error: "name a switch: telemetry, fields.<field>, categories.<category> or retentionDays" };
      const now = (o.now ?? (() => new Date()))().toISOString();
      const before = values();
      const dep = deployment();
      const next: Saved = structuredClone(saved());
      const changes: { key: string; from: boolean | number | null; to: boolean | number | null }[] = [];
      let master: boolean | null | undefined;
      /** One field's change, after its checks: an error, or null. */
      const setField = (f: FieldGroup, v: boolean | null, key: string, direct: boolean): SwitchUpdate | null => {
        const lock = lockOf(f, superset);
        if (lock) return { ok: false, status: 409, error: `${f.label}: ${lockWords(lock).reason.replace("{name}", "the assistant")}` };
        const to = v ?? dep.fields[f.id]!;
        // Privacy-sensitive fields: turning one on is confirmed with its note in front of the admin.
        if (to && !before.fields[f.id] && f.sensitive && body.confirm !== true) return { ok: false, status: 409, error: `turning on ${f.label} needs confirming`, confirm: { key, label: f.label, sensitive: f.sensitive, consent: f.consent ? (o.consentNotice?.() ?? null) : null } };
        next.fields = { ...next.fields };
        if (v === null) delete next.fields[f.id];
        else next.fields[f.id] = v;
        if (direct || to !== before.fields[f.id]) changes.push({ key: `fields.${f.id}`, from: before.fields[f.id] ?? f.default, to });
        return null;
      };
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
        if (kind === "categories" && id && FIELD_CATEGORIES.some((x) => x.id === id)) {
          if (v === null) return { ok: false, status: 400, error: `${key} takes true or false; put each field back with fields.<field>: null` };
          const ids = categoryChanges(id, v, (f) => !lockOf(f, superset));
          for (const fid of ids) {
            const err = setField(fieldById(fid)!, v, `fields.${fid}`, false);
            if (err) return err;
          }
          continue;
        }
        const f = kind === "fields" && id ? fieldById(id) : undefined;
        if (f && switchable(f)) {
          const err = setField(f, v, key, true);
          if (err) return err;
          continue;
        }
        if (f) return { ok: false, status: 409, error: `${f.label} is kept by the ${f.feature} feature; change that switch instead` };
        // The older metric and section switches: a metric is now worked out from fields, and a section is a category.
        if (kind === "items" && id && legacyItemById(id)) {
          const m = legacyItemById(id)!;
          return { ok: false, status: 400, error: m.notTelemetry ? `${m.label} is not telemetry: ${m.notTelemetry}` : `${key} is an older name: metrics are worked out from the records now, with no switches. Switch the fields it read instead: ${m.needs.map((n) => `fields.${n}`).join(", ")}` };
        }
        if (kind === "groups" && id && isLegacySection(id)) return { ok: false, status: 400, error: `${key} is an older name: switch a category (categories.<category>) or a field (fields.<field>) instead` };
        return { ok: false, status: 400, error: `${key} is not a telemetry switch: name telemetry, fields.<field>, categories.<category> or retentionDays` };
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
      return { enabled: v.telemetry, retentionDays: v.retentionDays, defaults: deployment(), source: o.settings.get("telemetry") ? "settings" : "default", retentionRange: RETENTION, fieldsOn: [...fieldsOn(v, featureValues())], writable };
    },
  };
}
export type TelemetrySwitches = ReturnType<typeof telemetrySwitches>;
