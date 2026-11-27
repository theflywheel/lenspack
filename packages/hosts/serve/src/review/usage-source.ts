import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { fieldForEvent, fieldOfRecord } from "@lenspack/agent";
import type { Connector } from "@lenspack/engine";
import type { Pack } from "@lenspack/pack";

import type { AuditEvent } from "../audit";

/** The usage pack's host name: /api/usage/<board> inside the panel, and the pack a usage chat turn names. */
export const USAGE_HOST = "usage";

// The usage source: an adapter that turns this server's own record of its chat turns into tables a pack can
// read, the way the SQL and Elasticsearch adapters turn a database into them. The record is the turn
// telemetry (telemetry*.jsonl in the state directory, one line per turn plus events such as thumbs) when the
// server writes it, and otherwise the audit log's chat-turn lines, which carry less. The tables live in an
// in-process DuckDB database, read again from the record at most every so often (on the next query after
// that). What the adapter gives is an ordinary Connector and board store; the pack and its boards are plain
// files (packs/usage), so the usage board is assembled like any other.
//
// Each column says which record field it is read from (COLUMNS below). A record leaves out the fields whose
// telemetry switch is off, so a column read from one is empty or a default while it is off; keyFields finds, for
// each key of the pack, the field groups its columns come from, so the host can say the key is unavailable then
// rather than let a board draw a wrong figure.

export type UsageRow = {
  id: string;
  chat_session: string | null;
  at: string;
  hour: number;
  /** null when the record carries no user name (that field switched off). */
  user_name: string | null;
  board: string | null;
  pack: string | null;
  datasets: string | null;
  campaign: string | null;
  campaign_type: string | null;
  country: string | null;
  model: string | null;
  language: string;
  input: "typed" | "spoken";
  kind: "answer" | "edit";
  answer_kind: "direct" | "derived" | "chart" | "meta";
  outcome: "answered" | "declined" | "failed" | "clarify";
  cache_tier: string | null;
  question: string;
  /** A keyed hash of the question: the same question, asked again, has the same one. */
  question_hash: string | null;
  question_words: number | null;
  outcome_reason: string | null;
  device: string | null;
  network: string | null;
  usd: number;
  model_usd: number;
  review_usd: number;
  speech_usd: number;
  tokens_in: number;
  tokens_out: number;
  saved_usd: number;
  refused: number;
  reviewed: number;
  material: number;
  fix_round: number;
  logged: number;
  cache_hit: number;
  rephrase: number;
  reask_voice: number;
  reply_s: number | null;
  first_token_s: number | null;
  speech_s: number | null;
  /** The reader left before the answer finished. */
  abandoned: number;
  /** Seconds waited for a free slot before the turn started, and whether it waited at all. */
  queue_s: number | null;
  waited: number;
  /** Words changed in the transcript before a spoken question was sent, and whether any were. */
  transcript_edits: number | null;
  edited: number;
  internal: number;
};
export type TranscriptRow = { transcript_id: string; at: string; user_name: string | null; model: string | null; language: string | null; seconds: number | null; usd: number; ms: number | null; words: number | null };
export type EventRow = { turn_id: string | null; event: string; value: string | null; reason: string | null; stage: string | null; at: string; user_name: string | null };
export type UsageTables = {
  turns: UsageRow[];
  features: { turn_id: string; feature: string; at: string }[];
  roles: { turn_id: string; role: string; user_name: string | null; at: string }[];
  events: EventRow[];
  transcripts: TranscriptRow[];
};
const emptyTables = (): UsageTables => ({ turns: [], features: [], roles: [], events: [], transcripts: [] });

const EDIT_TOOLS = /^(add_widget|update_widget|move_widget|resize_widget|remove_widget|add_filter|update_filter|remove_filter|set_layout_mode|rename_board|restore_version)$/;
const tidy = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const secs = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms / 100) / 10 : null);
const flag = (v: unknown) => (v ? 1 : 0);

// --- from the audit log (what every server writes) -------------------------

type AuditDetail = {
  instruction?: string;
  answer?: string;
  builder?: string;
  models?: string[];
  calls?: { tool?: string; input?: Record<string, unknown>; ok?: boolean; error?: string }[];
  refusals?: string[];
  reviews?: { round?: number; findings?: { severity?: string }[]; reading?: unknown }[];
  review?: { satisfied?: boolean };
  outcome?: string;
  saved?: string[];
  costUsd?: number;
  sttUsd?: number;
  tokens?: { in?: number; out?: number };
  cost?: { total?: { usd?: number; inputTokens?: number; outputTokens?: number }; models?: { role?: string; usd?: number }[] };
  language?: string;
  ms?: number;
  clarify?: { asked?: boolean };
  quickReply?: unknown;
  /** Written by an answer cache when it answered the turn. */
  cache?: { tier?: string; savedUsd?: number };
};

/** chat-turn audit events → the usage tables. The audit log has no sessions, roles, countries, events or client details. */
export function usageFromAudit(events: AuditEvent[]): UsageTables {
  const t = emptyTables();
  for (const [i, e] of events.entries()) {
    if (e.action !== "chat-turn" || !e.detail) continue;
    let d: AuditDetail;
    try {
      d = JSON.parse(e.detail) as AuditDetail;
    } catch {
      continue;
    }
    const id = `a${i}`;
    const calls = d.calls ?? [];
    const edited = (d.saved?.length ?? 0) > 0 || d.outcome === "saved" || (!d.saved && !d.outcome && calls.some((c) => EDIT_TOOLS.test(c.tool ?? "") && c.ok === true));
    const spoken = (d.sttUsd ?? 0) > 0;
    const declined = /declined to answer/.test(d.answer ?? "");
    const failed = !d.answer || d.outcome === "not saved" || (calls.length > 0 && calls.every((c) => !!c.error));
    const reviews = d.reviews ?? [];
    const tier = d.cache?.tier ? String(d.cache.tier) : null;
    const inputs = calls.map((c) => c.input ?? {});
    const derived = inputs.some((q) => typeof q.compute === "string" && q.compute);
    const queried = calls.some((c) => /^(query|run_query|add_widget|update_widget)$/.test(c.tool ?? ""));
    const byRole = (role: string) => (d.cost?.models ?? []).filter((m) => m.role === role).reduce((s, m) => s + num(m.usd), 0);
    const usd = d.costUsd ?? d.cost?.total?.usd ?? 0;
    const row: UsageRow = {
      id,
      chat_session: null,
      at: e.at,
      hour: new Date(e.at).getUTCHours(),
      user_name: e.user,
      board: e.board ?? null,
      pack: e.pack ?? null,
      datasets: null,
      campaign: null,
      campaign_type: null,
      country: null,
      model: d.models?.[0] ?? d.builder ?? null,
      language: d.language ?? "auto",
      input: spoken ? "spoken" : "typed",
      kind: edited ? "edit" : "answer",
      answer_kind: edited ? "chart" : derived ? "derived" : queried ? "direct" : "meta",
      outcome: d.clarify?.asked ? "clarify" : declined ? "declined" : failed ? "failed" : "answered",
      cache_tier: tier,
      question: tidy(d.instruction, 200),
      question_hash: null,
      question_words: null,
      outcome_reason: null,
      device: null,
      network: null,
      usd,
      model_usd: Math.max(0, usd - byRole("review") - (d.sttUsd ?? 0)),
      review_usd: byRole("review"),
      speech_usd: d.sttUsd ?? 0,
      tokens_in: d.tokens?.in ?? d.cost?.total?.inputTokens ?? 0,
      tokens_out: d.tokens?.out ?? d.cost?.total?.outputTokens ?? 0,
      saved_usd: num(d.cache?.savedUsd),
      refused: flag((d.refusals?.length ?? 0) > 0),
      reviewed: flag(reviews.length || d.review),
      material: reviews.reduce((n, r) => n + (r.findings ?? []).filter((f) => f.severity === "material").length, 0) + (d.review && d.review.satisfied === false ? 1 : 0),
      fix_round: flag(reviews.some((r) => r.round === 2)),
      logged: flag(d.clarify || reviews.some((r) => r.reading)),
      cache_hit: flag(tier && tier !== "miss"),
      rephrase: 0,
      reask_voice: 0,
      reply_s: secs(d.ms),
      first_token_s: null,
      speech_s: null,
      abandoned: 0,
      queue_s: null,
      waited: 0,
      transcript_edits: null,
      edited: 0,
      internal: flag(e.internal),
    };
    t.turns.push(row);
    const used = new Set<string>();
    if (spoken) used.add("voice");
    if (edited) used.add("board edit");
    if (row.reviewed) used.add("reviewer");
    if (row.fix_round) used.add("fix round");
    if (d.clarify) used.add("clarify");
    if (d.quickReply) {
      used.add("quick reply");
      t.events.push({ turn_id: id, event: "quick-reply", value: "chosen", reason: null, stage: null, at: e.at, user_name: e.user });
    }
    if (row.cache_hit) used.add("saved answer");
    if (derived) used.add("compute");
    if (inputs.some((q) => q.query_kind === "points" || q.chart === "map")) used.add("map");
    if (inputs.some((q) => q.chart === "heatmap")) used.add("heatmap");
    if (!used.size) used.add("question");
    for (const f of used) t.features.push({ turn_id: id, feature: f, at: e.at });
  }
  return t;
}

// --- from the turn telemetry (telemetry*.jsonl), when the server writes it --

/**
 * One line of telemetry: a turn, or an event on one (keyed by turnId). Every field is optional here,
 * so a line from an older or newer writer still reads.
 */
export type TelemetryLine = {
  type?: string;
  event?: string;
  turnId?: string;
  sessionId?: string;
  at?: string;
  user?: string;
  roles?: string[];
  board?: string;
  pack?: string;
  datasets?: string[] | string;
  campaign?: string | null;
  campaignType?: string | null;
  country?: string | null;
  language?: string;
  input?: "typed" | "spoken";
  question?: string;
  kind?: "direct" | "derived" | "chart" | "meta";
  outcome?: "answered" | "declined" | "failed" | "clarify";
  firstTokenMs?: number;
  totalMs?: number;
  costUsd?: number | { total?: number; model?: number; speech?: number; review?: number };
  cost?: { model?: number; speech?: number; review?: number };
  tokens?: { in?: number; out?: number };
  models?: string[];
  review?: { ran?: boolean; material?: number | boolean; fixRound?: boolean };
  reuse?: string | { tier?: string | number; savedUsd?: number } | null;
  rephraseOf?: string | null;
  reAskAfterVoice?: boolean | string | null;
  client?: { device?: string; network?: string; viewport?: string };
  // The turn record as @lenspack/agent writes it (docs/features/telemetry.md): flat fields.
  questionLanguage?: string | null;
  replyLanguage?: string | null;
  device?: string | null;
  network?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  modelUsd?: number;
  speechUsd?: number;
  reviewUsd?: number;
  reviewRan?: boolean;
  reviewMaterial?: number;
  fixRound?: boolean;
  queueMs?: number | null;
  speechSeconds?: number;
  saved?: boolean;
  internal?: boolean;
  questionHash?: string;
  questionWords?: number;
  outcomeReason?: string | null;
  abandoned?: boolean;
  transcriptEditDistance?: number | null;
  reuseSavedUsd?: number | null;
  // transcripts
  transcriptId?: string;
  model?: string;
  languageDetected?: string | null;
  seconds?: number | null;
  usd?: number | null;
  ms?: number;
  words?: number;
  // events
  how?: string | null;
  stage?: string | null;
  thumbs?: "up" | "down";
  rating?: "up" | "down" | null;
  value?: string;
  reason?: string;
  choice?: string;
};

const isTurn = (l: TelemetryLine) => (l.type ? l.type === "turn" : !l.event && typeof l.question === "string");

/** Telemetry lines → the usage tables. Events whose turn is not in the window, or that are about no turn, are kept, unjoined. */
export function usageFromTelemetry(lines: TelemetryLine[]): UsageTables {
  const t = emptyTables();
  for (const l of lines) {
    if (!l.at) continue;
    if (l.type === "transcript") {
      if (!l.transcriptId) continue;
      t.transcripts.push({ transcript_id: l.transcriptId, at: l.at, user_name: str(l.user), model: str(l.model), language: str(l.languageDetected), seconds: typeof l.seconds === "number" ? l.seconds : null, usd: num(l.usd), ms: typeof l.ms === "number" ? l.ms : null, words: typeof l.words === "number" ? l.words : null });
      continue;
    }
    if (isTurn(l)) {
      if (!l.turnId) continue;
      const total = typeof l.costUsd === "object" && l.costUsd ? l.costUsd : { total: l.costUsd, model: l.modelUsd, speech: l.speechUsd, review: l.reviewUsd, ...l.cost };
      const review = l.review ?? { ran: l.reviewRan, material: l.reviewMaterial, fixRound: l.fixRound };
      const tier = typeof l.reuse === "string" ? l.reuse : l.reuse?.tier !== undefined ? String(l.reuse.tier) : null;
      const kind = l.kind ?? "direct";
      const row: UsageRow = {
        id: l.turnId,
        chat_session: str(l.sessionId),
        at: l.at,
        hour: new Date(l.at).getUTCHours(),
        user_name: str(l.user),
        board: str(l.board),
        pack: str(l.pack),
        datasets: Array.isArray(l.datasets) ? l.datasets.join(", ").slice(0, 200) || null : str(l.datasets),
        campaign: str(l.campaign),
        campaign_type: str(l.campaignType),
        country: str(l.country),
        model: l.models?.[0] ?? null,
        language: l.language ?? l.questionLanguage ?? "auto",
        input: l.input === "spoken" ? "spoken" : "typed",
        kind: l.saved || kind === "chart" ? "edit" : "answer",
        answer_kind: kind,
        outcome: l.outcome ?? "answered",
        cache_tier: tier && tier !== "miss" ? tier : null,
        question: tidy(l.question, 200),
        question_hash: str(l.questionHash),
        question_words: typeof l.questionWords === "number" ? l.questionWords : null,
        outcome_reason: str(l.outcomeReason),
        device: str(l.client?.device ?? l.device),
        network: str(l.client?.network ?? l.network),
        usd: num(total.total),
        model_usd: num(total.model),
        review_usd: num(total.review),
        speech_usd: num(total.speech),
        tokens_in: num(l.tokens?.in ?? l.tokensIn),
        tokens_out: num(l.tokens?.out ?? l.tokensOut),
        saved_usd: typeof l.reuse === "object" && l.reuse ? num(l.reuse.savedUsd) : num(l.reuseSavedUsd),
        refused: 0,
        reviewed: flag(review.ran),
        material: typeof review.material === "number" ? review.material : flag(review.material),
        fix_round: flag(review.fixRound),
        logged: flag(l.outcome === "clarify"),
        cache_hit: flag(tier && tier !== "miss"),
        rephrase: flag(l.rephraseOf),
        reask_voice: flag(l.reAskAfterVoice),
        reply_s: secs(l.totalMs),
        first_token_s: secs(l.firstTokenMs),
        speech_s: typeof l.speechSeconds === "number" ? l.speechSeconds : null,
        abandoned: flag(l.abandoned),
        queue_s: secs(l.queueMs),
        waited: flag(typeof l.queueMs === "number" && l.queueMs > 0),
        transcript_edits: typeof l.transcriptEditDistance === "number" ? l.transcriptEditDistance : null,
        edited: flag(typeof l.transcriptEditDistance === "number" && l.transcriptEditDistance > 0),
        internal: flag(l.internal || l.pack === USAGE_HOST),
      };
      t.turns.push(row);
      // No roles field (switched off): no rows, rather than one "(none)" row that would read as a role.
      if (l.roles) for (const role of l.roles.length ? l.roles : ["(none)"]) t.roles.push({ turn_id: l.turnId, role: String(role).slice(0, 80), user_name: row.user_name, at: l.at });
      const used = new Set<string>([kind]);
      if (row.input === "spoken") used.add("voice");
      if (row.reviewed) used.add("reviewer");
      if (row.fix_round) used.add("fix round");
      if (row.outcome === "clarify") used.add("clarify");
      if (row.cache_hit) used.add("saved answer");
      for (const f of used) t.features.push({ turn_id: l.turnId, feature: f, at: l.at });
    } else {
      const event = l.event ?? l.type ?? "event";
      t.events.push({ turn_id: str(l.turnId), event: event.slice(0, 60), value: str(l.thumbs ?? l.rating ?? l.value ?? l.choice ?? l.how), reason: str(l.reason), stage: str(l.stage), at: l.at, user_name: str(l.user) });
    }
  }
  return t;
}

/** The telemetry files in a state directory: telemetry.jsonl and the monthly telemetry-YYYY-MM.jsonl. */
export function telemetryFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^telemetry(-\d{4}-\d{2})?\.jsonl$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** The telemetry lines at or after a time, from every file; an unreadable line is skipped. */
export function readTelemetry(dir: string, from: Date): TelemetryLine[] {
  const iso = from.toISOString();
  const month = iso.slice(0, 7);
  return telemetryFiles(dir)
    .filter((f) => {
      const m = /telemetry-(\d{4}-\d{2})\.jsonl$/.exec(f);
      return !m || m[1]! >= month;
    })
    .flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line) => {
          if (!line.trim()) return [];
          try {
            const l = JSON.parse(line) as TelemetryLine;
            return typeof l.at === "string" && l.at >= iso ? [l] : [];
          } catch {
            return [];
          }
        }),
    );
}

// --- the tables ------------------------------------------------------------

const TURN_COLUMNS: [keyof UsageRow, string][] = [
  ["id", "VARCHAR"], ["chat_session", "VARCHAR"], ["at", "TIMESTAMP"], ["hour", "INTEGER"], ["user_name", "VARCHAR"], ["board", "VARCHAR"], ["pack", "VARCHAR"],
  ["datasets", "VARCHAR"], ["campaign", "VARCHAR"], ["campaign_type", "VARCHAR"], ["country", "VARCHAR"], ["model", "VARCHAR"], ["language", "VARCHAR"],
  ["input", "VARCHAR"], ["kind", "VARCHAR"], ["answer_kind", "VARCHAR"], ["outcome", "VARCHAR"], ["cache_tier", "VARCHAR"], ["question", "VARCHAR"],
  ["device", "VARCHAR"], ["network", "VARCHAR"], ["usd", "DOUBLE"], ["model_usd", "DOUBLE"], ["review_usd", "DOUBLE"], ["speech_usd", "DOUBLE"],
  ["tokens_in", "BIGINT"], ["tokens_out", "BIGINT"], ["saved_usd", "DOUBLE"], ["refused", "INTEGER"], ["reviewed", "INTEGER"], ["material", "INTEGER"],
  ["fix_round", "INTEGER"], ["logged", "INTEGER"], ["cache_hit", "INTEGER"], ["rephrase", "INTEGER"], ["reask_voice", "INTEGER"], ["reply_s", "DOUBLE"],
  ["first_token_s", "DOUBLE"], ["speech_s", "DOUBLE"], ["question_hash", "VARCHAR"], ["question_words", "INTEGER"], ["outcome_reason", "VARCHAR"],
  ["abandoned", "INTEGER"], ["queue_s", "DOUBLE"], ["waited", "INTEGER"], ["transcript_edits", "INTEGER"], ["edited", "INTEGER"], ["internal", "INTEGER"],
];
const TABLES: { name: string; columns: [string, string][]; rows: (t: UsageTables) => Record<string, unknown>[] }[] = [
  { name: "usage_turns", columns: TURN_COLUMNS, rows: (t) => t.turns },
  { name: "usage_features", columns: [["turn_id", "VARCHAR"], ["feature", "VARCHAR"], ["at", "TIMESTAMP"]], rows: (t) => t.features },
  { name: "usage_roles", columns: [["turn_id", "VARCHAR"], ["role", "VARCHAR"], ["user_name", "VARCHAR"], ["at", "TIMESTAMP"]], rows: (t) => t.roles },
  { name: "usage_events", columns: [["turn_id", "VARCHAR"], ["event", "VARCHAR"], ["value", "VARCHAR"], ["reason", "VARCHAR"], ["stage", "VARCHAR"], ["at", "TIMESTAMP"], ["user_name", "VARCHAR"]], rows: (t) => t.events },
  {
    name: "usage_transcripts",
    columns: [["transcript_id", "VARCHAR"], ["at", "TIMESTAMP"], ["user_name", "VARCHAR"], ["model", "VARCHAR"], ["language", "VARCHAR"], ["seconds", "DOUBLE"], ["usd", "DOUBLE"], ["ms", "INTEGER"], ["words", "INTEGER"]],
    rows: (t) => t.transcripts,
  },
];

// --- where each column comes from -----------------------------------------------

type From = { kind: "turn" | "transcript" | "event"; field: string };
const turn = (field: string): From => ({ kind: "turn", field });
/**
 * The record field each column is read from, per table. A column left out (ids, times, the board and pack, the event's
 * name) is on every record. The event table's rows belong to the field group of their event, which a measure names
 * in its filter (event = 'feedback'); keyFields reads that too.
 */
export const COLUMNS: Record<string, Record<string, From>> = {
  usage_turns: {
    user_name: turn("user"), chat_session: turn("sessionId"), campaign: turn("campaign"), campaign_type: turn("campaignType"), country: turn("country"),
    model: turn("models"), language: turn("questionLanguage"), input: turn("input"), kind: turn("kind"), answer_kind: turn("kind"), outcome: turn("outcome"),
    cache_tier: turn("reuse"), question: turn("question"), question_hash: turn("questionHash"), question_words: turn("questionWords"), outcome_reason: turn("outcomeReason"),
    device: turn("device"), network: turn("network"), usd: turn("costUsd"), model_usd: turn("modelUsd"), review_usd: turn("reviewUsd"), speech_usd: turn("speechUsd"),
    tokens_in: turn("tokensIn"), tokens_out: turn("tokensOut"), saved_usd: turn("reuseSavedUsd"), reviewed: turn("reviewRan"), material: turn("reviewMaterial"),
    fix_round: turn("fixRound"), logged: turn("outcome"), cache_hit: turn("reuse"), rephrase: turn("rephraseOf"), reask_voice: turn("reAskAfterVoice"),
    reply_s: turn("totalMs"), first_token_s: turn("firstTokenMs"), abandoned: turn("abandoned"), queue_s: turn("queueMs"), waited: turn("queueMs"),
    transcript_edits: turn("transcriptEditDistance"), edited: turn("transcriptEditDistance"),
  },
  usage_features: {},
  usage_roles: { role: turn("roles"), user_name: turn("user") },
  usage_events: { user_name: { kind: "event", field: "user" }, reason: { kind: "event", field: "reason" } },
  usage_transcripts: {
    user_name: { kind: "transcript", field: "user" }, model: { kind: "transcript", field: "model" }, language: { kind: "transcript", field: "languageDetected" },
    seconds: { kind: "transcript", field: "seconds" }, usd: { kind: "transcript", field: "usd" }, ms: { kind: "transcript", field: "ms" }, words: { kind: "transcript", field: "words" },
  },
};

/** Tables that have rows only while a field is recorded. */
const ROWS_FROM: Record<string, From> = { usage_roles: turn("roles") };

/**
 * For each key of the usage pack, the telemetry field groups it reads: those of the columns named in its SQL and
 * filter, those of the events its filter names, and for a measure built from others, theirs. A key with none reads
 * only what every record keeps. The host turns these into the unavailable keys while a field group is off.
 */
export function keyFields(pack: Pack): Record<string, string[]> {
  const table = (entity: string) => pack.entities[entity]?.source ?? entity;
  const read = (entity: string, ...text: (string | undefined)[]) => {
    const cols = COLUMNS[table(entity)] ?? {};
    const src = text.filter(Boolean).join(" ");
    const out = new Set<string>();
    // A table whose rows come from one field (a role row per role a turn's user had) needs that field for any key on it.
    const whole = ROWS_FROM[table(entity)];
    if (whole) out.add(fieldOfRecord(whole.kind, whole.field)!.id);
    for (const [col, from] of Object.entries(cols)) if (new RegExp(`\\b${col}\\b`).test(src)) { const f = fieldOfRecord(from.kind, from.field); if (f) out.add(f.id); }
    for (const m of src.matchAll(/\bevent\s*(?:=|IN\s*\()\s*'([^']+)'(?:\s*,\s*'([^']+)')*/gi)) {
      for (const name of m.slice(1).filter(Boolean)) {
        const f = fieldForEvent(name, /stage\s*=\s*'after-transcription'/.test(src) ? "after-transcription" : null);
        if (f) out.add(f.id);
      }
    }
    return out;
  };
  // What a key reads, as text: its SQL, field, filter and conditions (not its label or hint).
  const text = (x: unknown) => (x === undefined ? undefined : typeof x === "string" ? x : JSON.stringify(x));
  const out: Record<string, Set<string>> = {};
  for (const d of pack.dimensions) out[d.key] = read(d.entity, text(d.sql), text(d.field));
  for (const m of pack.measures) out[m.key] = read(m.entity, text(m.sql), text(m.field), text(m.filter), text(m.where));
  // A measure derived from others reads what they read.
  const keys = pack.measures.map((m) => m.key);
  for (const m of pack.measures) {
    const d = text(m.derived);
    if (!d) continue;
    for (const k of keys) if (k !== m.key && new RegExp(`\\b${k}\\b`).test(d)) for (const f of out[k] ?? []) out[m.key]!.add(f);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}
const stamp = (iso: string) => new Date(iso).toISOString().replace("T", " ").replace("Z", "");

type Db = { writer: { exec(sql: string, params?: unknown[]): Promise<unknown> } };

/** Replaces the usage tables (timestamps in UTC), in one transaction. */
export async function loadUsage(db: Db, tables: UsageTables) {
  await db.writer.exec("BEGIN TRANSACTION");
  try {
    for (const t of TABLES) {
      // Made again each time, so a table an older version made with other columns is replaced.
      await db.writer.exec(`DROP TABLE IF EXISTS ${t.name}`);
      // "at" is a reserved word in SQL: the column is asked_at.
      await db.writer.exec(`CREATE TABLE ${t.name} (${t.columns.map(([c, ty]) => `${c === "at" ? "asked_at" : c} ${ty}`).join(", ")})`);
      const rows = t.rows(tables);
      const per = Math.max(1, Math.floor(1000 / t.columns.length));
      for (let s = 0; s < rows.length; s += per) {
        const params: unknown[] = [];
        const values = rows.slice(s, s + per).map(
          (r) =>
            `(${t.columns
              .map(([c, ty]) => {
                const v = r[c];
                params.push(ty === "TIMESTAMP" && typeof v === "string" ? stamp(v) : (v ?? null));
                return ty === "TIMESTAMP" ? `CAST($${params.length} AS TIMESTAMP)` : `$${params.length}`;
              })
              .join(", ")})`,
        );
        await db.writer.exec(`INSERT INTO ${t.name} VALUES ${values.join(", ")}`, params);
      }
    }
    await db.writer.exec("COMMIT");
  } catch (e) {
    await db.writer.exec("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

export type UsageSourceOptions = {
  /** usage.duckdb goes here (the tables and the board's versions); telemetry*.jsonl is read from here when present. */
  stateDir: string;
  /** The audit events at or after a time: the fallback when there is no telemetry. */
  events?: (from: Date) => AuditEvent[];
  /** How many days of turns the tables hold (default 90). */
  days?: number;
  /** Seconds between refreshes (default 30). */
  refreshSeconds?: number;
  now?: () => Date;
  log?: (line: string) => void;
};

export type UsageSource = NonNullable<Awaited<ReturnType<typeof usageSource>>>;

/** The usage tables as a connector (with a board store beside them), or null when DuckDB is not installed. */
export async function usageSource(o: UsageSourceOptions) {
  const now = o.now ?? (() => new Date());
  let opened: Awaited<ReturnType<(typeof import("@lenspack/sql/duckdb"))["openDuckdb"]>>;
  try {
    const { openDuckdb } = await import("@lenspack/sql/duckdb");
    opened = await openDuckdb(join(o.stateDir, "usage.duckdb"));
  } catch (e) {
    o.log?.(`usage board off: ${e instanceof Error ? e.message : String(e)} (it needs @duckdb/node-api)`);
    return null;
  }
  const { sqlConnector, sqlStore } = await import("@lenspack/sql");
  const sql: Connector = sqlConnector(opened.executor);
  const store = sqlStore(opened);
  await store.migrate();
  let loadedAt = 0;
  let source: "telemetry" | "audit" | "none" = "none";
  let loading: Promise<void> | null = null;
  const refresh = async (force = false) => {
    if (!force && Date.now() - loadedAt < (o.refreshSeconds ?? 30) * 1000) return;
    if (loading) return loading;
    loading = (async () => {
      const from = new Date(now().getTime() - (o.days ?? 90) * 86_400_000);
      const telemetry = telemetryFiles(o.stateDir).length ? readTelemetry(o.stateDir, from) : [];
      const tables = telemetry.length ? usageFromTelemetry(telemetry) : usageFromAudit((o.events?.(from) ?? []).slice().sort((a, b) => a.at.localeCompare(b.at)));
      source = telemetry.length ? "telemetry" : o.events ? "audit" : "none";
      await loadUsage(opened, tables);
      loadedAt = Date.now();
    })().finally(() => (loading = null));
    return loading;
  };
  await refresh(true);
  // The SQL connector over the tables, which reads the record again first when it is older than the refresh time.
  const connector: Connector = {
    kind: sql.kind,
    capabilities: sql.capabilities,
    compile: (bound, pack) => sql.compile(bound, pack),
    async execute(plan, opts) {
      await refresh().catch((e) => o.log?.(`usage refresh failed: ${e instanceof Error ? e.message : String(e)}`));
      return sql.execute(plan, opts);
    },
    introspect: sql.introspect ? () => sql.introspect!() : undefined,
  };
  return {
    connector,
    store,
    refresh,
    /** Where the tables were last read from. */
    source: () => source,
    close: () => opened.close(),
  };
}
