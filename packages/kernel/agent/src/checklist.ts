import type { ContextField, DeploymentContext } from "@lenspack/policy";

import { type MetricReading, readMetric } from "./metrics";
import {
  FIELD_CATEGORIES,
  METRIC_GROUPS,
  type CategoryState,
  type FieldGroup,
  type FieldLock,
  type FieldSource,
  type Metric,
  type SwitchValues,
  carries,
  categoryState,
  fieldById,
  fieldDefaults,
  fieldLock,
  metricsUsing,
  switchable,
} from "./switchboard";
import type { TelemetryLine } from "./telemetry";

// The Telemetry tab's data, in two views. What's recorded: one row per field group (switchboard.ts), in plain
// categories, each with its switch, whether it is recording, how many records carried it in the last 7 days, what
// it means for privacy and which metrics read it; a category's switch is worked out from the switches inside it.
// What it tells you: each metric worked out from the same 7 days of records (metrics.ts), or why it can't be,
// pointing at the field or setting that would fix it. A pure function of the deployment's switches, features and
// context and the last 7 days of records; the host gathers those, serves the result and takes the changes.

export type FieldStatus = "recording" | "enabled-no-data" | "off" | "needs-config";

/** Who changed a switch last, and when; null for a switch still at the deployment's value. */
export type SwitchChange = { at: string; by: string } | null;

/** Where to go to fix a locked switch or an unavailable metric: a feature's switch on the Settings tab, a field's switch, or the config file. */
export type Fix = { kind: "settings"; feature: string } | { kind: "field"; id: string } | { kind: "config"; key: string };

export type FieldSwitch = {
  /** The key a change names (PUT settings/telemetry {"fields.<id>": true}); null for a field group with no switch of its own. */
  key: string | null;
  /** What the switch is set to (the deployment's value, or an admin's change). */
  on: boolean;
  /** The catalogue's default. */
  default: boolean;
  /** Whether it can be changed here; when not, lock and reason say why, and fix where to go. */
  editable: boolean;
  lock: FieldLock | null;
  reason: string | null;
  fix: Fix | null;
  /** Privacy-sensitive: turning it on needs a confirm step showing this note, and a category switch never turns it on. */
  sensitive: string | null;
  /** The consent notice shown in that confirm step too (kept recordings). */
  consent: string | null;
  changed: SwitchChange;
};

export type FieldRow = {
  id: string;
  label: string;
  about: string;
  source: FieldSource;
  /** The record fields it covers, as record.field (turn.user, event.rating); an event it keeps as event:<type>. */
  fields: string[];
  status: FieldStatus;
  /** What to change when it is not recording; null when it is. */
  howToEnable: string | null;
  /** Records in the last 7 days that carry it (not a metric's value). */
  count7d: number | null;
  lastSeen: string | null;
  privacy: string[];
  /** The metrics that read it. */
  usedBy: { id: string; label: string }[];
  switch: FieldSwitch;
  /** When it went off and who turned it off (its own switch or telemetry's), if someone did. */
  offSince: string | null;
  offBy: string | null;
};

export type CategoryNote = "sensitive-apart" | "sensitive-only" | null;

export type FieldCategoryView = {
  id: string;
  title: string;
  /** Worked out from the switches inside it; it keeps no value of its own (switchboard.ts categoryState). */
  state: CategoryState;
  /** What switching it does: true turns on every switch in it that is not sensitive, false turns every one off; null: nothing to do here. */
  next: boolean | null;
  /** sensitive-apart: switching it on leaves its sensitive fields off; sensitive-only: each of its switches is turned on by itself. */
  note: CategoryNote;
  rows: FieldRow[];
};

export type MetricStatus = "ready" | "no-data" | "unavailable";

export type Unavailable = {
  kind: "telemetry-off" | "fields-off" | "locked" | "needs-config" | "not-telemetry";
  /** In English, for the Markdown copy and older readers. */
  text: string;
  /** The field groups that are off (fields-off), or the one that is locked (locked). */
  fields?: { id: string; label: string }[];
  lock?: FieldLock;
  /** The context fields nobody mapped (needs-config). */
  context?: ContextField[];
  fix: Fix | null;
};

export type MetricRow = {
  id: string;
  label: string;
  /** The decision this measure helps make. */
  decision: string;
  /** The field groups it needs, and those it breaks its value down by, each with whether it is recording. */
  needs: { id: string; label: string; on: boolean }[];
  by: { id: string; label: string; on: boolean }[];
  status: MetricStatus;
  /** Its value from the last 7 days of records; null while unavailable. */
  reading: MetricReading | null;
  unavailable: Unavailable | null;
};

export type MetricGroupView = { id: string; title: string; metrics: MetricRow[] };

export type Checklist = {
  generatedAt: string;
  /** Telemetry as a whole: the feature switch "telemetry". */
  telemetry: { on: boolean; changed: SwitchChange };
  /** The settings beside the switches, for the page and the Markdown copy. */
  settings: { retentionDays: number; audioRetentionDays: number; consentNotice: string | null };
  /** The same, short, for older readers of this route. */
  switches: { telemetry: boolean; retentionDays: number; audioRetentionDays: number; consentNotice: boolean };
  /** What's recorded: the field groups by category, each with its switch. */
  categories: FieldCategoryView[];
  /** What it tells you: the metrics by group, each worked out from the last 7 days of records. */
  metrics: MetricGroupView[];
  /** Switching a field off stops new records; what was recorded stays until it ages out or is deleted per user. */
  note: string;
};

export type ChecklistInput = {
  now: Date;
  switches: SwitchValues;
  /** Who changed each switch last: "telemetry", "fields.<id>" (and the older "items.<id>"). */
  changed?: Record<string, SwitchChange>;
  settings: Checklist["settings"];
  /** The deployment's feature switches by name (absent: not in this version). */
  features: Record<string, boolean>;
  context: DeploymentContext;
  /** The last 7 days of telemetry records. */
  lines: TelemetryLine[];
  /** When kept recordings were saved, the last 7 days. */
  audioSaved: string[];
  /** Superset's action log, when the host is Superset: whether it can be read, and the exports and shares seen there. */
  supersetLogs?: { available: boolean; reason?: string; count: number; lastSeen: string | null } | null;
  /** What features that keep a measure counted, the last 7 days (review runs, proposals, open questions). */
  owned?: Record<string, { count: number; lastSeen: string | null }>;
};

const NOTE = "Switching something off stops new records. What was already recorded stays until it ages out (the retention below) or is deleted per user.";
const FEATURE_NAMES: Record<string, string> = { "review.daily": "daily review", clarify: "clarify", cache: "saved answers", personalDashboards: "personal dashboards", voice: "voice" };
const featureName = (f: string) => FEATURE_NAMES[f] ?? f;
const CONTEXT_WORDS: Record<ContextField, string> = { country: "country", campaign: "campaign", campaignType: "campaign type" };
const orList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

/** A lock in words, and where to fix it. */
export function lockWords(l: FieldLock): { reason: string; fix: Fix | null } {
  switch (l.kind) {
    case "owned":
      return { reason: `Owned by the ${featureName(l.feature)} switch: change it on the Settings tab.`, fix: { kind: "settings", feature: l.feature } };
    case "feature":
      return l.missing ? { reason: `Comes with the ${featureName(l.feature)} feature, which this version does not have.`, fix: null } : { reason: `Needs the ${featureName(l.feature)} switch, which is off: turn it on in Settings.`, fix: { kind: "settings", feature: l.feature } };
    case "voice":
      return { reason: "Needs voice: turn on the voice switch and set a speech key in Settings.", fix: { kind: "settings", feature: "voice" } };
    case "needs-config":
      return { reason: `Needs configuration: map dashboards, datasets or roles to a ${orList(l.context.map((c) => CONTEXT_WORDS[c]))} in the context: section of the config.`, fix: { kind: "config", key: "context" } };
    case "superset":
      return { reason: "Only when {name} runs inside Superset, which keeps the action log.", fix: null };
  }
}

const mappedContext = (c: DeploymentContext) => new Set(Object.values(c).flatMap((e) => (Object.keys(e) as ContextField[]).filter((k) => e[k])));

/** The record fields a group covers, as record.field, and the events it keeps. */
const fieldNames = (f: FieldGroup) => [...(f.turn ?? []).map((k) => `turn.${k}`), ...(f.transcript ?? []).map((k) => `transcript.${k}`), ...(f.event ?? []).map((k) => `event.${k}`), ...(f.events ?? []).map((e) => `event:${e}`)];

function fieldRow(f: FieldGroup, i: ChecklistInput, mapped: Set<ContextField>): FieldRow {
  const changed = i.changed ?? {};
  const key = switchable(f) ? `fields.${f.id}` : null;
  const configured = i.switches.fields[f.id] ?? f.default;
  const lock = fieldLock(f, { features: i.features, mapped, superset: !!i.supersetLogs });
  const words = lock ? lockWords(lock) : null;
  const sw: FieldSwitch = {
    key,
    on: f.owned ? !!i.features[f.feature!] : configured,
    default: f.default,
    editable: !lock,
    lock,
    reason: words?.reason ?? null,
    fix: words?.fix ?? null,
    sensitive: f.sensitive ?? null,
    consent: f.consent ? i.settings.consentNotice : null,
    changed: key ? (changed[key] ?? changed[`items.${f.id}`] ?? null) : null,
  };
  const base = { id: f.id, label: f.label, about: f.about, source: f.source, fields: fieldNames(f), privacy: f.privacy ?? [], usedBy: metricsUsing(f.id).map((m) => ({ id: m.id, label: m.label })), switch: sw };
  const done = (status: FieldStatus, howToEnable: string | null, count7d: number | null = null, lastSeen: string | null = null, off: SwitchChange = null): FieldRow => ({ ...base, status, howToEnable, count7d, lastSeen, offSince: off?.at ?? null, offBy: off?.by ?? null });

  // Kept by a feature, not by telemetry.
  if (f.owned) {
    const ids = f.id === "daily-review" ? ["review-runs", "review-proposals"] : ["review-open-questions"];
    const seen = ids.map((id) => i.owned?.[id]).filter((x): x is { count: number; lastSeen: string | null } => !!x);
    const n = seen.reduce((a, s) => a + s.count, 0);
    const last = seen.reduce<string | null>((m, s) => (s.lastSeen && (!m || s.lastSeen > m) ? s.lastSeen : m), null);
    if (!i.features[f.feature!]) return done("off", sw.reason, seen.length ? n : null, last);
    return n ? done("recording", null, n, last) : done("enabled-no-data", "On; nothing in the last 7 days.", seen.length ? 0 : null, null);
  }
  const seenLines = i.lines.filter((l) => carries(l, f));
  const last = seenLines.reduce<string | null>((m, l) => (m === null || l.at > m ? l.at : m), null);
  if (lock) return done(lock.kind === "needs-config" || lock.kind === "superset" ? "needs-config" : "off", sw.reason, seenLines.length, last);
  if (!configured) return done("off", "Switched off. Turn it on here.", seenLines.length, last, sw.changed);
  if (!i.switches.telemetry) return done("off", "Telemetry is off.", seenLines.length, last, changed.telemetry ?? null);
  if (f.id === "roles") {
    // Role names come from the host's signed identity; turns all without them mean an older plugin that does not send them.
    const ts = i.lines.filter((l) => l.type === "turn" && "roles" in l);
    if (ts.length && ts.every((l) => l.type === "turn" && !l.roles?.length)) return done("needs-config", "Update the Superset plugin: this one does not sign the user's role names.", seenLines.length, last);
  }
  if (f.source === "audio") {
    const latest = [...i.audioSaved].sort().at(-1) ?? null;
    return done(i.audioSaved.length ? "recording" : "enabled-no-data", i.audioSaved.length ? null : "Recordings are kept from the next spoken question.", i.audioSaved.length, latest);
  }
  if (f.source === "superset-logs") {
    const l = i.supersetLogs!;
    if (!l.available) return done("needs-config", l.reason ?? "{name}'s Superset account cannot read the action log (/api/v1/log/); it needs the can read on Log permission.");
    return done(l.count ? "recording" : "enabled-no-data", l.count ? null : "Nothing exported or shared in the last 7 days.", l.count, l.lastSeen);
  }
  return seenLines.length ? done("recording", null, seenLines.length, last) : done("enabled-no-data", "On; nothing recorded in the last 7 days.", 0, null);
}

function metricRow(m: Metric, i: ChecklistInput, rows: Map<string, FieldRow>, mapped: Set<ContextField>): MetricRow {
  /** Whether a field group is recording now: a feature's own while that feature is on; telemetry's while its switch, telemetry's and its configuration allow. */
  const recording = (r: FieldRow | undefined) => (!r ? false : fieldById(r.id)?.owned ? r.switch.on : r.switch.on && r.switch.editable && i.switches.telemetry && r.status !== "needs-config");
  const ref = (id: string) => ({ id, label: rows.get(id)?.label ?? id, on: recording(rows.get(id)) });
  const base = { id: m.id, label: m.label, decision: m.decision, needs: m.needs.map(ref), by: (m.by ?? []).map(ref) };
  const out = (u: Unavailable): MetricRow => ({ ...base, status: "unavailable", reading: null, unavailable: u });
  if (m.notTelemetry) return out({ kind: "not-telemetry", text: m.notTelemetry, fix: null });
  const needs = m.needs.map((id) => rows.get(id)!);
  const owned = needs.every((r) => fieldById(r.id)?.owned);
  if (!owned && !i.switches.telemetry) return out({ kind: "telemetry-off", text: "Telemetry is off.", fix: null });
  const locked = needs.find((r) => r.switch.lock && r.switch.lock.kind !== "owned");
  if (locked) return out({ kind: "locked", text: `Unavailable: ${locked.label}: ${locked.switch.reason}`, fields: [{ id: locked.id, label: locked.label }], lock: locked.switch.lock!, fix: locked.switch.fix });
  const ownedOff = needs.find((r) => fieldById(r.id)?.owned && !r.switch.on);
  if (ownedOff) return out({ kind: "locked", text: `Unavailable: ${ownedOff.switch.reason}`, fields: [{ id: ownedOff.id, label: ownedOff.label }], lock: ownedOff.switch.lock!, fix: ownedOff.switch.fix });
  const off = needs.filter((r) => !fieldById(r.id)?.owned && !r.switch.on);
  if (off.length) return out({ kind: "fields-off", text: `Unavailable: needs ${off.map((r) => r.label).join(", ")} (switched off).`, fields: off.map((r) => ({ id: r.id, label: r.label })), fix: { kind: "field", id: off[0]!.id } });
  const missing = (m.context ?? []).filter((c) => !mapped.has(c));
  if (missing.length) return out({ kind: "needs-config", text: `Needs configuration: map dashboards, datasets or roles to a ${orList(missing.map((c) => CONTEXT_WORDS[c]))} in the context: section of the config.`, context: missing, fix: { kind: "config", key: "context" } });
  const unreadable = needs.find((r) => r.status === "needs-config");
  if (unreadable) return out({ kind: "needs-config", text: `Needs configuration: ${unreadable.howToEnable ?? ""}`.trim(), fields: [{ id: unreadable.id, label: unreadable.label }], fix: { kind: "field", id: unreadable.id } });
  const reading = readMetric(m.id, i.lines, { now: i.now, supersetLogs: i.supersetLogs, owned: i.owned });
  if (!reading) return out({ kind: "not-telemetry", text: "Not worked out from records.", fix: null });
  return { ...base, status: reading.records ? "ready" : "no-data", reading, unavailable: null };
}

export function telemetryChecklist(i: ChecklistInput): Checklist {
  const changed = i.changed ?? {};
  const mapped = mappedContext(i.context);
  const switches = { ...i.switches, fields: { ...fieldDefaults(), ...i.switches.fields } };
  const input = { ...i, switches };
  const categories: FieldCategoryView[] = FIELD_CATEGORIES.map((c) => {
    const rows = c.fields.map((f) => fieldRow(f, input, mapped));
    const own = rows.filter((r) => r.switch.key);
    const { state, next } = categoryState(own.map((r) => ({ on: r.switch.on, sensitive: !!r.switch.sensitive, editable: r.switch.editable })));
    const sensitive = own.filter((r) => r.switch.sensitive);
    const note: CategoryNote = !sensitive.length ? null : sensitive.length === own.length ? "sensitive-only" : "sensitive-apart";
    return { id: c.id, title: c.title, state, next, note, rows };
  });
  const byId = new Map(categories.flatMap((c) => c.rows.map((r) => [r.id, r] as const)));
  return {
    generatedAt: i.now.toISOString(),
    telemetry: { on: i.switches.telemetry, changed: changed.telemetry ?? null },
    settings: i.settings,
    switches: { telemetry: i.switches.telemetry, retentionDays: i.settings.retentionDays, audioRetentionDays: i.settings.audioRetentionDays, consentNotice: !!i.settings.consentNotice },
    categories,
    metrics: METRIC_GROUPS.map((g) => ({ id: g.id, title: g.title, metrics: g.metrics.map((m) => metricRow(m, input, byId, mapped)) })),
    note: NOTE,
  };
}
