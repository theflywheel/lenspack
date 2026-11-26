import type { ContextField } from "@lenspack/policy";

import type { EventRecord, TelemetryLine, TranscriptRecord, TurnRecord } from "./telemetry";

// What usage telemetry records, as switches. The switches are on the raw facts a record carries (field groups:
// the user name, the cost, the time an answer took, the thumbs, the words of a question), grouped in plain
// categories. A field is written when its group is on, and left out of the record otherwise. The few fields every
// record keeps while telemetry is on (its id, its time, the pack and board, the tenant) only place it; even the
// user name has a switch, so with it off the records carry no names.
//
// The metrics a deployment reads (active users, cost per question, answer rate) are not recorded: they are measures
// in the usage pack, worked out from the records by the engine when someone looks. A measure that reads a field group
// that is off, or not set up, is unavailable rather than wrong (fieldNotices in checklist.ts says why).
//
// The switches are deployment config (telemetry.fields) that admins change on the Telemetry tab without a restart.
// The older names (telemetry.items.<metric>, telemetry.groups.<section>) are read through fieldsFromLegacy below. This
// file is the catalogue and the rules; the host keeps the values.

export type FieldSource = "turn-record" | "client-event" | "transcript" | "audio" | "superset-logs" | "feature";

/** A switch: one raw fact (or a few that only make sense together) the records carry. */
export type FieldGroup = {
  id: string;
  label: string;
  /** What it holds, in plain words. */
  about: string;
  source: FieldSource;
  /** On unless the deployment or an admin turns it off; the privacy-sensitive ones start off. */
  default: boolean;
  /** Turn record fields it adds. */
  turn?: (keyof TurnRecord)[];
  /** Transcript record fields it adds. */
  transcript?: (keyof TranscriptRecord)[];
  /** Client events it keeps (an event no group keeps is not recorded), and the event fields it adds. */
  events?: string[];
  event?: (keyof EventRecord)[];
  /** Privacy-sensitive: turning it on needs a confirm step that shows this note, and a category switch never turns it on. */
  sensitive?: string;
  /** The confirm step also shows the deployment's consent notice (kept recordings). */
  consent?: boolean;
  /** Privacy notes shown beside it. */
  privacy?: string[];
  /** Needs the voice switch (and a speech key). */
  voice?: boolean;
  /** Context fields it reads: with none of them mapped, it needs configuring. */
  context?: ContextField[];
  /** The feature switch that owns it: off there, off here. */
  feature?: string;
  /** Kept by that feature outright, not by telemetry: the feature's own switch is its only switch. */
  owned?: boolean;
};

export type FieldCategory = { id: string; title: string; fields: FieldGroup[] };

const NAMES = ["usernames visible to admins with the usage right"];

/** The fields every record keeps while telemetry is on: enough to place it (when, which pack and board), no more. */
export const CORE_FIELDS = {
  turn: ["type", "v", "turnId", "at", "tenant", "pack", "board", "datasets"],
  transcript: ["type", "v", "transcriptId", "at", "pack"],
  event: ["type", "v", "event", "at", "turnId", "pack", "board", "data"],
} as const;

export const FIELD_CATEGORIES: FieldCategory[] = [
  {
    id: "who",
    title: "Who and where",
    fields: [
      { id: "user", label: "User name", about: "Who asked, on every record.", source: "turn-record", default: true, turn: ["user"], transcript: ["user"], event: ["user"], privacy: NAMES },
      { id: "roles", label: "Role names", about: "The roles the sign-in gave the person who asked.", source: "turn-record", default: true, turn: ["roles"], transcript: ["roles"], event: ["roles"] },
      { id: "context", label: "Campaign and country tags", about: "The campaign, campaign type and country the deployment's context: section maps to the board, dataset or role.", source: "turn-record", default: true, turn: ["campaign", "campaignType", "country"], context: ["campaign", "campaignType", "country"] },
      { id: "conversation", label: "Conversation", about: "Which conversation a question belongs to, so follow-ups can be counted.", source: "turn-record", default: true, turn: ["sessionId"], event: ["sessionId"] },
      { id: "selections", label: "Dashboard filters picked", about: "The filter values the viewer had picked when they asked. Values are hashed unless question words are kept.", source: "turn-record", default: true, turn: ["selections"] },
      {
        id: "device-class",
        label: "Device and screen width",
        about: "Phone, tablet or desktop, and a narrow, medium or wide screen.",
        source: "turn-record",
        default: false,
        turn: ["device", "viewport"],
        sensitive: "Records each user's kind of device and screen width class with every question. Together with the user name this describes the equipment people use.",
        privacy: ["device class per user"],
      },
      {
        id: "device-network",
        label: "Network type and data saver",
        about: "Wifi or mobile (2g to 4g), and whether data saver is on.",
        source: "turn-record",
        default: false,
        turn: ["network", "saveData"],
        sensitive: "Records each user's network type (wifi, cellular, 2g to 4g) and whether data saver is on, with every question.",
        privacy: ["network type per user"],
      },
    ],
  },
  {
    id: "asked",
    title: "What was asked",
    fields: [
      { id: "question-hash", label: "Question fingerprint and length", about: "A keyed hash of the question's words, so repeats can be counted without keeping the words, and how many words it had.", source: "turn-record", default: true, turn: ["questionHash", "questionWords"] },
      { id: "language", label: "Languages", about: "The language picked in the chat, the question's language and the reply's.", source: "turn-record", default: true, turn: ["languagePicked", "questionLanguage", "replyLanguage"], transcript: ["languageRequested", "languageDetected"] },
      { id: "repeats", label: "Asked again", about: "Which earlier question, within two minutes, this one repeats in other words, and whether that one was spoken.", source: "turn-record", default: true, turn: ["rephraseOf", "reAskAfterVoice"] },
    ],
  },
  {
    id: "happened",
    title: "What happened",
    fields: [
      { id: "outcome", label: "How it ended", about: "Answered, declined, failed or asked back, and why.", source: "turn-record", default: true, turn: ["outcome", "outcomeReason"] },
      { id: "work", label: "Kind of question and the work it took", about: "Direct, derived, chart or meta, and how many tool calls, queries, compute steps and board edits it took.", source: "turn-record", default: true, turn: ["kind", "toolCalls", "queries", "queriesFailed", "computeSteps", "editsApplied", "editsRefused"] },
      { id: "review", label: "Review step", about: "Whether the reviewer ran, its material findings, and whether a fix round followed.", source: "turn-record", default: true, turn: ["reviewRan", "reviewMaterial", "fixRound"] },
      { id: "reuse", label: "Saved answers used", about: "The tier of the saved answer a question was answered from, and what it saved.", source: "turn-record", default: true, turn: ["reuse", "reuseSavedUsd"], feature: "cache" },
      { id: "superset-actions", label: "Exports and shares in Superset", about: "Read from Superset's own action log when someone looks, for the dashboards {name} works on. Nothing is copied into the records.", source: "superset-logs", default: true, privacy: NAMES },
      { id: "daily-review", label: "Daily review runs and proposals", about: "Kept by the daily review itself.", source: "feature", default: true, feature: "review.daily", owned: true },
      { id: "open-questions", label: "Open questions", about: "Questions with two readings, kept by the clarify feature.", source: "feature", default: true, feature: "clarify", owned: true },
    ],
  },
  {
    id: "cost-speed",
    title: "Cost and speed",
    fields: [
      { id: "cost", label: "Cost, tokens and models", about: "What each question cost (model, speech and review), the tokens, and which models answered.", source: "turn-record", default: true, turn: ["costUsd", "modelUsd", "speechUsd", "reviewUsd", "unpricedCalls", "tokensIn", "tokensOut", "models", "builder", "effort"] },
      { id: "timing", label: "Answer time", about: "Time to the first words and to the end of the reply.", source: "turn-record", default: true, turn: ["firstTokenMs", "totalMs"] },
      { id: "queue", label: "Wait for a free slot", about: "How long a question waited in the queue at busy times.", source: "turn-record", default: true, turn: ["queueMs"] },
      { id: "abandoned", label: "Answers left early", about: "Answers the reader left before they finished, and how they left.", source: "turn-record", default: true, turn: ["abandoned", "abandonedMs"], events: ["abandoned"], event: ["how", "stage"] },
    ],
  },
  {
    id: "feedback",
    title: "Feedback",
    fields: [
      { id: "feedback", label: "Thumbs up or down, and the reason", about: "The rating under an answer, the reason picked, and a hash of any comment.", source: "client-event", default: true, events: ["feedback"], event: ["rating", "reason", "commentHash"] },
      { id: "quick-replies", label: "Quick replies picked", about: "Which button someone picked when the assistant asked back.", source: "client-event", default: true, events: ["quick-reply"], event: ["choice"], feature: "clarify" },
      { id: "explain", label: "“How this was worked out” opened", about: "Each time someone opens the working behind an answer.", source: "client-event", default: true, events: ["explain-opened"] },
      { id: "export-share", label: "Charts exported, boards shared", about: "Exports and shares done in {name}'s own app.", source: "client-event", default: true, events: ["chart-exported", "board-shared"], event: ["choice"] },
      { id: "personal-dashboards", label: "Own dashboards and saved layouts", about: "Dashboards people made, copied or deleted, and saved layouts used: ids and counts only.", source: "client-event", default: true, events: ["personal-dashboard", "saved-layout"], event: ["how"], feature: "personalDashboards" },
    ],
  },
  {
    id: "voice",
    title: "Voice",
    fields: [
      { id: "input", label: "Typed or spoken", about: "Whether a question was typed or spoken.", source: "turn-record", default: true, turn: ["input"], voice: true },
      { id: "transcript-links", label: "Transcript links", about: "Which transcription a spoken question came from.", source: "turn-record", default: true, turn: ["transcriptId", "transcriptIds"], voice: true },
      { id: "transcript-edits", label: "Edits to the transcript", about: "How many words were changed between what speech to text heard and what was sent, with a hash of the transcript.", source: "turn-record", default: true, turn: ["transcriptHash", "transcriptEditDistance"], transcript: ["transcriptHash", "words"], events: ["transcript"], event: ["transcriptEditDistance", "transcriptWords"], voice: true },
      { id: "speech-cost", label: "Speech to text cost and time", about: "What each transcription cost, how long the clip was, the model, and whether it was retried.", source: "transcript", default: true, transcript: ["usd", "seconds", "model", "ms", "retried"], voice: true },
      { id: "voice-not-sent", label: "Transcripts never sent", about: "A transcription no question claimed within an hour.", source: "client-event", default: true, events: ["abandoned:after-transcription"], event: ["transcriptId", "how", "stage"], voice: true },
    ],
  },
  {
    id: "texts",
    title: "Texts",
    fields: [
      {
        id: "question-text",
        label: "Question words",
        about: "Each question's words as sent, the dashboard filter values and feedback comments.",
        source: "turn-record",
        default: false,
        turn: ["question"],
        event: ["comment"],
        sensitive: "Keeps each question's words as sent, the dashboard filter values and feedback comments. Questions can name places, people or figures. Off keeps a keyed hash instead, so repeated questions still count.",
        privacy: ["stores question text"],
      },
      {
        id: "transcript-text",
        label: "Transcript words",
        about: "What speech to text heard, word for word.",
        source: "transcript",
        default: false,
        turn: ["transcript"],
        transcript: ["transcript"],
        event: ["transcript", "transcriptSent"],
        sensitive: "Keeps what speech to text heard, word for word, beside the question that was sent. Spoken questions can name places, people or figures. Off keeps a keyed hash, so edits are still counted.",
        privacy: ["stores transcripts"],
        voice: true,
      },
      {
        id: "voice-audio",
        label: "Recordings",
        about: "The recording of each spoken question, for the days set under Speech.",
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
];

export const FIELD_GROUPS: FieldGroup[] = FIELD_CATEGORIES.flatMap((c) => c.fields);
const FIELD_BY_ID = new Map(FIELD_GROUPS.map((f) => [f.id, f]));
const CATEGORY_OF = new Map(FIELD_CATEGORIES.flatMap((c) => c.fields.map((f) => [f.id, c.id] as const)));
export const fieldById = (id: string) => FIELD_BY_ID.get(id);
export const categoryOf = (id: string) => CATEGORY_OF.get(id);

/** Whether a field group has a switch of its own (not one a feature keeps outright). */
export const switchable = (f: FieldGroup) => !f.owned;

// ---- the older switches: one per metric, read as field switches ------------------------------------------------
//
// Before field switches, a deployment switched what it measured: one switch per metric, in sections. Metrics are
// now measures in the usage pack (packs/usage), worked out by the engine from the records, with no switches. This
// table keeps each older switch's id with the field groups it read, so older settings keep their meaning
// (fieldsFromLegacy below) and a route can say which fields to switch instead.

export type LegacySource = "records" | "transcripts" | "superset-logs" | "feature" | "none";

/** An older metric switch: its id, what it measured, and the field groups it read. */
export type LegacyItem = {
  id: string;
  label: string;
  /** The decision this measure helps make. */
  decision: string;
  source: LegacySource;
  /** Field groups it cannot be worked out without. */
  needs: string[];
  /** Field groups it breaks its value down by when they are on (optional). */
  by?: string[];
  /** Context fields it reads: with none of these mapped, it needs configuring. */
  context?: ContextField[];
  /** Why records cannot measure it. */
  notTelemetry?: string;
};

export type LegacyGroup = { id: string; title: string; metrics: LegacyItem[] };

export const LEGACY_GROUPS: LegacyGroup[] = [
  {
    id: "users",
    title: "Users",
    metrics: [
      { id: "users-active", label: "Daily and weekly active users", decision: "Is the pilot reaching people, and is use growing?", source: "records", needs: ["user"] },
      { id: "users-by-role", label: "Active users by role", decision: "Which roles use it, and who needs training or a different entry point?", source: "records", needs: ["user", "roles"] },
      { id: "users-by-country", label: "Active users by country", decision: "Where to put support and the next rollout.", source: "records", needs: ["user", "context"], context: ["country"] },
      { id: "users-return", label: "Users who come back next campaign", decision: "Does it keep its users from one campaign to the next?", source: "records", needs: ["user", "context"], context: ["campaign"] },
    ],
  },
  {
    id: "volume-cost",
    title: "Volume and cost",
    metrics: [
      { id: "volume-per-user", label: "Questions per user", decision: "How much each person leans on it; sizing and budgets.", source: "records", needs: ["user"] },
      { id: "cost-per-question", label: "Cost per question (model, voice, review)", decision: "Which model to run, and whether the review step pays for itself.", source: "records", needs: ["cost"], by: ["review"] },
      { id: "cost-per-user", label: "Cost per user", decision: "The budget per supervisor for a campaign.", source: "records", needs: ["user", "cost"] },
      { id: "cost-voice", label: "Speech to text cost", decision: "Whether voice is affordable at campaign scale.", source: "transcripts", needs: ["speech-cost"] },
    ],
  },
  {
    id: "quality",
    title: "Quality",
    metrics: [
      { id: "quality-answer-rate", label: "Answer rate by campaign type and language", decision: "Where the pack or the model falls short.", source: "records", needs: ["outcome"], by: ["language", "context", "work"] },
      { id: "quality-unanswered", label: "Top unanswered questions", decision: "What to add to the pack next.", source: "records", needs: ["outcome", "question-hash"] },
      { id: "quality-thumbs-down", label: "Thumbs down and their reasons", decision: "Which answers people do not trust, and why.", source: "records", needs: ["feedback"], by: ["conversation"] },
      { id: "quality-clarify", label: "Clarifying questions: answered or dropped", decision: "Whether asking back helps or loses people.", source: "records", needs: ["outcome", "quick-replies"], by: ["conversation"] },
    ],
  },
  {
    id: "asks",
    title: "What people ask",
    metrics: [
      { id: "asks-top-by-role", label: "Top 10 questions by role", decision: "What to put on dashboards and in suggested questions.", source: "records", needs: ["question-hash", "roles"], by: ["selections"] },
      { id: "asks-repeated-direct", label: "Repeated direct questions", decision: "Which numbers deserve a chart instead of a question.", source: "records", needs: ["work", "question-hash"] },
      { id: "asks-repeated-derived", label: "Repeated derived questions", decision: "Which rates or comparisons to add as measures.", source: "records", needs: ["work", "question-hash"] },
      { id: "asks-mix", label: "Mix of direct, derived and chart questions", decision: "Whether people use it to ask or to build.", source: "records", needs: ["work"] },
    ],
  },
  {
    id: "speed",
    title: "Speed",
    metrics: [
      { id: "speed-p95", label: "Slowest answers (95th percentile) by kind", decision: "Whether answers are fast enough on field networks.", source: "records", needs: ["timing"], by: ["work"] },
      { id: "speed-abandoned", label: "Answers left before they finished", decision: "Where waiting loses people.", source: "records", needs: ["abandoned"] },
      { id: "speed-queue", label: "Time waiting for a free slot", decision: "When to add capacity at campaign peaks.", source: "records", needs: ["queue"] },
      { id: "speed-time-saved", label: "Time saved against the old way", decision: "Whether the tool is worth the change.", source: "none", needs: [], notTelemetry: "Needs a baseline: time the same tasks done the old way in a small study, then compare with the answer times here." },
    ],
  },
  {
    id: "voice",
    title: "Voice and language",
    metrics: [
      { id: "voice-share", label: "Share of questions spoken", decision: "Whether voice is worth keeping and improving.", source: "records", needs: ["input"], by: ["transcript-links"] },
      { id: "voice-edit-rate", label: "Transcripts edited before sending", decision: "Which languages speech to text gets wrong.", source: "records", needs: ["transcript-edits"], by: ["language"] },
      { id: "voice-reask", label: "Typed again after speaking", decision: "Whether voice failures push people back to typing.", source: "records", needs: ["repeats", "input"] },
      { id: "voice-not-sent", label: "Transcripts never sent", decision: "Whether people give up after hearing the transcript.", source: "records", needs: ["voice-not-sent"] },
      { id: "language-mix", label: "Language mix", decision: "Which languages to support well.", source: "records", needs: ["language"] },
      { id: "voice-wer-proxy", label: "Word error rate (estimate from edits)", decision: "Which speech model to use per language.", source: "records", needs: ["transcript-edits", "question-hash"], by: ["speech-cost", "language"] },
      { id: "voice-wer-true", label: "True word error rate", decision: "Which speech model to use per language.", source: "none", needs: [], notTelemetry: "Needs hand-made transcripts of real clips. Keep recordings and export the benchmark manifest to make them." },
    ],
  },
  {
    id: "conversation",
    title: "Conversation",
    metrics: [
      { id: "conv-rephrase", label: "Questions asked again in other words", decision: "Where the first answer misses.", source: "records", needs: ["repeats"] },
      { id: "conv-follow-ups", label: "Follow-ups per conversation", decision: "Whether people explore or ask once and leave.", source: "records", needs: ["conversation"] },
    ],
  },
  {
    id: "trust-reuse",
    title: "Trust and reuse",
    metrics: [
      { id: "trust-explain", label: "How an answer was worked out, opened", decision: "Whether people check where numbers come from.", source: "records", needs: ["explain"] },
      { id: "trust-export-share", label: "Charts exported or boards shared from the chat", decision: "Whether answers travel beyond the person who asked.", source: "records", needs: ["export-share"] },
      { id: "personal-dashboards", label: "Own dashboards made, copied and deleted; saved layouts used", decision: "Whether people make dashboards of their own, and reuse their saved layouts.", source: "records", needs: ["personal-dashboards"] },
      { id: "trust-superset-actions", label: "Exports and shares in Superset on dashboards the assistant built", decision: "Whether dashboards the assistant built get used.", source: "superset-logs", needs: ["superset-actions"] },
      { id: "reuse-hit-rate", label: "Saved answers used, by tier", decision: "How much reuse saves, and whether its tiers are right.", source: "records", needs: ["reuse"] },
      { id: "reuse-saved", label: "Money saved by saved answers", decision: "Whether answer reuse pays for itself.", source: "records", needs: ["reuse"] },
      { id: "review-runs", label: "Daily review runs", decision: "How often answers are checked after the fact.", source: "feature", needs: ["daily-review"] },
      { id: "review-proposals", label: "Daily review proposals", decision: "Which definition changes the review suggests, and which admins accept.", source: "feature", needs: ["daily-review"] },
      { id: "review-open-questions", label: "Open questions (two readings)", decision: "What is waiting on a person to settle.", source: "feature", needs: ["open-questions"] },
    ],
  },
  {
    id: "device-network",
    title: "Device and network",
    metrics: [
      { id: "device-class", label: "Phone, tablet or desktop, and screen width", decision: "Which screens to design for first.", source: "records", needs: ["device-class"] },
      { id: "device-network", label: "Network type and data saver", decision: "How light answers must be for field networks.", source: "records", needs: ["device-network"] },
    ],
  },
];

export const LEGACY_ITEMS: LegacyItem[] = LEGACY_GROUPS.flatMap((g) => g.metrics);
const LEGACY_BY_ID = new Map(LEGACY_ITEMS.map((m) => [m.id, m]));
export const legacyItemById = (id: string) => LEGACY_BY_ID.get(id);

// ---- the switches' values --------------------------------------------------------------------------------------

/** The switches' values: telemetry as a whole, and each field group. */
export type SwitchValues = { telemetry: boolean; fields: Record<string, boolean> };

/** Every field switch at its default: on, except the privacy-sensitive ones. */
export function fieldDefaults(): Record<string, boolean> {
  return Object.fromEntries(FIELD_GROUPS.filter(switchable).map((f) => [f.id, f.default]));
}

/**
 * Why a field group records nothing whatever its switch says, or null: the feature that owns it is off (or not in
 * this version), or it needs voice, which is off.
 */
export function fieldBlock(f: FieldGroup, features: Record<string, boolean>): { kind: "feature" | "voice"; feature: string } | null {
  if (f.feature && !features[f.feature]) return { kind: "feature", feature: f.feature };
  if (f.voice && features.voice === false) return { kind: "voice", feature: "voice" };
  return null;
}

/** The field groups recording now: telemetry on, the group's switch on, and nothing blocking it. */
export function fieldsOn(sw: SwitchValues, features: Record<string, boolean> = {}): Set<string> {
  const on = new Set<string>();
  if (!sw.telemetry) return on;
  for (const f of FIELD_GROUPS) {
    if (!switchable(f) || fieldBlock(f, features)) continue;
    if (sw.fields[f.id] ?? f.default) on.add(f.id);
  }
  return on;
}

/** The fields a record of one kind keeps with these groups on: the core ones, and each on group's. */
export function keptFields(kind: keyof typeof CORE_FIELDS, on: ReadonlySet<string>): Set<string> {
  const out = new Set<string>(CORE_FIELDS[kind]);
  for (const id of on) for (const f of FIELD_BY_ID.get(id)?.[kind] ?? []) out.add(f as string);
  return out;
}

/** A record with only the fields its on groups need: a switched-off group's fields are left out, not nulled. */
export function onlyKept<T extends object>(kind: keyof typeof CORE_FIELDS, line: T, on: ReadonlySet<string>): Partial<T> {
  const keep = keptFields(kind, on);
  return Object.fromEntries(Object.entries(line).filter(([k]) => keep.has(k))) as Partial<T>;
}

/** The field group that keeps a client event (by type, and stage for an abandoned transcript), if any. */
export function fieldForEvent(type: string, stage?: string | null): FieldGroup | undefined {
  const key = type === "abandoned" && stage === "after-transcription" ? "abandoned:after-transcription" : type;
  return FIELD_GROUPS.find((f) => f.events?.includes(key));
}

/** The field group a record's field belongs to (turn.user is the user name's), or undefined for a field every record keeps. */
export function fieldOfRecord(kind: "turn" | "transcript" | "event", name: string): FieldGroup | undefined {
  return FIELD_GROUPS.find((f) => (f[kind] as readonly string[] | undefined)?.includes(name));
}

/** Every client event type some field group keeps. */
export const EVENT_TYPES = [...new Set(FIELD_GROUPS.flatMap((f) => f.events ?? []).map((e) => e.split(":")[0]!))];

/** Whether a record carries a field group: one of its fields for the record's kind, or for an event, an event it keeps. */
export function carries(l: TelemetryLine, f: FieldGroup): boolean {
  if (l.type === "event" && f.events?.length) return f.events.some((e) => (e === "abandoned:after-transcription" ? l.event === "abandoned" && l.stage === "after-transcription" : e === l.event && !(e === "abandoned" && l.stage === "after-transcription")));
  const fields = (f[l.type] ?? []) as string[];
  return fields.some((k) => k in l && (l as Record<string, unknown>)[k] !== undefined);
}

// ---- the older names: metric and section switches, read as field switches ---------------------------------------

/**
 * Before field switches, a deployment switched metrics (telemetry.items.<metric>) and sections of them
 * (telemetry.groups.<section>), and a field was kept while some metric that was on needed it. The same rule reads
 * the older values now: a field group is on when some metric that is on (with its section on) needs it. The five
 * privacy-sensitive items had the ids their field groups have now, so items.question-text is fields.question-text.
 */
export const LEGACY_SECTIONS: { id: string; items: string[] }[] = LEGACY_GROUPS.map((g) => ({
  id: g.id,
  items: [...g.metrics.filter((m) => !m.notTelemetry && m.source !== "feature").map((m) => m.id), ...(g.id === "asks" ? ["question-text"] : g.id === "voice" ? ["transcript-text", "voice-audio"] : [])],
}));
const LEGACY_SECTION_OF = new Map(LEGACY_SECTIONS.flatMap((s) => s.items.map((i) => [i, s.id] as const)));
/** Whether a name is one of the older item switches. */
export const isLegacyItem = (id: string) => LEGACY_SECTION_OF.has(id);
export const isLegacySection = (id: string) => LEGACY_SECTIONS.some((s) => s.id === id);
/** The field groups an older item switch stood for. */
export function legacyNeeds(item: string): string[] {
  const m = legacyItemById(item);
  if (m && !fieldById(item)) return [...m.needs, ...(m.by ?? [])];
  return fieldById(item) ? [item] : [];
}
const legacyDefault = (item: string) => legacyNeeds(item).every((f) => fieldById(f)?.default ?? true);

export type LegacySwitches = { groups?: Record<string, boolean>; items?: Record<string, boolean> };

/** The field switches older item and section values stand for: on when some item that is on needs it. */
export function fieldsFromLegacy(l: LegacySwitches): Record<string, boolean> {
  const on = new Set<string>();
  for (const s of LEGACY_SECTIONS) {
    if (l.groups?.[s.id] === false) continue;
    for (const i of s.items) if (l.items?.[i] ?? legacyDefault(i)) for (const f of legacyNeeds(i)) on.add(f);
  }
  return Object.fromEntries(FIELD_GROUPS.filter(switchable).map((f) => [f.id, on.has(f.id)]));
}

/**
 * What older values change against a base: the field switches that come out different. With an empty base this is
 * what a config's telemetry.items and telemetry.groups say against the catalogue; with the deployment's older values
 * as the base, what an admin's saved older values changed on top of them.
 */
export function legacyChanges(base: LegacySwitches, over: LegacySwitches): Record<string, boolean> {
  if (!Object.keys(over.groups ?? {}).length && !Object.keys(over.items ?? {}).length) return {};
  const before = fieldsFromLegacy(base);
  const after = fieldsFromLegacy({ groups: { ...base.groups, ...over.groups }, items: { ...base.items, ...over.items } });
  return Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k] !== v));
}

/** One layer of switch values: the newer field switches, and the older names. */
export type SwitchLayer = LegacySwitches & { fields?: Record<string, boolean> };

/**
 * The field switches as they stand, from the catalogue up: the deployment's older names, its field switches, then an
 * admin's saved older names and saved field switches. A field switch always wins over an older name in its layer.
 */
export function resolveFields(deployment: SwitchLayer, saved: SwitchLayer = {}): { deployment: Record<string, boolean>; values: Record<string, boolean> } {
  const dep = { ...fieldDefaults(), ...legacyChanges({}, deployment), ...deployment.fields };
  const values = { ...dep, ...legacyChanges({ groups: deployment.groups, items: deployment.items }, saved), ...saved.fields };
  return { deployment: dep, values };
}

// ---- locks and categories --------------------------------------------------------------------------------------

/** Why a field group's switch cannot be changed here, or null. */
export type FieldLock =
  | { kind: "owned"; feature: string }
  | { kind: "feature"; feature: string; missing: boolean }
  | { kind: "voice"; feature: "voice" }
  | { kind: "needs-config"; context: ContextField[] }
  | { kind: "superset" };

/** What locks a switch: a feature that keeps it outright, a feature (or voice) that is off, or configuration it needs first. */
export type LockInput = {
  /** The deployment's feature switches by name (absent: not in this version). */
  features: Record<string, boolean>;
  /** Which context fields the deployment maps (any board, dataset or role). */
  mapped: ReadonlySet<ContextField>;
  /** Whether this host can read Superset's action log (it runs inside Superset). */
  superset: boolean;
};

export function fieldLock(f: FieldGroup, i: LockInput): FieldLock | null {
  if (f.owned) return { kind: "owned", feature: f.feature! };
  if (f.feature && !i.features[f.feature]) return { kind: "feature", feature: f.feature, missing: !(f.feature in i.features) };
  if (f.voice && i.features.voice === false) return { kind: "voice", feature: "voice" };
  if (f.context?.length && !f.context.some((c) => i.mapped.has(c))) return { kind: "needs-config", context: f.context };
  if (f.source === "superset-logs" && !i.superset) return { kind: "superset" };
  return null;
}

export type CategoryState = "on" | "off" | "mixed";

/**
 * A category's switch, worked out from the switches inside it that can be changed here; it holds no value of its
 * own. Off when all of them are off. On when all of them are on, or when every one that is not privacy-sensitive is
 * on (a category switch never turns a sensitive one on, so "on" means all it can turn on is on). Mixed otherwise.
 * next is what switching it does (true: every switch that is not sensitive on; false: every switch off), or null
 * when it can do nothing (a category of sensitive switches that are all off).
 */
export function categoryState(rows: { on: boolean; sensitive: boolean; editable: boolean }[]): { state: CategoryState; next: boolean | null } {
  const editable = rows.filter((r) => r.editable);
  // With nothing to change here (every switch locked), it shows the locked switches as they stand, and does nothing.
  const e = editable.length ? editable : rows;
  const plain = e.filter((r) => !r.sensitive);
  const state: CategoryState = e.every((r) => !r.on) ? "off" : e.every((r) => r.on) || (plain.length > 0 && plain.every((r) => r.on)) ? "on" : "mixed";
  if (!editable.length) return { state, next: null };
  const next = state === "on" ? false : plain.length ? true : state === "mixed" ? false : null;
  return { state, next };
}

/** The field changes a category switch makes: on turns on every editable switch that is not sensitive; off turns every editable one off. */
export function categoryChanges(categoryId: string, to: boolean, editable: (f: FieldGroup) => boolean): string[] {
  const c = FIELD_CATEGORIES.find((x) => x.id === categoryId);
  if (!c) return [];
  return c.fields.filter((f) => switchable(f) && editable(f) && (!to || !f.sensitive)).map((f) => f.id);
}

/** The switches as a config block: telemetry.fields, every key with its default, by category. */
export function switchesYaml(): string {
  const d = fieldDefaults();
  const lines = ["telemetry:", "  fields:"];
  for (const c of FIELD_CATEGORIES) {
    const own = c.fields.filter(switchable);
    if (!own.length) continue;
    lines.push(`    # ${c.title}`);
    for (const f of own) lines.push(`    ${f.id}: ${d[f.id]}${f.sensitive ? "   # privacy-sensitive: confirm to turn on" : ""}`);
  }
  return lines.join("\n");
}
