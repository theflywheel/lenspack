// Data export, the record side: which streams the telemetry switches keep, what a record may carry when it leaves, and
// cursor pages that never skip or repeat a record. Policy decides who may read a stream (exportDecision in
// @lenspack/policy); the host checks the token, reads the stores and writes the bytes. Nothing here knows HTTP.
//
// A record leaves with the fields its items keep *now*: a field written while its item was on is left out once the
// item is switched off (onlyKept with today's items), so switching an item off also stops exporting what it kept.
// User names leave as written only for a grant with the usernames right; otherwise as the stand-in the admin panel
// shows (withoutNames), the same for one name in every stream.

import type { ExportStream, StreamStates } from "@lenspack/policy";

import { CORE_FIELDS, TELEMETRY_ITEMS, itemForEvent, onlyKept } from "./switchboard";
import { type TelemetryLine, withoutNames } from "./telemetry";

/** What the deployment keeps now: the items recording, telemetry as a whole, an audit log, kept recordings. */
export type ExportKeeping = { itemsOn: ReadonlySet<string>; telemetry: boolean; audit: boolean };

const itemsKeeping = (pred: (i: (typeof TELEMETRY_ITEMS)[number]) => boolean) => TELEMETRY_ITEMS.filter(pred).map((i) => i.id);
const FEEDBACK_ITEMS = itemsKeeping((i) => !!i.events?.includes("feedback"));
const EVENT_ITEMS = itemsKeeping((i) => !!i.events?.length);
const TRANSCRIPT_ITEMS = itemsKeeping((i) => i.source === "transcript" || (!!i.voice && !!i.transcript?.length));

/** Each stream: kept, or why not, from the switches as they stand. */
export function streamsKept(k: ExportKeeping): StreamStates {
  const any = (ids: string[]) => ids.some((id) => k.itemsOn.has(id));
  const tel = (ok: boolean, why: string) => (!k.telemetry ? { kept: false as const, why: "usage telemetry is off" } : ok ? { kept: true as const } : { kept: false as const, why });
  const audit = k.audit ? { kept: true as const } : { kept: false as const, why: "there is no audit log (audit: false)" };
  return {
    turns: tel(k.itemsOn.size > 0, "no telemetry item is on"),
    feedback: tel(any(FEEDBACK_ITEMS), `the ${FEEDBACK_ITEMS.join(", ")} item is off`),
    events: tel(any(EVENT_ITEMS), "no item that keeps client events is on"),
    transcripts: tel(any(TRANSCRIPT_ITEMS), "no voice item is on"),
    recordings: tel(k.itemsOn.has("voice-audio"), "the voice-audio item (kept recordings) is off"),
    audit,
    cost: audit,
  };
}

/** The telemetry line type a stream reads, and whether one line belongs to it. */
export function telemetryStream(stream: ExportStream): { type: TelemetryLine["type"]; keep: (l: TelemetryLine, on: ReadonlySet<string>) => boolean } | null {
  const eventOn = (l: TelemetryLine, on: ReadonlySet<string>) => {
    if (l.type !== "event") return false;
    const item = itemForEvent(l.event, (l as { stage?: string | null }).stage);
    return !!item && on.has(item.id);
  };
  if (stream === "turns") return { type: "turn", keep: (l) => l.type === "turn" };
  if (stream === "transcripts") return { type: "transcript", keep: (l) => l.type === "transcript" };
  if (stream === "feedback") return { type: "event", keep: (l, on) => l.type === "event" && l.event === "feedback" && eventOn(l, on) };
  if (stream === "events") return { type: "event", keep: eventOn };
  return null;
}

/** A stand-in for a user name: the admin panel's (withoutNames), so one name maps to one stand-in everywhere. */
export const standIn = (user: string, hash: (text: string) => string) => withoutNames([{ user }], hash)[0]!.user;

/** A telemetry line as it may leave: only the fields today's items keep, and the user as a stand-in unless allowed. */
export function exportLine(l: TelemetryLine, on: ReadonlySet<string>, o: { usernames: boolean; hash: (text: string) => string }): Record<string, unknown> {
  const kind = l.type as keyof typeof CORE_FIELDS;
  const kept = onlyKept(kind, l, on) as Record<string, unknown>;
  if (!o.usernames && typeof kept.user === "string") kept.user = standIn(kept.user, o.hash);
  return kept;
}

/** Any record with a user (an audit line, a cost row, a recording): the name as a stand-in unless allowed. */
export function withUser<T extends { user?: string }>(r: T, o: { usernames: boolean; hash: (text: string) => string }): T {
  return !o.usernames && typeof r.user === "string" ? { ...r, user: standIn(r.user, o.hash) } : r;
}

/**
 * An audit line as it may leave. A chat turn's detail holds the question and the answer as written, whatever the
 * telemetry switches say, so it leaves only while the question-text item is on; otherwise the line keeps its time, user,
 * action and outcome, and the cost stream carries what the turn cost.
 */
export function exportAuditLine<T extends { action: string; detail?: string; user?: string }>(e: T, on: ReadonlySet<string>, o: { usernames: boolean; hash: (text: string) => string }): T {
  const { detail, ...rest } = e;
  const line = (e.action === "chat-turn" && !on.has("question-text") ? rest : e) as T;
  return withUser(line, o);
}

// --- cursor pages -----------------------------------------------------------------------------------------------
//
// Records go out oldest first, ordered by time and then by a key. Turns and transcripts have ids; audit and event lines
// do not, so their key is the line itself (its JSON), which is stable because the logs are append-only. The cursor
// carries the last record's time and key digest: the next page starts strictly after it, so records written while a
// client pages through land on a later page and none is skipped or sent twice.

export type Cursor = { at: string; k: string };

/** A short, stable digest of a key (FNV-1a, 64 bits as two 32-bit halves): enough to order and resume, not a secret. */
export function keyDigest(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

export const encodeCursor = (c: Cursor) => b64(JSON.stringify(c));

/** The cursor a client sent back, or an error in words. */
export function decodeCursor(s: string): Cursor | { error: string } {
  try {
    const c = JSON.parse(unb64(s)) as Cursor;
    if (typeof c?.at !== "string" || Number.isNaN(Date.parse(c.at)) || typeof c.k !== "string" || !/^[0-9a-f]{16}$/.test(c.k)) throw new Error();
    return c;
  } catch {
    return { error: "cursor is not one this server gave" };
  }
}

export type PageQuery = { from?: Date; to?: Date; cursor?: Cursor; limit: number };
export type Page<T> = { records: T[]; next: Cursor | null };

/**
 * One page of records, oldest first: at or after `from`, before `to`, strictly after the cursor, at most `limit`.
 * `key` gives a record's id, or undefined to order it by its own JSON.
 */
export function exportPage<T extends { at: string }>(records: readonly T[], q: PageQuery, key: (r: T) => string | undefined = () => undefined): Page<T> {
  const from = q.from?.toISOString(), to = q.to?.toISOString();
  const keyed = records
    .filter((r) => (!from || r.at >= from) && (!to || r.at < to))
    .map((r) => ({ r, k: keyDigest(key(r) ?? JSON.stringify(r)) }))
    .sort((a, b) => a.r.at.localeCompare(b.r.at) || a.k.localeCompare(b.k));
  const c = q.cursor;
  const after = c ? keyed.filter((x) => x.r.at > c.at || (x.r.at === c.at && x.k > c.k)) : keyed;
  const limit = Math.max(1, Math.floor(q.limit));
  const page = after.slice(0, limit);
  const last = page[page.length - 1];
  return { records: page.map((x) => x.r), next: after.length > limit && last ? { at: last.r.at, k: last.k } : null };
}

/** The CSV columns of each stream, in order; a field a record does not carry is an empty cell. */
export const EXPORT_COLUMNS: Record<ExportStream, string[]> = {
  turns: ["at", "turnId", "sessionId", "user", "roles", "tenant", "pack", "board", "datasets", "campaign", "campaignType", "country", "input", "replyLanguage", "question", "questionHash", "kind", "outcome", "outcomeReason", "firstTokenMs", "totalMs", "queueMs", "costUsd", "modelUsd", "speechUsd", "reviewUsd", "tokensIn", "tokensOut", "models", "reuse", "reuseSavedUsd", "device", "network"],
  feedback: ["at", "turnId", "user", "pack", "board", "rating", "reason", "comment"],
  events: ["at", "event", "turnId", "user", "pack", "board", "how", "stage", "choice"],
  transcripts: ["at", "transcriptId", "user", "pack", "model", "seconds", "languageRequested", "languageDetected", "transcript", "transcriptHash", "usd"],
  recordings: ["at", "id", "user", "bytes", "format"],
  audit: ["at", "user", "action", "outcome", "pack", "board", "detail"],
  cost: ["at", "user", "board", "models", "tokensIn", "tokensOut", "costUsd", "sttUsd", "unpriced"],
};
