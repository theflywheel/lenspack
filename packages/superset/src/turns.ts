// What chat has cost, from the audit log: each chat-turn line carries the turn's cost (an estimate
// from list prices for the chat models, plus what the speech provider charged for a spoken question).
// The audit log is the durable record; the usage ledger behind GET /api/_usage resets on restart.

import type { AuditEvent } from "./audit";

export type TurnRow = {
  at: string;
  user: string;
  board?: string;
  models: string[];
  tokens: { in: number; out: number };
  costUsd: number;
  sttUsd: number;
  /** Calls with no price; their cost is not in costUsd. */
  unpriced: number;
};

export type Totals = { turns: number; costUsd: number; sttUsd: number; tokensIn: number; tokensOut: number; unpriced: number };

export type TurnsReport = { recent: TurnRow[]; today: Totals; week: Totals; since: string; estimate: string };

type Line = { role?: string; model?: string; usd?: number };
type Detail = {
  builder?: string;
  costUsd?: number;
  sttUsd?: number;
  unpriced?: number;
  models?: string[];
  tokens?: { in?: number; out?: number };
  cost?: { total?: { usd?: number; inputTokens?: number; outputTokens?: number; unpriced?: number }; models?: Line[] };
};

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** A chat-turn audit line as a row; lines written before the summary fields existed are read from their `cost`. */
export function turnRow(e: AuditEvent): TurnRow | null {
  if (e.action !== "chat-turn" || !e.detail) return null;
  let d: Detail;
  try {
    d = JSON.parse(e.detail) as Detail;
  } catch {
    return null;
  }
  const lines = d.cost?.models ?? [];
  const stt = lines.filter((m) => m.role === "speech").reduce((s, m) => s + (m.usd ?? 0), 0);
  const models = d.models ?? [...new Set(lines.map((m) => m.model).filter((m): m is string => !!m))];
  return {
    at: e.at,
    user: e.user,
    ...(e.board ? { board: e.board } : {}),
    models: models.length ? models : d.builder ? [d.builder] : [],
    tokens: { in: d.tokens?.in ?? d.cost?.total?.inputTokens ?? 0, out: d.tokens?.out ?? d.cost?.total?.outputTokens ?? 0 },
    costUsd: d.costUsd ?? d.cost?.total?.usd ?? 0,
    sttUsd: d.sttUsd ?? round(stt),
    unpriced: d.unpriced ?? d.cost?.total?.unpriced ?? 0,
  };
}

const empty = (): Totals => ({ turns: 0, costUsd: 0, sttUsd: 0, tokensIn: 0, tokensOut: 0, unpriced: 0 });
const add = (t: Totals, r: TurnRow) => {
  t.turns += 1;
  t.costUsd += r.costUsd;
  t.sttUsd += r.sttUsd;
  t.tokensIn += r.tokens.in;
  t.tokensOut += r.tokens.out;
  t.unpriced += r.unpriced;
};
const rounded = (t: Totals): Totals => ({ ...t, costUsd: round(t.costUsd), sttUsd: round(t.sttUsd) });

/**
 * The newest turns (newest first) and the totals for today (UTC) and the last 7 days, from audit
 * events newest first (AuditLog.since).
 */
export function turnsReport(events: AuditEvent[], now = new Date(), limit = 50): TurnsReport {
  const day = now.toISOString().slice(0, 10);
  const weekFrom = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const today = empty();
  const week = empty();
  const recent: TurnRow[] = [];
  for (const e of events) {
    const r = turnRow(e);
    if (!r || r.at < weekFrom) continue;
    add(week, r);
    if (r.at.startsWith(day)) add(today, r);
    if (recent.length < limit) recent.push(r);
  }
  return { recent, today: rounded(today), week: rounded(week), since: weekFrom, estimate: "Chat model costs are estimates from list prices; speech-to-text costs are what the provider reported." };
}
