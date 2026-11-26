import type { ContextField, DeploymentContext } from "@lenspack/policy";

import type { TelemetryLine } from "./telemetry";

// What usage telemetry records for one deployment, as a checklist for the admin console: one item per measure the
// pilot is judged on, grouped as the pilot's metrics are, each saying whether it is being recorded, what it needs
// if not, which record fields it reads, and what it means for privacy. A pure function of the deployment's switches
// and context and the last 7 days of records; the host gathers those and serves the result.

export type ChecklistSource = "turn-record" | "client-event" | "transcript" | "audio" | "superset-logs" | "config";
export type ChecklistStatus = "recording" | "enabled-no-data" | "off" | "needs-config" | "not-telemetry";

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
  /** The feature that owns this measure, when it is not telemetry's own. */
  feature?: string;
};

export type Checklist = {
  generatedAt: string;
  switches: { telemetry: boolean; questionText: boolean; keepAudio: boolean; audioRetentionDays: number; retentionDays: number; consentNotice: boolean };
  groups: { title: string; items: ChecklistItem[] }[];
};

export type ChecklistInput = {
  now: Date;
  switches: Checklist["switches"];
  /** The deployment's feature switches by name (absent: not in this version). */
  features: Record<string, boolean>;
  context: DeploymentContext;
  /** The last 7 days of telemetry records. */
  lines: TelemetryLine[];
  /** When kept recordings were saved, the last 7 days. */
  audioSaved: string[];
  /** Superset's action log, when the host is Superset: whether it can be read, and the exports and shares seen there. */
  supersetLogs?: { available: boolean; reason?: string; count: number; lastSeen: string | null } | null;
};

type Def = {
  id: string;
  label: string;
  decision: string;
  source: ChecklistSource;
  fields: string[];
  privacy?: (i: ChecklistInput) => string[];
  /** Which records show it is being recorded. */
  seen?: (l: TelemetryLine) => boolean;
  /** A switch besides telemetry's own that must be on. */
  needs?: "voice" | "keepAudio";
  /** Context fields it reads: with none mapped, it needs configuring. */
  context?: ContextField[];
  roles?: boolean;
  feature?: string;
  /** Why it cannot be telemetry. */
  notTelemetry?: string;
};

const turn = (p: (l: Extract<TelemetryLine, { type: "turn" }>) => boolean = () => true) => (l: TelemetryLine) => l.type === "turn" && p(l);
const event = (...names: string[]) => (l: TelemetryLine) => l.type === "event" && names.includes(l.event);
const names = ["usernames visible to admins with the usage right"];
const text = (i: ChecklistInput) => (i.switches.questionText ? ["stores question text"] : ["question text kept only as a keyed hash"]);

const GROUPS: { title: string; items: Def[] }[] = [
  {
    title: "Users",
    items: [
      { id: "users-active", label: "Daily and weekly active users", decision: "Is the pilot reaching people, and is use growing?", source: "turn-record", fields: ["user", "at"], privacy: () => names, seen: turn() },
      { id: "users-by-role", label: "Active users by role", decision: "Which roles use it, and who needs training or a different entry point?", source: "turn-record", fields: ["user", "roles"], privacy: () => names, seen: turn(), roles: true },
      { id: "users-by-country", label: "Active users by country", decision: "Where to put support and the next rollout.", source: "turn-record", fields: ["user", "country"], privacy: () => names, seen: turn(), context: ["country"] },
      { id: "users-return", label: "Users who come back next campaign", decision: "Does it keep its users from one campaign to the next?", source: "turn-record", fields: ["user", "campaign", "at"], privacy: () => names, seen: turn(), context: ["campaign"] },
    ],
  },
  {
    title: "Volume and cost",
    items: [
      { id: "volume-per-user", label: "Questions per user", decision: "How much each person leans on it; sizing and budgets.", source: "turn-record", fields: ["user", "turnId"], seen: turn() },
      { id: "cost-per-question", label: "Cost per question (model, voice, review)", decision: "Which model to run, and whether the review step pays for itself.", source: "turn-record", fields: ["costUsd", "modelUsd", "speechUsd", "reviewUsd", "tokensIn", "tokensOut", "models"], seen: turn() },
      { id: "cost-per-user", label: "Cost per user", decision: "The budget per supervisor for a campaign.", source: "turn-record", fields: ["user", "costUsd"], seen: turn() },
      { id: "cost-voice", label: "Speech to text cost", decision: "Whether voice is affordable at campaign scale.", source: "transcript", fields: ["usd", "seconds", "model"], seen: (l) => l.type === "transcript", needs: "voice" },
    ],
  },
  {
    title: "Quality",
    items: [
      { id: "quality-answer-rate", label: "Answer rate by campaign type and language", decision: "Where the pack or the model falls short.", source: "turn-record", fields: ["outcome", "outcomeReason", "campaignType", "questionLanguage"], seen: turn(), context: ["campaignType"] },
      { id: "quality-unanswered", label: "Top unanswered questions", decision: "What to add to the pack next.", source: "turn-record", fields: ["outcome", "question", "questionHash"], privacy: text, seen: turn((l) => l.outcome !== "answered") },
      { id: "quality-thumbs-down", label: "Thumbs down and their reasons", decision: "Which answers people do not trust, and why.", source: "client-event", fields: ["rating", "reason", "comment"], privacy: (i) => (i.switches.questionText ? ["stores feedback comments"] : ["feedback comments kept only as a keyed hash"]), seen: event("feedback") },
      { id: "quality-clarify", label: "Clarifying questions: answered or dropped", decision: "Whether asking back helps or loses people.", source: "turn-record", fields: ["outcome", "sessionId"], seen: turn((l) => l.outcome === "clarify") },
    ],
  },
  {
    title: "What people ask",
    items: [
      { id: "asks-top-by-role", label: "Top 10 questions by role", decision: "What to put on dashboards and in suggested questions.", source: "turn-record", fields: ["questionHash", "question", "roles"], privacy: text, seen: turn(), roles: true },
      { id: "asks-repeated-direct", label: "Repeated direct questions", decision: "Which numbers deserve a chart instead of a question.", source: "turn-record", fields: ["kind", "questionHash"], seen: turn((l) => l.kind === "direct") },
      { id: "asks-repeated-derived", label: "Repeated derived questions", decision: "Which rates or comparisons to add as measures.", source: "turn-record", fields: ["kind", "questionHash", "computeSteps"], seen: turn((l) => l.kind === "derived") },
      { id: "asks-mix", label: "Mix of direct, derived and chart questions", decision: "Whether people use it to ask or to build.", source: "turn-record", fields: ["kind"], seen: turn() },
    ],
  },
  {
    title: "Speed",
    items: [
      { id: "speed-p95", label: "Slowest answers (95th percentile) by kind", decision: "Whether answers are fast enough on field networks.", source: "turn-record", fields: ["totalMs", "firstTokenMs", "kind"], seen: turn() },
      { id: "speed-abandoned", label: "Answers left before they finished", decision: "Where waiting loses people.", source: "turn-record", fields: ["abandoned", "abandonedMs"], seen: (l) => (l.type === "turn" && l.abandoned) || (l.type === "event" && l.event === "abandoned" && l.stage !== "after-transcription") },
      { id: "speed-queue", label: "Time waiting for a free slot", decision: "When to add capacity at campaign peaks.", source: "turn-record", fields: ["queueMs"], feature: "queue" },
      { id: "speed-time-saved", label: "Time saved against the old way", decision: "Whether the tool is worth the change.", source: "config", fields: [], notTelemetry: "Needs a baseline: time the same tasks done the old way in a small study, then compare with totalMs here." },
    ],
  },
  {
    title: "Voice and language",
    items: [
      { id: "voice-share", label: "Share of questions spoken", decision: "Whether voice is worth keeping and improving.", source: "turn-record", fields: ["input"], seen: turn((l) => l.input === "spoken"), needs: "voice" },
      { id: "voice-edit-rate", label: "Transcripts edited before sending", decision: "Which languages speech to text gets wrong.", source: "turn-record", fields: ["transcriptEditDistance", "transcriptId", "questionWords"], privacy: text, seen: turn((l) => l.transcriptEditDistance !== null), needs: "voice" },
      { id: "voice-reask", label: "Typed again after speaking", decision: "Whether voice failures push people back to typing.", source: "turn-record", fields: ["reAskAfterVoice"], seen: turn((l) => l.reAskAfterVoice !== null), needs: "voice" },
      { id: "voice-not-sent", label: "Transcripts never sent", decision: "Whether people give up after hearing the transcript.", source: "client-event", fields: ["event", "stage", "transcriptId"], seen: (l) => l.type === "event" && l.event === "abandoned" && l.stage === "after-transcription", needs: "voice" },
      { id: "language-mix", label: "Language mix", decision: "Which languages to support well.", source: "turn-record", fields: ["questionLanguage", "replyLanguage", "languagePicked"], seen: turn() },
      { id: "voice-wer-proxy", label: "Word error rate (estimate from edits)", decision: "Which speech model to use per language.", source: "transcript", fields: ["transcriptEditDistance", "words"], seen: turn((l) => l.transcriptEditDistance !== null), needs: "voice" },
      { id: "voice-wer-true", label: "True word error rate", decision: "Which speech model to use per language.", source: "config", fields: [], notTelemetry: "Needs hand-made transcripts of real clips. Keep recordings and export the benchmark manifest to make them." },
      { id: "voice-audio", label: "Kept recordings", decision: "Material for checking speech models on real field audio.", source: "audio", fields: ["audio"], privacy: () => ["stores audio"], needs: "keepAudio" },
    ],
  },
  {
    title: "Conversation",
    items: [
      { id: "conv-rephrase", label: "Questions asked again in other words", decision: "Where the first answer misses.", source: "turn-record", fields: ["rephraseOf"], seen: turn((l) => l.rephraseOf !== null) },
      { id: "conv-follow-ups", label: "Follow-ups per conversation", decision: "Whether people explore or ask once and leave.", source: "turn-record", fields: ["sessionId"], seen: turn() },
    ],
  },
  {
    title: "Trust and reuse",
    items: [
      { id: "trust-explain", label: "How an answer was worked out, opened", decision: "Whether people check where numbers come from.", source: "client-event", fields: ["event", "turnId"], seen: event("explain-opened") },
      { id: "trust-export-share", label: "Charts exported or boards shared in Lenspack", decision: "Whether answers travel beyond the person who asked.", source: "client-event", fields: ["event", "choice"], seen: event("chart-exported", "board-shared") },
      { id: "trust-superset-actions", label: "Exports and shares in Superset on Lenspack's dashboards", decision: "Whether dashboards Lenspack built get used.", source: "superset-logs", fields: ["dashboard", "event", "user"], privacy: () => names },
      { id: "reuse-hit-rate", label: "Saved answers used, by tier", decision: "How much reuse saves, and whether its tiers are right.", source: "turn-record", fields: ["reuse"], seen: turn((l) => l.reuse !== null), feature: "reuse" },
      { id: "reuse-saved", label: "Money saved by saved answers", decision: "Whether answer reuse pays for itself.", source: "turn-record", fields: ["reuse", "costUsd"], seen: turn((l) => l.reuse !== null), feature: "reuse" },
      { id: "review-runs", label: "Review runs", decision: "How often answers are checked after the fact.", source: "client-event", fields: ["event"], seen: event("review-run"), feature: "review" },
      { id: "review-proposals", label: "Review proposals", decision: "Which pack changes reviewers suggest.", source: "client-event", fields: ["event"], seen: event("review-proposal"), feature: "review" },
      { id: "review-open-questions", label: "Open review questions", decision: "What is waiting on a person.", source: "client-event", fields: ["event"], seen: event("review-open-question"), feature: "review" },
    ],
  },
  {
    title: "Device and network",
    items: [
      { id: "device-class", label: "Phone, tablet or desktop, and screen width", decision: "Which screens to design for first.", source: "turn-record", fields: ["device", "viewport"], seen: turn((l) => l.device !== null || l.viewport !== null) },
      { id: "device-network", label: "Network type and data saver", decision: "How light answers must be for field networks.", source: "turn-record", fields: ["network", "saveData"], seen: turn((l) => l.network !== null) },
    ],
  },
];

const ON = { voice: "Turn on the voice switch and set a speech key.", keepAudio: "Turn on speech.keepAudio (settings page, config or LENSPACK_SPEECH_KEEP_AUDIO); set a consent notice if users must agree." };

/** One item's status: why it can't be telemetry, the switch or setting it needs, or whether records show it. */
function itemFor(d: Def, i: ChecklistInput): ChecklistItem {
  const base = { id: d.id, label: d.label, decision: d.decision, source: d.source, fields: d.fields, privacy: d.privacy?.(i) ?? [], ...(d.feature ? { feature: d.feature } : {}) };
  const done = (status: ChecklistStatus, howToEnable: string | null, count7d: number | null = null, lastSeen: string | null = null): ChecklistItem => ({ ...base, status, howToEnable, count7d, lastSeen });
  if (d.notTelemetry) return done("not-telemetry", d.notTelemetry);
  if (d.feature && !(d.feature in i.features)) return done("off", `Comes with the ${d.feature} feature, which this version does not have.`);
  if (d.feature && !i.features[d.feature]) return done("off", `Turn on the ${d.feature} switch.`);
  if (!i.switches.telemetry) return done("off", "Turn on the telemetry switch (settings page, features: in the config, or LENSPACK_FEATURES).");
  if (d.needs === "voice" && i.features.voice === false) return done("off", ON.voice);
  if (d.needs === "keepAudio") {
    if (!i.switches.keepAudio) return done("off", ON.keepAudio);
    const last = [...i.audioSaved].sort().at(-1) ?? null;
    return done(i.audioSaved.length ? "recording" : "enabled-no-data", i.audioSaved.length ? null : "Recordings are kept from the next spoken question.", i.audioSaved.length, last);
  }
  if (d.source === "superset-logs") {
    const s = i.supersetLogs;
    if (!s) return done("needs-config", "Only when Lenspack runs inside Superset, which keeps the action log.");
    if (!s.available) return done("needs-config", s.reason ?? "Lenspack's Superset account cannot read the action log (/api/v1/log/); it needs the can read on Log permission.");
    return done(s.count ? "recording" : "enabled-no-data", s.count ? null : "Nothing exported or shared in the last 7 days.", s.count, s.lastSeen);
  }
  const missing = (d.context ?? []).filter((f) => !Object.values(i.context).some((e) => e[f]));
  if (missing.length) return done("needs-config", `Map boards, datasets or roles to a ${missing.join(" and ")} in the deployment's context (context: in the config).`);
  const seen = d.seen ? i.lines.filter(d.seen) : [];
  const lastSeen = seen.reduce<string | null>((m, l) => (m === null || l.at > m ? l.at : m), null);
  // Role names come from the host's signed identity; turns all without them mean an older plugin that does not send them.
  if (d.roles) {
    const ts = i.lines.filter((l) => l.type === "turn");
    if (ts.length && ts.every((l) => !l.roles.length)) return done("needs-config", "Update the Superset plugin: this one does not sign the user's role names.", seen.length, lastSeen);
  }
  return seen.length ? done("recording", null, seen.length, lastSeen) : done("enabled-no-data", "On; nothing recorded in the last 7 days.", 0, null);
}

export function telemetryChecklist(i: ChecklistInput): Checklist {
  return { generatedAt: i.now.toISOString(), switches: i.switches, groups: GROUPS.map((g) => ({ title: g.title, items: g.items.map((d) => itemFor(d, i)) })) };
}
