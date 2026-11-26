import type { ContextField } from "@lenspack/policy";

import type { EventRecord, TelemetryLine, TranscriptRecord, TurnRecord } from "./telemetry";

// What usage telemetry can record, as switches: one per item (a measure the pilot is judged on), grouped as the
// pilot's metrics are, with a switch per group and one for all of telemetry. Each item names the record fields it
// adds and the client events it keeps; a field is written when at least one item that needs it is on, and left
// out of the record otherwise. The few fields every record keeps while telemetry is on (its id, its time, the pack
// and board, the tenant) only place it; even the user name is an item's, so with every user item off the
// records carry no names.
//
// The switches are deployment config (telemetry.groups and telemetry.items) that admins change on the Telemetry
// tab without a restart. This file is the catalogue and the rules; the host keeps the values.

export type ItemSource = "turn-record" | "client-event" | "transcript" | "audio" | "superset-logs" | "feature" | "config";

export type TelemetryItem = {
  id: string;
  label: string;
  /** The decision this measure helps make. */
  decision: string;
  source: ItemSource;
  /** On unless the deployment or an admin turns it off; the privacy-sensitive ones start off. */
  default: boolean;
  /** Turn record fields it adds. */
  turn?: (keyof TurnRecord)[];
  /** Transcript record fields it adds. */
  transcript?: (keyof TranscriptRecord)[];
  /** Client events it keeps (an event no item keeps is not recorded), and the event fields it adds. */
  events?: string[];
  event?: (keyof EventRecord)[];
  /** Privacy-sensitive: turning it on needs a confirm step that shows this note. */
  sensitive?: string;
  /** The confirm step also shows the deployment's consent notice (kept recordings). */
  consent?: boolean;
  /** Privacy notes shown beside it while on. */
  privacy?: string[];
  /** Which records show it is being recorded (besides carrying its fields). */
  seen?: (l: TelemetryLine) => boolean;
  /** Needs the voice switch (and a speech key). */
  voice?: boolean;
  /** Context fields it reads: with none mapped, it needs configuring. */
  context?: ContextField[];
  /** Reads the role names the host signs. */
  roles?: boolean;
  /** The feature switch that owns it: off there, off here. */
  feature?: string;
  /** Owned outright by that feature: the feature's own switch is its only switch. */
  owned?: boolean;
  /** Why it cannot be telemetry. */
  notTelemetry?: string;
};

export type TelemetryGroup = { id: string; title: string; items: TelemetryItem[] };

const turnLine = (p: (l: Extract<TelemetryLine, { type: "turn" }>) => boolean = () => true) => (l: TelemetryLine) => l.type === "turn" && p(l);
const eventLine = (...names: string[]) => (l: TelemetryLine) => l.type === "event" && names.includes(l.event);
const NAMES = ["usernames visible to admins with the usage right"];

/** The fields every record keeps while telemetry is on: enough to place it (when, which pack and board), no more. */
export const CORE_FIELDS = {
  turn: ["type", "v", "turnId", "at", "tenant", "pack", "board", "datasets"],
  transcript: ["type", "v", "transcriptId", "at", "pack"],
  event: ["type", "v", "event", "at", "turnId", "pack", "board", "data"],
} as const;

export const TELEMETRY_GROUPS: TelemetryGroup[] = [
  {
    id: "users",
    title: "Users",
    items: [
      { id: "users-active", label: "Daily and weekly active users", decision: "Is the pilot reaching people, and is use growing?", source: "turn-record", default: true, turn: ["user"], transcript: ["user"], event: ["user"], privacy: NAMES, seen: turnLine() },
      { id: "users-by-role", label: "Active users by role", decision: "Which roles use it, and who needs training or a different entry point?", source: "turn-record", default: true, turn: ["user", "roles"], transcript: ["user", "roles"], event: ["user", "roles"], privacy: NAMES, seen: turnLine(), roles: true },
      { id: "users-by-country", label: "Active users by country", decision: "Where to put support and the next rollout.", source: "turn-record", default: true, turn: ["user", "country"], privacy: NAMES, seen: turnLine(), context: ["country"] },
      { id: "users-return", label: "Users who come back next campaign", decision: "Does it keep its users from one campaign to the next?", source: "turn-record", default: true, turn: ["user", "campaign"], privacy: NAMES, seen: turnLine(), context: ["campaign"] },
    ],
  },
  {
    id: "volume-cost",
    title: "Volume and cost",
    items: [
      { id: "volume-per-user", label: "Questions per user", decision: "How much each person leans on it; sizing and budgets.", source: "turn-record", default: true, turn: ["user"], privacy: NAMES, seen: turnLine() },
      { id: "cost-per-question", label: "Cost per question (model, voice, review)", decision: "Which model to run, and whether the review step pays for itself.", source: "turn-record", default: true, turn: ["costUsd", "modelUsd", "speechUsd", "reviewUsd", "unpricedCalls", "tokensIn", "tokensOut", "models", "builder", "effort", "reviewRan", "reviewMaterial", "fixRound"], seen: turnLine() },
      { id: "cost-per-user", label: "Cost per user", decision: "The budget per supervisor for a campaign.", source: "turn-record", default: true, turn: ["user", "costUsd"], privacy: NAMES, seen: turnLine() },
      { id: "cost-voice", label: "Speech to text cost", decision: "Whether voice is affordable at campaign scale.", source: "transcript", default: true, transcript: ["usd", "seconds", "model", "ms", "retried"], seen: (l) => l.type === "transcript", voice: true },
    ],
  },
  {
    id: "quality",
    title: "Quality",
    items: [
      { id: "quality-answer-rate", label: "Answer rate by campaign type and language", decision: "Where the pack or the model falls short.", source: "turn-record", default: true, turn: ["outcome", "outcomeReason", "campaignType", "questionLanguage", "toolCalls", "queries", "queriesFailed"], seen: turnLine(), context: ["campaignType"] },
      { id: "quality-unanswered", label: "Top unanswered questions", decision: "What to add to the pack next.", source: "turn-record", default: true, turn: ["outcome", "outcomeReason", "questionHash"], seen: turnLine((l) => l.outcome !== "answered") },
      { id: "quality-thumbs-down", label: "Thumbs down and their reasons", decision: "Which answers people do not trust, and why.", source: "client-event", default: true, events: ["feedback"], event: ["rating", "reason", "commentHash", "sessionId"], seen: eventLine("feedback") },
      { id: "quality-clarify", label: "Clarifying questions: answered or dropped", decision: "Whether asking back helps or loses people.", source: "turn-record", default: true, turn: ["outcome", "sessionId"], events: ["quick-reply"], event: ["choice"], seen: (l) => (l.type === "turn" && l.outcome === "clarify") || (l.type === "event" && l.event === "quick-reply"), feature: "clarify" },
    ],
  },
  {
    id: "asks",
    title: "What people ask",
    items: [
      { id: "asks-top-by-role", label: "Top 10 questions by role", decision: "What to put on dashboards and in suggested questions.", source: "turn-record", default: true, turn: ["questionHash", "roles", "selections"], seen: turnLine(), roles: true },
      { id: "asks-repeated-direct", label: "Repeated direct questions", decision: "Which numbers deserve a chart instead of a question.", source: "turn-record", default: true, turn: ["kind", "questionHash"], seen: turnLine((l) => l.kind === "direct") },
      { id: "asks-repeated-derived", label: "Repeated derived questions", decision: "Which rates or comparisons to add as measures.", source: "turn-record", default: true, turn: ["kind", "questionHash", "computeSteps"], seen: turnLine((l) => l.kind === "derived") },
      { id: "asks-mix", label: "Mix of direct, derived and chart questions", decision: "Whether people use it to ask or to build.", source: "turn-record", default: true, turn: ["kind", "editsApplied", "editsRefused"], seen: turnLine() },
      {
        id: "question-text",
        label: "Question text",
        decision: "Read the actual words behind the top and unanswered questions.",
        source: "turn-record",
        default: false,
        turn: ["question"],
        event: ["comment"],
        sensitive: "Keeps each question's words as sent, the dashboard filter values and feedback comments. Questions can name places, people or figures. Off keeps a keyed hash instead, so repeated questions still count.",
        privacy: ["stores question text"],
        seen: turnLine((l) => typeof l.question === "string"),
      },
    ],
  },
  {
    id: "speed",
    title: "Speed",
    items: [
      { id: "speed-p95", label: "Slowest answers (95th percentile) by kind", decision: "Whether answers are fast enough on field networks.", source: "turn-record", default: true, turn: ["totalMs", "firstTokenMs", "kind"], seen: turnLine() },
      {
        id: "speed-abandoned",
        label: "Answers left before they finished",
        decision: "Where waiting loses people.",
        source: "turn-record",
        default: true,
        turn: ["abandoned", "abandonedMs"],
        events: ["abandoned"],
        event: ["how", "stage"],
        seen: (l) => (l.type === "turn" && l.abandoned === true) || (l.type === "event" && l.event === "abandoned" && l.stage !== "after-transcription"),
      },
      { id: "speed-queue", label: "Time waiting for a free slot", decision: "When to add capacity at campaign peaks.", source: "turn-record", default: true, turn: ["queueMs"], seen: turnLine((l) => typeof l.queueMs === "number" && l.queueMs > 0) },
      { id: "speed-time-saved", label: "Time saved against the old way", decision: "Whether the tool is worth the change.", source: "config", default: false, notTelemetry: "Needs a baseline: time the same tasks done the old way in a small study, then compare with totalMs here." },
    ],
  },
  {
    id: "voice",
    title: "Voice and language",
    items: [
      { id: "voice-share", label: "Share of questions spoken", decision: "Whether voice is worth keeping and improving.", source: "turn-record", default: true, turn: ["input", "transcriptId", "transcriptIds"], seen: turnLine((l) => l.input === "spoken"), voice: true },
      { id: "voice-edit-rate", label: "Transcripts edited before sending", decision: "Which languages speech to text gets wrong.", source: "turn-record", default: true, turn: ["transcriptEditDistance", "transcriptId", "transcriptHash", "questionWords"], transcript: ["transcriptHash", "words"], events: ["transcript"], event: ["transcriptEditDistance", "transcriptWords"], seen: (l) => (l.type === "turn" && typeof l.transcriptEditDistance === "number") || (l.type === "event" && l.event === "transcript"), voice: true },
      { id: "voice-reask", label: "Typed again after speaking", decision: "Whether voice failures push people back to typing.", source: "turn-record", default: true, turn: ["reAskAfterVoice"], seen: turnLine((l) => typeof l.reAskAfterVoice === "string"), voice: true },
      { id: "voice-not-sent", label: "Transcripts never sent", decision: "Whether people give up after hearing the transcript.", source: "client-event", default: true, events: ["abandoned:after-transcription"], event: ["transcriptId", "how", "stage"], seen: (l) => l.type === "event" && l.event === "abandoned" && l.stage === "after-transcription", voice: true },
      { id: "language-mix", label: "Language mix", decision: "Which languages to support well.", source: "turn-record", default: true, turn: ["questionLanguage", "replyLanguage", "languagePicked"], transcript: ["languageRequested", "languageDetected"], seen: turnLine() },
      { id: "voice-wer-proxy", label: "Word error rate (estimate from edits)", decision: "Which speech model to use per language.", source: "transcript", default: true, turn: ["transcriptEditDistance"], transcript: ["words", "languageDetected", "model"], seen: turnLine((l) => typeof l.transcriptEditDistance === "number"), voice: true },
      { id: "voice-wer-true", label: "True word error rate", decision: "Which speech model to use per language.", source: "config", default: false, notTelemetry: "Needs hand-made transcripts of real clips. Keep recordings and export the benchmark manifest to make them." },
      {
        id: "transcript-text",
        label: "Transcript text",
        decision: "See what speech to text heard, to find the words it gets wrong.",
        source: "transcript",
        default: false,
        turn: ["transcript"],
        transcript: ["transcript"],
        event: ["transcript", "transcriptSent"],
        sensitive: "Keeps what speech to text heard, word for word, beside the question that was sent. Spoken questions can name places, people or figures. Off keeps a keyed hash, so edits are still counted.",
        privacy: ["stores transcripts"],
        seen: (l) => (l.type === "transcript" && typeof l.transcript === "string") || (l.type === "turn" && typeof l.transcript === "string"),
        voice: true,
      },
      {
        id: "voice-audio",
        label: "Kept recordings",
        decision: "Material for checking speech models on real field audio.",
        source: "audio",
        default: false,
        transcript: ["audio"],
        sensitive: "Keeps the recording of each spoken question for the days set under Speech on the settings page, for admins to play, export and delete. A voice can identify the person speaking. Each user is shown the consent notice once before the mic records.",
        consent: true,
        privacy: ["stores audio"],
        voice: true,
      },
    ],
  },
  {
    id: "conversation",
    title: "Conversation",
    items: [
      { id: "conv-rephrase", label: "Questions asked again in other words", decision: "Where the first answer misses.", source: "turn-record", default: true, turn: ["rephraseOf"], seen: turnLine((l) => typeof l.rephraseOf === "string") },
      { id: "conv-follow-ups", label: "Follow-ups per conversation", decision: "Whether people explore or ask once and leave.", source: "turn-record", default: true, turn: ["sessionId"], event: ["sessionId"], seen: turnLine() },
    ],
  },
  {
    id: "trust-reuse",
    title: "Trust and reuse",
    items: [
      { id: "trust-explain", label: "How an answer was worked out, opened", decision: "Whether people check where numbers come from.", source: "client-event", default: true, events: ["explain-opened"], seen: eventLine("explain-opened") },
      { id: "trust-export-share", label: "Charts exported or boards shared in Lenspack", decision: "Whether answers travel beyond the person who asked.", source: "client-event", default: true, events: ["chart-exported", "board-shared"], event: ["choice"], seen: eventLine("chart-exported", "board-shared") },
      { id: "trust-superset-actions", label: "Exports and shares in Superset on Lenspack's dashboards", decision: "Whether dashboards Lenspack built get used.", source: "superset-logs", default: true, privacy: NAMES },
      { id: "reuse-hit-rate", label: "Saved answers used, by tier", decision: "How much reuse saves, and whether its tiers are right.", source: "turn-record", default: true, turn: ["reuse"], seen: turnLine((l) => typeof l.reuse === "string"), feature: "cache" },
      { id: "reuse-saved", label: "Money saved by saved answers", decision: "Whether answer reuse pays for itself.", source: "turn-record", default: true, turn: ["reuse", "reuseSavedUsd"], seen: turnLine((l) => typeof l.reuseSavedUsd === "number"), feature: "cache" },
      { id: "review-runs", label: "Daily review runs", decision: "How often answers are checked after the fact.", source: "feature", default: true, feature: "review.daily", owned: true },
      { id: "review-proposals", label: "Daily review proposals", decision: "Which definition changes the review suggests, and which admins accept.", source: "feature", default: true, feature: "review.daily", owned: true },
      { id: "review-open-questions", label: "Open questions (two readings)", decision: "What is waiting on a person to settle.", source: "feature", default: true, feature: "clarify", owned: true },
    ],
  },
  {
    id: "device-network",
    title: "Device and network",
    items: [
      { id: "device-class", label: "Phone, tablet or desktop, and screen width", decision: "Which screens to design for first.", source: "turn-record", default: false, turn: ["device", "viewport"], sensitive: "Records each user's kind of device and screen width class with every question. Together with the user name this describes the equipment people use.", privacy: ["device class per user"], seen: turnLine((l) => typeof l.device === "string" || typeof l.viewport === "string") },
      { id: "device-network", label: "Network type and data saver", decision: "How light answers must be for field networks.", source: "turn-record", default: false, turn: ["network", "saveData"], sensitive: "Records each user's network type (wifi, cellular, 2g to 4g) and whether data saver is on, with every question.", privacy: ["network type per user"], seen: turnLine((l) => typeof l.network === "string") },
    ],
  },
];

export const TELEMETRY_ITEMS: TelemetryItem[] = TELEMETRY_GROUPS.flatMap((g) => g.items);
const BY_ID = new Map(TELEMETRY_ITEMS.map((s) => [s.id, s]));
const GROUP_OF = new Map(TELEMETRY_GROUPS.flatMap((g) => g.items.map((s) => [s.id, g.id] as const)));
export const itemById = (id: string) => BY_ID.get(id);
export const groupOf = (id: string) => GROUP_OF.get(id);

/** Whether an item has a switch of its own: not one that cannot be telemetry, nor one a feature owns outright. */
export const switchable = (s: TelemetryItem) => !s.notTelemetry && !s.owned;

/** The switches' values: telemetry as a whole, each group, each item. */
export type SwitchValues = { telemetry: boolean; groups: Record<string, boolean>; items: Record<string, boolean> };

/** Every switch at its default: all groups on, each item as the catalogue says (privacy-sensitive ones off). */
export function switchDefaults(): { groups: Record<string, boolean>; items: Record<string, boolean> } {
  return {
    groups: Object.fromEntries(TELEMETRY_GROUPS.map((g) => [g.id, true])),
    items: Object.fromEntries(TELEMETRY_ITEMS.filter(switchable).map((s) => [s.id, s.default])),
  };
}

/**
 * Why an item records nothing whatever its switch says, or null: it cannot be telemetry, the feature that owns it
 * is off (or not in this version), or it needs voice, which is off.
 */
export function itemBlock(s: TelemetryItem, features: Record<string, boolean>): { kind: "not-telemetry" | "feature" | "voice"; feature?: string } | null {
  if (s.notTelemetry) return { kind: "not-telemetry" };
  if (s.feature && !features[s.feature]) return { kind: "feature", feature: s.feature };
  if (s.voice && features.voice === false) return { kind: "voice", feature: "voice" };
  return null;
}

/** The items recording now: telemetry on, the group on, the item on, and nothing blocking it. */
export function itemsOn(sw: SwitchValues, features: Record<string, boolean> = {}): Set<string> {
  const on = new Set<string>();
  if (!sw.telemetry) return on;
  for (const g of TELEMETRY_GROUPS) {
    if (sw.groups[g.id] === false) continue;
    for (const s of g.items) {
      if (s.owned || itemBlock(s, features)) continue;
      if (sw.items[s.id] ?? s.default) on.add(s.id);
    }
  }
  return on;
}

/** The fields a record of one kind keeps with these items on: the core ones, and each on item's. */
export function keptFields(kind: keyof typeof CORE_FIELDS, on: ReadonlySet<string>): Set<string> {
  const out = new Set<string>(CORE_FIELDS[kind]);
  for (const id of on) for (const f of BY_ID.get(id)?.[kind] ?? []) out.add(f as string);
  return out;
}

/** A record with only the fields its on items need: a switched-off item's fields are left out, not nulled. */
export function onlyKept<T extends object>(kind: keyof typeof CORE_FIELDS, line: T, on: ReadonlySet<string>): Partial<T> {
  const keep = keptFields(kind, on);
  return Object.fromEntries(Object.entries(line).filter(([k]) => keep.has(k))) as Partial<T>;
}

/** The item that keeps a client event (by type, and stage for an abandoned transcript), if any. */
export function itemForEvent(type: string, stage?: string | null): TelemetryItem | undefined {
  const key = type === "abandoned" && stage === "after-transcription" ? "abandoned:after-transcription" : type;
  return TELEMETRY_ITEMS.find((s) => s.events?.includes(key));
}

/** Every client event type some item keeps. */
export const EVENT_TYPES = [...new Set(TELEMETRY_ITEMS.flatMap((s) => s.events ?? []).map((e) => e.split(":")[0]!))];

/** The switches as a config block: telemetry.groups and telemetry.items, every key with its default. */
export function switchesYaml(): string {
  const d = switchDefaults();
  const lines = ["telemetry:", "  groups:"];
  for (const g of TELEMETRY_GROUPS) lines.push(`    ${g.id}: ${d.groups[g.id]}`);
  lines.push("  items:");
  for (const g of TELEMETRY_GROUPS) {
    lines.push(`    # ${g.title}`);
    for (const s of g.items.filter(switchable)) lines.push(`    ${s.id}: ${s.default}${s.sensitive ? "   # privacy-sensitive: confirm to turn on" : ""}`);
  }
  return lines.join("\n");
}
