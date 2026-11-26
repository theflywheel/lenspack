import type { DeploymentContext } from "@lenspack/policy";

import { TELEMETRY_GROUPS, type TelemetryItem, type ItemSource, type SwitchValues, switchDefaults, switchable } from "./switchboard";
import type { TelemetryLine } from "./telemetry";

// The telemetry checklist, which is also its switchboard: one row per item (switchboard.ts), grouped, each with its
// switch, whether it is recording, what it needs if it cannot be switched, which record fields it reads and what it
// means for privacy. A pure function of the deployment's switches, features and context and the last 7 days of
// records; the host gathers those, serves the result and takes the changes.

export type ChecklistSource = ItemSource;
export type ChecklistStatus = "recording" | "enabled-no-data" | "off" | "needs-config" | "not-telemetry";

/** Who changed a switch last, and when; null for a switch still at the deployment's value. */
export type SwitchChange = { at: string; by: string } | null;

export type ItemSwitch = {
  /** The key a change names (PUT settings/telemetry {"items.<id>": true}); null for an item with no switch of its own. */
  key: string | null;
  /** What the switch is set to (the deployment's value, or an admin's change). */
  on: boolean;
  /** The catalogue's default. */
  default: boolean;
  /** Whether it can be changed here; when not, reason says why. */
  editable: boolean;
  reason: string | null;
  /** Why it cannot be changed: it is not telemetry, it needs configuring first, or another switch owns it. */
  blockedBy: "not-telemetry" | "needs-config" | "feature" | null;
  /** The switch to change instead (a feature's, on the settings page), when another switch owns it. */
  feature: string | null;
  /** Privacy-sensitive: turning it on needs a confirm step showing this note. */
  sensitive: string | null;
  /** The consent notice shown in that confirm step too (kept recordings). */
  consent: string | null;
  changed: SwitchChange;
};

export type ChecklistItem = {
  id: string;
  label: string;
  /** The decision this measure helps make. */
  decision: string;
  source: ChecklistSource;
  status: ChecklistStatus;
  /** What to change when it is not recording; null when it is. */
  howToEnable: string | null;
  fields: string[];
  count7d: number | null;
  lastSeen: string | null;
  privacy: string[];
  /** The feature that owns this measure, when it is not telemetry's alone. */
  feature?: string;
  switch: ItemSwitch;
  /** When it went off and who turned it off (its own switch, its section's or telemetry's), if someone did. */
  offSince: string | null;
  offBy: string | null;
};

export type ChecklistGroup = { id: string; title: string; on: boolean; changed: SwitchChange; items: ChecklistItem[] };

export type Checklist = {
  generatedAt: string;
  /** Telemetry as a whole: the feature switch "telemetry". */
  telemetry: { on: boolean; changed: SwitchChange };
  /** The settings beside the switches, for the page and the Markdown copy. */
  settings: { retentionDays: number; audioRetentionDays: number; consentNotice: string | null };
  /** The same, short, for older readers of this route. */
  switches: { telemetry: boolean; retentionDays: number; audioRetentionDays: number; consentNotice: boolean };
  groups: ChecklistGroup[];
  /** Switching an item off stops new records; what was recorded stays until it ages out or is deleted per user. */
  note: string;
};

export type ChecklistInput = {
  now: Date;
  switches: SwitchValues;
  /** Who changed each switch last: "telemetry", "groups.<id>", "items.<id>". */
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
  /** What features that own a measure counted, the last 7 days (review runs, proposals, open questions). */
  owned?: Record<string, { count: number; lastSeen: string | null }>;
};

const VOICE = "Turn on the voice switch and set a speech key.";
const NOTE = "Switching something off stops new records. What was already recorded stays until it ages out (the retention below) or is deleted per user.";

/** Whether a record carries any of an item's fields for its kind (a record written while the item was off does not). */
function carries(l: TelemetryLine, s: TelemetryItem): boolean {
  const fields = (s[l.type] ?? []) as string[];
  return !fields.length || fields.some((f) => f in l);
}

function itemFor(s: TelemetryItem, group: { id: string; title: string }, i: ChecklistInput): ChecklistItem {
  const changed = i.changed ?? {};
  const key = switchable(s) ? `items.${s.id}` : null;
  const configured = i.switches.items[s.id] ?? s.default;
  const sw: ItemSwitch = {
    key,
    on: key ? configured : false,
    default: s.default,
    editable: !!key,
    reason: null,
    blockedBy: null,
    feature: null,
    sensitive: s.sensitive ?? null,
    consent: s.consent ? i.settings.consentNotice : null,
    changed: key ? (changed[key] ?? null) : null,
  };
  const fields = [...new Set([...(s.turn ?? []), ...(s.transcript ?? []), ...(s.event ?? [])].map(String))];
  const base = { id: s.id, label: s.label, decision: s.decision, source: s.source, fields, privacy: s.privacy ?? [], ...(s.feature ? { feature: s.feature } : {}) };
  const done = (status: ChecklistStatus, howToEnable: string | null, count7d: number | null = null, lastSeen: string | null = null, off: SwitchChange = null): ChecklistItem => ({ ...base, status, howToEnable, count7d, lastSeen, switch: sw, offSince: off?.at ?? null, offBy: off?.by ?? null });
  const block = (by: ItemSwitch["blockedBy"], reason: string, feature: string | null = null) => Object.assign(sw, { editable: false, blockedBy: by, reason, feature });

  // Items no switch here can turn on: not telemetry, or another switch's.
  if (s.notTelemetry) {
    block("not-telemetry", s.notTelemetry);
    return done("not-telemetry", s.notTelemetry);
  }
  if (s.feature && !(s.feature in i.features)) {
    block("feature", `Comes with the ${s.feature} feature, which this version does not have.`, s.feature);
    return done("off", sw.reason);
  }
  if (s.feature && !i.features[s.feature]) {
    block("feature", `Owned by the ${s.feature} switch, which is off. Turn it on there first.`, s.feature);
    return done("off", sw.reason);
  }
  if (s.voice && i.features.voice === false) {
    block("feature", VOICE, "voice");
    return done("off", VOICE);
  }
  // Configuration it needs before there is anything to record.
  const missing = (s.context ?? []).filter((f) => !Object.values(i.context).some((e) => e[f]));
  if (missing.length) {
    const why = `Needs the deployment's context: map boards, datasets or roles to a ${missing.join(" and ")} (context: in the config).`;
    block("needs-config", why);
    return done("needs-config", why);
  }
  if (s.source === "superset-logs" && !i.supersetLogs) {
    block("needs-config", "Only when the assistant runs inside Superset, which keeps the action log.");
    return done("needs-config", sw.reason);
  }
  if (s.roles) {
    // Role names come from the host's signed identity; turns all without them mean an older plugin that does not send them.
    const ts = i.lines.filter((l) => l.type === "turn" && "user" in l);
    if (ts.length && ts.every((l) => l.type === "turn" && !l.roles?.length)) {
      block("needs-config", "Update the Superset plugin: this one does not sign the user's role names.");
      return done("needs-config", sw.reason);
    }
  }
  if (s.owned) {
    const seen = i.owned?.[s.id];
    sw.feature = s.feature ?? null;
    sw.reason = `Kept by the ${s.feature} feature; its own switch turns it off.`;
    sw.on = true;
    sw.editable = false;
    sw.blockedBy = "feature";
    return seen?.count ? done("recording", null, seen.count, seen.lastSeen) : done("enabled-no-data", "On; nothing in the last 7 days.", seen ? 0 : null, null);
  }

  // Its switch, its section's, then telemetry's.
  const seenLines = s.seen ? i.lines.filter((l) => s.seen!(l) && carries(l, s)) : [];
  const last = seenLines.reduce<string | null>((m, l) => (m === null || l.at > m ? l.at : m), null);
  if (!configured) return done("off", "Switched off. Turn it on here.", seenLines.length, last, changed[key!] ?? null);
  if (i.switches.groups[group.id] === false) return done("off", `The ${group.title} section is off.`, seenLines.length, last, changed[`groups.${group.id}`] ?? null);
  if (!i.switches.telemetry) return done("off", "Telemetry is off.", seenLines.length, last, changed.telemetry ?? null);

  if (s.source === "audio") {
    const latest = [...i.audioSaved].sort().at(-1) ?? null;
    return done(i.audioSaved.length ? "recording" : "enabled-no-data", i.audioSaved.length ? null : "Recordings are kept from the next spoken question.", i.audioSaved.length, latest);
  }
  if (s.source === "superset-logs") {
    const l = i.supersetLogs!;
    if (!l.available) return done("needs-config", l.reason ?? "The assistant's Superset account cannot read the action log (/api/v1/log/); it needs the can read on Log permission.");
    return done(l.count ? "recording" : "enabled-no-data", l.count ? null : "Nothing exported or shared in the last 7 days.", l.count, l.lastSeen);
  }
  return seenLines.length ? done("recording", null, seenLines.length, last) : done("enabled-no-data", "On; nothing recorded in the last 7 days.", 0, null);
}

export function telemetryChecklist(i: ChecklistInput): Checklist {
  const changed = i.changed ?? {};
  const defaults = switchDefaults();
  return {
    generatedAt: i.now.toISOString(),
    telemetry: { on: i.switches.telemetry, changed: changed.telemetry ?? null },
    settings: i.settings,
    switches: { telemetry: i.switches.telemetry, retentionDays: i.settings.retentionDays, audioRetentionDays: i.settings.audioRetentionDays, consentNotice: !!i.settings.consentNotice },
    groups: TELEMETRY_GROUPS.map((g) => ({ id: g.id, title: g.title, on: i.switches.groups[g.id] ?? defaults.groups[g.id] ?? true, changed: changed[`groups.${g.id}`] ?? null, items: g.items.map((s) => itemFor(s, g, i)) })),
    note: NOTE,
  };
}
