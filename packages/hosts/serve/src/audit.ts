import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// The audit log: one JSON line per board change, refused change, denied
// request, chat turn and settings change, with the user who made it. It is
// the durable record: the usage figures (GET /api/_usage) live in memory and
// reset on restart. fileAudit appends to one file; rotatingAudit keeps the
// current month in audit.jsonl, moves it to audit-YYYY-MM.jsonl on the first
// write of a new month, deletes months older than the retention, and reads
// itself back for a settings page (the log, and what chat has cost).

export type AuditEvent = { at: string; user: string; pack?: string; board?: string; action: string; outcome: "ok" | "refused" | "denied"; detail?: string; /** A turn about the server itself (the admin panel's usage chat): logged and costed, but left out of the daily review. */ internal?: boolean };
export type Audit = (event: AuditEvent) => void;

/** Appends one JSON line per event. */
export function fileAudit(path: string): Audit {
  return (event) => appendFileSync(path, `${JSON.stringify(event)}\n`);
}

/** The events at or after a time in one audit file (fileAudit's), newest first; an unreadable line is skipped. */
export function auditFileSince(path: string): (from: Date) => AuditEvent[] {
  return (from) => {
    if (!existsSync(path)) return [];
    const iso = from.toISOString();
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          const e = JSON.parse(l) as AuditEvent;
          return typeof e.at === "string" && e.at >= iso ? [e] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  };
}

export type AuditLog = {
  audit: Audit;
  /** The months on file, newest first ("current" is audit.jsonl). */
  months(): string[];
  /** The newest events of a month (default: the current one), newest first. */
  read(opts?: { month?: string; limit?: number }): AuditEvent[];
  /** Every event at or after `from`, across the monthly files, newest first. */
  since(from: Date): AuditEvent[];
  /** The file the current month is written to. */
  file: string;
  retentionDays: number;
};

const month = (d: Date) => d.toISOString().slice(0, 7);
const ARCHIVE = /^audit-(\d{4}-\d{2})\.jsonl$/;

export function rotatingAudit(dir: string, opts: { retentionDays?: number; now?: () => Date } = {}): AuditLog {
  mkdirSync(dir, { recursive: true });
  const now = opts.now ?? (() => new Date());
  const retentionDays = opts.retentionDays ?? 90;
  const file = join(dir, "audit.jsonl");

  // Which month audit.jsonl holds: its first line's date, else its last change.
  const monthOfCurrent = (): string | null => {
    if (!existsSync(file)) return null;
    try {
      const first = readFileSync(file, "utf8").split("\n", 1)[0];
      if (first) return month(new Date(JSON.parse(first).at));
    } catch {
      /* unreadable line: fall back to the file's time */
    }
    return month(statSync(file).mtime);
  };

  const prune = () => {
    const cutoff = now().getTime() - retentionDays * 86_400_000;
    for (const name of readdirSync(dir)) {
      const m = ARCHIVE.exec(name);
      if (!m) continue;
      // A month is kept until its last day is older than the retention.
      const [y, mo] = m[1]!.split("-").map(Number);
      const end = Date.UTC(y!, mo!, 1) - 1;
      if (end < cutoff) unlinkSync(join(dir, name));
    }
  };

  let current = monthOfCurrent();
  const rotate = () => {
    const m = month(now());
    if (current && current !== m) {
      const target = join(dir, `audit-${current}.jsonl`);
      if (existsSync(target)) appendFileSync(target, readFileSync(file)), unlinkSync(file);
      else renameSync(file, target);
      prune();
    }
    current = m;
  };
  prune();

  const audit: Audit = (event) => {
    try {
      rotate();
      appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    } catch {
      /* the audit log must never take a request down with it */
    }
  };

  const parse = (path: string): AuditEvent[] =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [JSON.parse(l) as AuditEvent];
            } catch {
              return [];
            }
          })
      : [];

  return {
    audit,
    file,
    retentionDays,
    months: () => {
      const archived = readdirSync(dir)
        .map((n) => ARCHIVE.exec(n)?.[1])
        .filter((m): m is string => !!m)
        .sort()
        .reverse();
      return [...(existsSync(file) ? ["current"] : []), ...archived];
    },
    since: (from) => {
      const iso = from.toISOString();
      const first = month(from);
      // audit.jsonl holds the current month; archives are named by theirs.
      const paths = [file, ...readdirSync(dir).filter((n) => (ARCHIVE.exec(n)?.[1] ?? "") >= first).map((n) => join(dir, n))];
      return paths
        .flatMap(parse)
        .filter((e) => typeof e.at === "string" && e.at >= iso)
        .sort((a, b) => b.at.localeCompare(a.at));
    },
    read: ({ month: m, limit = 200 } = {}) => {
      if (m && m !== "current" && !/^\d{4}-\d{2}$/.test(m)) throw new Error(`month must be YYYY-MM, not "${m}"`);
      const path = !m || m === "current" || m === current ? file : join(dir, `audit-${m}.jsonl`);
      return parse(path).reverse().slice(0, Math.max(1, Math.min(limit, 5000)));
    },
  };
}

// What chat has cost, from the audit log: each chat-turn line carries the turn's cost (an estimate
// from list prices for the chat models, plus what the speech provider charged for a spoken question).

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
  /** What the turn's data calls asked, in plain words (its "how this was worked out"), when it read any. */
  explained?: string[];
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
  card?: { calls?: { description?: unknown }[] };
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
    ...explainedOf(d),
  };
}

/** The descriptions of a turn's data calls, from its explanation; the statements and rows stay in the audit line. */
const explainedOf = (d: Detail): { explained?: string[] } => {
  const words = (Array.isArray(d.card?.calls) ? d.card.calls : []).map((c) => c?.description).filter((w): w is string => typeof w === "string");
  return words.length ? { explained: words } : {};
};

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
