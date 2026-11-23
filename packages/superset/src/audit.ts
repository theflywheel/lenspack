// The audit log: one JSON line per board change, refused change, denied request, chat turn and
// settings change, with the Superset user who made it. It is the durable record: the usage figures
// (GET /api/_usage) live in memory and reset on restart.
//
// The current month is audit.jsonl; on the first write of a new month it becomes audit-YYYY-MM.jsonl,
// and months older than the retention are deleted.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { Audit, AuditEvent } from "@lenspack/serve";

export type AuditLog = {
  audit: Audit;
  /** The months on file, newest first ("current" is audit.jsonl). */
  months(): string[];
  /** The newest events of a month (default: the current one), newest first. */
  read(opts?: { month?: string; limit?: number }): AuditEvent[];
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
    read: ({ month: m, limit = 200 } = {}) => {
      if (m && m !== "current" && !/^\d{4}-\d{2}$/.test(m)) throw new Error(`month must be YYYY-MM, not "${m}"`);
      const path = !m || m === "current" || m === current ? file : join(dir, `audit-${m}.jsonl`);
      return parse(path).reverse().slice(0, Math.max(1, Math.min(limit, 5000)));
    },
  };
}
