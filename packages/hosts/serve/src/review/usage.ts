import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import type { Connector } from "@lenspack/engine";
import { type Pack, parsePackText } from "@lenspack/pack";
import { type Principal, principalOf } from "@lenspack/policy";

import { type BoardFile, type Host, createApp, seedBoards } from "../app";
import type { Audit, AuditEvent } from "../audit";
import type { Provider } from "../llm";
import type { Budget, UsageLedger } from "../metering";

// Usage as a Lenspack board. The admin panel's Overview is not a hand-drawn chart: it is a board,
// drawn by the same engine and renderer people use, over a built-in pack whose data is this server's
// own record of its chat turns, read into tables in an in-process DuckDB database. That record is the
// turn telemetry (telemetry*.jsonl in the state directory, one line per turn plus events such as
// thumbs) when the server writes it, and otherwise the audit log's chat-turn lines, which carry less.
// Admins can change the board like any other, and ask the chat about it ("which board cost most this
// week?"). Those chat turns are marked internal: logged and costed like any other, but left out of the
// daily review, so the review never reviews itself.

/** The usage pack's host name: /api/usage/<board> inside the panel. */
export const USAGE_HOST = "usage";

export const USAGE_PACK_YAML = `pack: lenspack_usage
version: 1
description: How people use this Lenspack server, one row per chat turn. Users are named as they sign in, so this pack is for admins only.
instructions: >-
  Each row of usage_turns is one chat turn: one question or instruction and the assistant's reply. Rates (answer rate, failure rate,
  saved-answer rate, spoken share) are one count over another, computed with the ratio step, for example failed ratio turns. Costs are
  estimates from list prices, in US dollars. Reply time is the seconds from the question to the end of the reply. Active users are people
  (distinct users) over a day or a week. A turn on the pack "usage" was asked here, about usage. Feedback, transcript edits and other
  events are in usage_events, one row per event, joined to the turn they are about. Roles are in usage_roles, one row per role a turn's
  user had.
entities:
  usage_turns:
    source: usage_turns
    grain: one row per chat turn
    time: asked_at
  usage_features:
    source: usage_features
    grain: one row per feature a chat turn used
    time: asked_at
    joins:
      - { to: usage_turns, on: usage_features.turn_id = usage_turns.id, type: many_to_one }
  usage_roles:
    source: usage_roles
    grain: one row per role the user of a chat turn had
    time: asked_at
    joins:
      - { to: usage_turns, on: usage_roles.turn_id = usage_turns.id, type: many_to_one }
  usage_events:
    source: usage_events
    grain: one row per event on a chat turn (feedback, a transcript edit, a quick reply, an export)
    time: asked_at
    joins:
      - { to: usage_turns, on: usage_events.turn_id = usage_turns.id, type: many_to_one }
dimensions:
  - { key: day, entity: usage_turns, sql: asked_at, type: time, grains: [hour, day, week, month], label: Day }
  - { key: hour, entity: usage_turns, sql: hour, type: number, label: Hour of the day (UTC) }
  - { key: user, entity: usage_turns, sql: user_name, label: User, synonyms: [person, who] }
  - { key: session, entity: usage_turns, sql: session_id, label: Chat session }
  - { key: board, entity: usage_turns, sql: board, label: Board, synonyms: [dashboard] }
  - { key: pack, entity: usage_turns, sql: pack, label: Pack }
  - { key: datasets, entity: usage_turns, sql: datasets, label: Datasets read }
  - { key: campaign, entity: usage_turns, sql: campaign, label: Campaign }
  - { key: campaign_type, entity: usage_turns, sql: campaign_type, label: Campaign type }
  - { key: country, entity: usage_turns, sql: country, label: Country }
  - { key: model, entity: usage_turns, sql: model, label: Model }
  - { key: language, entity: usage_turns, sql: language, label: Language }
  - { key: input, entity: usage_turns, sql: input, type: enum, label: Typed or spoken, synonyms: [voice] }
  - { key: kind, entity: usage_turns, sql: kind, type: enum, label: Answer or edit, hint: edit when the turn saved a change to a board, answer otherwise. }
  - { key: answer_kind, entity: usage_turns, sql: answer_kind, type: enum, label: Kind of answer, hint: "direct (a figure read from the data), derived (worked out from figures), chart (a chart drawn or changed), meta (about the tool or the data, no figure)." }
  - { key: outcome, entity: usage_turns, sql: outcome, type: enum, label: Outcome, hint: "answered, declined, failed, or clarify (the assistant asked which reading was meant)." }
  - { key: cache_tier, entity: usage_turns, sql: cache_tier, label: Saved-answer tier, hint: The tier of saved answers that answered the turn; empty when none did. }
  - { key: question, entity: usage_turns, sql: question, label: Question asked }
  - { key: device, entity: usage_turns, sql: device, label: Device }
  - { key: network, entity: usage_turns, sql: network, label: Network }
  - { key: feature, entity: usage_features, sql: feature, label: Feature used }
  - { key: role, entity: usage_roles, sql: role, label: Role }
  - { key: event, entity: usage_events, sql: event, label: Event }
  - { key: event_value, entity: usage_events, sql: value, label: Event value, hint: up or down for feedback, chosen or ignored for a quick reply. }
  - { key: reason, entity: usage_events, sql: reason, label: Feedback reason }
measures:
  - { key: turns, entity: usage_turns, agg: count, label: Turns, synonyms: [chats, requests] }
  - { key: questions, entity: usage_turns, agg: count, filter: "kind = 'answer'", label: Questions answered, hint: Turns that changed no board. }
  - { key: edits, entity: usage_turns, agg: count, filter: "kind = 'edit'", label: Board edits, hint: Turns that saved a change to a board. }
  - { key: answered, entity: usage_turns, agg: count, filter: "outcome = 'answered'", label: Answered turns }
  - { key: failed, entity: usage_turns, agg: count, filter: "outcome = 'failed'", label: Failed turns, synonyms: [errors] }
  - { key: people, entity: usage_turns, agg: count_distinct, sql: user_name, label: Active users, synonyms: [users, people] }
  - { key: sessions, entity: usage_turns, agg: count_distinct, sql: session_id, label: Chat sessions }
  - { key: cost_usd, entity: usage_turns, agg: sum, sql: usd, label: Cost (US$), synonyms: [spend, money] }
  - { key: model_usd, entity: usage_turns, agg: sum, sql: model_usd, label: Model cost (US$) }
  - { key: review_usd, entity: usage_turns, agg: sum, sql: review_usd, label: Reviewer cost (US$) }
  - { key: speech_usd, entity: usage_turns, agg: sum, sql: speech_usd, label: Speech-to-text cost (US$) }
  - { key: tokens_in, entity: usage_turns, agg: sum, sql: tokens_in, format: compact, label: Tokens in }
  - { key: tokens_out, entity: usage_turns, agg: sum, sql: tokens_out, format: compact, label: Tokens out }
  - { key: cache_hits, entity: usage_turns, agg: sum, sql: cache_hit, label: Answered from saved answers, synonyms: [cache hits] }
  - { key: saved_usd, entity: usage_turns, agg: sum, sql: saved_usd, label: Saved by saved answers (US$) }
  - { key: refusals, entity: usage_turns, agg: sum, sql: refused, label: Turns with a refusal, hint: The pack or the server refused part of what was asked. }
  - { key: declines, entity: usage_turns, agg: count, filter: "outcome = 'declined'", label: Turns declined }
  - { key: reviewer_runs, entity: usage_turns, agg: sum, sql: reviewed, label: Reviewer checks }
  - { key: material_findings, entity: usage_turns, agg: sum, sql: material, label: Material reviewer findings }
  - { key: fix_rounds, entity: usage_turns, agg: sum, sql: fix_round, label: Fix rounds }
  - { key: clarifying_asked, entity: usage_turns, agg: count, filter: "outcome = 'clarify'", label: Clarifying questions asked }
  - { key: questions_logged, entity: usage_turns, agg: sum, sql: logged, label: Open questions logged }
  - { key: rephrased, entity: usage_turns, agg: sum, sql: rephrase, label: Rephrased questions, hint: A question asked again in other words soon after. }
  - { key: reasked_after_voice, entity: usage_turns, agg: sum, sql: reask_voice, label: Typed again after speaking }
  - { key: reply_median_s, entity: usage_turns, agg: median, sql: reply_s, format: duration, label: Median reply time (s) }
  - { key: reply_p95_s, entity: usage_turns, agg: p95, sql: reply_s, format: duration, label: 95th percentile reply time (s), synonyms: [p95] }
  - { key: first_token_median_s, entity: usage_turns, agg: median, sql: first_token_s, format: duration, label: Median time to first words (s) }
  - { key: spoken, entity: usage_turns, agg: count, filter: "input = 'spoken'", label: Spoken questions }
  - { key: speech_seconds, entity: usage_turns, agg: sum, sql: speech_s, format: duration, label: Speech seconds }
  - { key: feature_uses, entity: usage_features, agg: count, label: Feature uses }
  - { key: role_people, entity: usage_roles, agg: count_distinct, sql: user_name, label: Active users by role }
  - { key: events, entity: usage_events, agg: count, label: Events }
  - { key: thumbs_down, entity: usage_events, agg: count, filter: "event = 'feedback' AND value = 'down'", label: Thumbs down }
  - { key: thumbs_up, entity: usage_events, agg: count, filter: "event = 'feedback' AND value = 'up'", label: Thumbs up }
`;

const kpi = (id: string, title: string, query: Record<string, unknown>) => ({ op: "add_widget", id, placement: { place: "bottom", width: "quarter", height: 3 }, widget: { kind: "kpi", title, query } });
const chart = (id: string, chart: string, title: string, query: Record<string, unknown>, width = "half") => ({ op: "add_widget", id, placement: { place: "bottom", width, height: 7 }, widget: { kind: "chart", chart, title, query } });
const rate = (measure: string, to = "turns") => ({ measure, compute: { steps: [{ op: "ratio", to, percent: true }] } });
const DAYS = { last: "30d" };
const WEEK = { last: "7d" };

/** The default board. Rates are a count over turns (the ratio step), so the pack keeps only plain counts. */
export const USAGE_BOARD: BoardFile = {
  id: "overview",
  title: "Usage",
  ops: [
    kpi("turns_today", "Turns today", { kind: "value", measure: "turns", time: { period: "day" } }),
    kpi("cost_today", "Cost today (US$)", { kind: "value", measure: "cost_usd", time: { period: "day" } }),
    kpi("cache_rate", "Saved-answer rate, 7 days", { kind: "value", time: WEEK, ...rate("cache_hits") }),
    kpi("error_rate", "Failure rate, 7 days", { kind: "value", time: WEEK, ...rate("failed") }),
    kpi("answer_rate", "Answer rate, 7 days", { kind: "value", time: WEEK, ...rate("answered") }),
    kpi("voice_share", "Spoken share, 7 days", { kind: "value", time: WEEK, ...rate("spoken") }),
    kpi("active_week", "Active users, 7 days", { kind: "value", measure: "people", time: WEEK }),
    kpi("p95_week", "95th percentile reply, 7 days (s)", { kind: "value", measure: "reply_p95_s", time: WEEK }),
    chart("daily_turns", "line", "Turns per day", { kind: "series", measure: "turns", grain: "day", time: DAYS }),
    chart("daily_cost", "line", "Cost per day by model (US$)", { kind: "series", measure: "cost_usd", grain: "day", by: "model", time: DAYS }),
    chart("dau_country", "line", "Daily active users by country", { kind: "series", measure: "people", grain: "day", by: "country", time: DAYS }),
    chart("wau_role", "bar", "Weekly active users by role", { kind: "series", measure: "role_people", grain: "week", by: "role", time: { last: "12w" } }),
    chart("top_users", "bar", "Top users, 30 days", { kind: "breakdown", dimension: "user", measure: "turns", limit: 10, time: DAYS }),
    chart("top_boards", "bar", "Top boards by cost, 30 days (US$)", { kind: "breakdown", dimension: "board", measure: "cost_usd", limit: 10, time: DAYS }),
    chart("outcomes_language", "bar", "Outcomes by language, 30 days", { kind: "breakdown", dimension: "language", by: "outcome", measure: "turns", limit: 12, time: DAYS }),
    chart("answer_rate_language", "bar", "Answer rate by language, 30 days", { kind: "breakdown", dimension: "language", limit: 12, time: DAYS, ...rate("answered") }),
    chart("kind_mix", "pie", "Direct, derived and chart answers, 30 days", { kind: "breakdown", dimension: "answer_kind", measure: "turns", limit: 6, time: DAYS }),
    chart("p95_kind", "bar", "95th percentile reply time by kind of answer (s)", { kind: "breakdown", dimension: "answer_kind", measure: "reply_p95_s", limit: 6, time: DAYS }),
    chart("thumbs_down", "bar", "Thumbs-down reasons, 30 days", { kind: "breakdown", dimension: "reason", measure: "thumbs_down", limit: 10, time: DAYS }),
    chart("voice_share_daily", "line", "Spoken share per day", { kind: "series", grain: "day", time: DAYS, ...rate("spoken") }),
    { op: "add_widget", id: "top_questions", placement: { place: "bottom", width: "full", height: 8 }, widget: { kind: "table", title: "Most-asked questions with their outcome, 30 days", query: { kind: "breakdown", dimension: "question", measure: "turns", measures: ["answered", "failed", "declines", "clarifying_asked", "edits"], limit: 25, time: DAYS }, pageSize: 10 } },
    chart("reply_time", "line", "Reply time per day: 95th percentile and median (s)", { kind: "series", measure: "reply_p95_s", measures: ["reply_median_s"], grain: "day", time: DAYS }, "full"),
  ],
};

export type UsageRow = {
  id: string;
  session_id: string | null;
  at: string;
  hour: number;
  user_name: string;
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
  internal: number;
};
export type UsageTables = {
  turns: UsageRow[];
  features: { turn_id: string; feature: string; at: string }[];
  roles: { turn_id: string; role: string; user_name: string; at: string }[];
  events: { turn_id: string; event: string; value: string | null; reason: string | null; at: string; user_name: string | null }[];
};
const emptyTables = (): UsageTables => ({ turns: [], features: [], roles: [], events: [] });

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
      session_id: null,
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
      t.events.push({ turn_id: id, event: "quick-reply", value: "chosen", reason: null, at: e.at, user_name: e.user });
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
  reAskAfterVoice?: boolean;
  client?: { device?: string; network?: string; viewport?: string };
  speechSeconds?: number;
  saved?: boolean;
  internal?: boolean;
  // events
  thumbs?: "up" | "down";
  value?: string;
  reason?: string;
  choice?: string;
};

const isTurn = (l: TelemetryLine) => (l.type ? l.type === "turn" : !l.event && typeof l.question === "string");

/** Telemetry lines → the usage tables. Events whose turn is not in the window are kept, unjoined. */
export function usageFromTelemetry(lines: TelemetryLine[]): UsageTables {
  const t = emptyTables();
  for (const l of lines) {
    if (!l.turnId || !l.at) continue;
    if (isTurn(l)) {
      const total = typeof l.costUsd === "object" && l.costUsd ? l.costUsd : { total: l.costUsd, ...l.cost };
      const tier = typeof l.reuse === "string" ? l.reuse : l.reuse?.tier !== undefined ? String(l.reuse.tier) : null;
      const kind = l.kind ?? "direct";
      const row: UsageRow = {
        id: l.turnId,
        session_id: str(l.sessionId),
        at: l.at,
        hour: new Date(l.at).getUTCHours(),
        user_name: l.user ?? "unknown",
        board: str(l.board),
        pack: str(l.pack),
        datasets: Array.isArray(l.datasets) ? l.datasets.join(", ").slice(0, 200) || null : str(l.datasets),
        campaign: str(l.campaign),
        campaign_type: str(l.campaignType),
        country: str(l.country),
        model: l.models?.[0] ?? null,
        language: l.language ?? "auto",
        input: l.input === "spoken" ? "spoken" : "typed",
        kind: l.saved || kind === "chart" ? "edit" : "answer",
        answer_kind: kind,
        outcome: l.outcome ?? "answered",
        cache_tier: tier && tier !== "miss" ? tier : null,
        question: tidy(l.question, 200),
        device: str(l.client?.device),
        network: str(l.client?.network),
        usd: num(total.total),
        model_usd: num(total.model),
        review_usd: num(total.review),
        speech_usd: num(total.speech),
        tokens_in: num(l.tokens?.in),
        tokens_out: num(l.tokens?.out),
        saved_usd: typeof l.reuse === "object" && l.reuse ? num(l.reuse.savedUsd) : 0,
        refused: 0,
        reviewed: flag(l.review?.ran),
        material: typeof l.review?.material === "number" ? l.review.material : flag(l.review?.material),
        fix_round: flag(l.review?.fixRound),
        logged: flag(l.outcome === "clarify"),
        cache_hit: flag(tier && tier !== "miss"),
        rephrase: flag(l.rephraseOf),
        reask_voice: flag(l.reAskAfterVoice),
        reply_s: secs(l.totalMs),
        first_token_s: secs(l.firstTokenMs),
        speech_s: typeof l.speechSeconds === "number" ? l.speechSeconds : null,
        internal: flag(l.internal || l.pack === USAGE_HOST),
      };
      t.turns.push(row);
      for (const role of l.roles?.length ? l.roles : ["(none)"]) t.roles.push({ turn_id: l.turnId, role: String(role).slice(0, 80), user_name: row.user_name, at: l.at });
      const used = new Set<string>([kind]);
      if (row.input === "spoken") used.add("voice");
      if (row.reviewed) used.add("reviewer");
      if (row.fix_round) used.add("fix round");
      if (row.outcome === "clarify") used.add("clarify");
      if (row.cache_hit) used.add("saved answer");
      for (const f of used) t.features.push({ turn_id: l.turnId, feature: f, at: l.at });
    } else {
      const event = l.event ?? l.type ?? "event";
      t.events.push({ turn_id: l.turnId, event: event.slice(0, 60), value: str(l.thumbs ?? l.value ?? l.choice), reason: str(l.reason), at: l.at, user_name: str(l.user) });
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
  ["id", "VARCHAR"], ["session_id", "VARCHAR"], ["at", "TIMESTAMP"], ["hour", "INTEGER"], ["user_name", "VARCHAR"], ["board", "VARCHAR"], ["pack", "VARCHAR"],
  ["datasets", "VARCHAR"], ["campaign", "VARCHAR"], ["campaign_type", "VARCHAR"], ["country", "VARCHAR"], ["model", "VARCHAR"], ["language", "VARCHAR"],
  ["input", "VARCHAR"], ["kind", "VARCHAR"], ["answer_kind", "VARCHAR"], ["outcome", "VARCHAR"], ["cache_tier", "VARCHAR"], ["question", "VARCHAR"],
  ["device", "VARCHAR"], ["network", "VARCHAR"], ["usd", "DOUBLE"], ["model_usd", "DOUBLE"], ["review_usd", "DOUBLE"], ["speech_usd", "DOUBLE"],
  ["tokens_in", "BIGINT"], ["tokens_out", "BIGINT"], ["saved_usd", "DOUBLE"], ["refused", "INTEGER"], ["reviewed", "INTEGER"], ["material", "INTEGER"],
  ["fix_round", "INTEGER"], ["logged", "INTEGER"], ["cache_hit", "INTEGER"], ["rephrase", "INTEGER"], ["reask_voice", "INTEGER"], ["reply_s", "DOUBLE"],
  ["first_token_s", "DOUBLE"], ["speech_s", "DOUBLE"], ["internal", "INTEGER"],
];
const TABLES: { name: string; columns: [string, string][]; rows: (t: UsageTables) => Record<string, unknown>[] }[] = [
  { name: "usage_turns", columns: TURN_COLUMNS, rows: (t) => t.turns },
  { name: "usage_features", columns: [["turn_id", "VARCHAR"], ["feature", "VARCHAR"], ["at", "TIMESTAMP"]], rows: (t) => t.features },
  { name: "usage_roles", columns: [["turn_id", "VARCHAR"], ["role", "VARCHAR"], ["user_name", "VARCHAR"], ["at", "TIMESTAMP"]], rows: (t) => t.roles },
  { name: "usage_events", columns: [["turn_id", "VARCHAR"], ["event", "VARCHAR"], ["value", "VARCHAR"], ["reason", "VARCHAR"], ["at", "TIMESTAMP"], ["user_name", "VARCHAR"]], rows: (t) => t.events },
];
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

export type UsageBoardOptions = {
  /** usage.duckdb goes here (the usage tables and the board's versions); telemetry*.jsonl is read from here when present. */
  stateDir: string;
  /** The audit events at or after a time: the fallback when there is no telemetry. */
  events?: (from: Date) => AuditEvent[];
  providers: () => Provider[];
  ledger?: UsageLedger;
  budget?: Budget;
  roles?: { reviewer?: string; escalate?: string };
  /** The deployment's audit log: the usage chat's lines go there, marked internal. */
  audit?: Audit;
  review?: () => boolean;
  chatDefault?: () => { model?: string; effort?: string } | undefined;
  log?: (line: string) => void;
  /** How many days of turns the tables hold (default 90). */
  days?: number;
  /** Seconds between refreshes (default 30): the tables are read again when the board is opened after that. */
  refreshSeconds?: number;
  now?: () => Date;
};

export type UsageBoard = NonNullable<Awaited<ReturnType<typeof usageBoard>>>;

/** The usage pack, its DuckDB tables, its board and the board API over them, or null when DuckDB is not installed. */
export async function usageBoard(o: UsageBoardOptions) {
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
  const pack: Pack = parsePackText(USAGE_PACK_YAML);
  const connector: Connector = sqlConnector(opened.executor);
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
  const host: Host = { name: USAGE_HOST, pack, packYaml: USAGE_PACK_YAML, connector, store, ctx: {}, boards: [USAGE_BOARD] };
  await seedBoards(host);
  // Who asks is settled by the panel (an admin); the board API reads it off the request.
  const WHO = Symbol("lenspack-usage-who");
  // createApp keeps the list it is given; the deployment's providers are probed after start, so the
  // list is refreshed in place on every request.
  const providers: Provider[] = [...o.providers()];
  const app = createApp([host], {
    providers,
    roles: o.roles,
    ledger: o.ledger,
    budget: o.budget,
    review: o.review,
    chatDefault: o.chatDefault,
    log: o.log,
    access: (req) => (req as unknown as Record<symbol, Principal | undefined>)[WHO] ?? null,
    audit: o.audit ? (e) => o.audit!({ ...e, internal: true }) : undefined,
  });
  return {
    pack,
    host,
    refresh,
    /** Where the tables were last read from. */
    source: () => source,
    /** Answers <panel>/api/usage/<rest>: the board API for the usage pack, as `who` (an admin). */
    async handle(req: IncomingMessage, res: ServerResponse, rest: string, search: string, who: Principal) {
      providers.splice(0, providers.length, ...o.providers());
      await refresh().catch((e) => o.log?.(`usage board refresh failed: ${e instanceof Error ? e.message : String(e)}`));
      (req as unknown as Record<symbol, Principal>)[WHO] = principalOf({ user: who.user, edit: true, maintain: true, usage: true });
      req.url = `/api/${USAGE_HOST}${rest ? `/${rest}` : ""}${search}`;
      await app(req, res);
    },
    close: () => opened.close(),
  };
}
