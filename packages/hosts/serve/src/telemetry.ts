import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type TelemetryLine, type TelemetryOptions, type TelemetryQuery, type TelemetryStore, switchDefaults, itemsOn, turnTelemetry } from "@lenspack/agent";

import { rotatingLog } from "./audit";
import { writeWhole } from "./settings";

// Usage telemetry's storage on one machine: the log in telemetry.jsonl in the state directory, kept by month like
// the audit log, and working state in telemetry-state.json beside it. What is recorded, and when, is
// @lenspack/agent's (telemetry.ts); this is only where. A database-backed TelemetryStore takes its place for
// several copies of Lenspack: the same two parts, with take() atomic.

/** Lines this recent are also kept in memory, so the turn path and the sweep never read the files. */
const WINDOW_MS = 48 * 3_600_000;

export type FileTelemetryStore = TelemetryStore & { file: string; readonly retentionDays: number; months(): string[] };

export function fileTelemetryStore(o: { dir: string; retentionDays?: () => number; now?: () => Date }): FileTelemetryStore {
  const now = o.now ?? (() => new Date());
  const log = rotatingLog<TelemetryLine>(o.dir, "telemetry", { retentionDays: o.retentionDays ?? (() => 90), now });
  // The window, oldest first, read back from the files at start.
  let recent: TelemetryLine[] = log.since(new Date(now().getTime() - WINDOW_MS)).reverse();
  const trim = () => {
    const cut = new Date(now().getTime() - WINDOW_MS).toISOString();
    let i = 0;
    while (i < recent.length && recent[i]!.at < cut) i++;
    if (i) recent = recent.slice(i);
  };

  // Working state: small, short-lived, written whole on each change so a restart picks it up.
  const stateFile = join(o.dir, "telemetry-state.json");
  type Entry = { value: unknown; until: number };
  let state: Record<string, Entry> = {};
  try {
    state = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, Entry>) : {};
  } catch {
    state = {};
  }
  const live = () => {
    const t = now().getTime();
    for (const [k, e] of Object.entries(state)) if (e.until <= t) delete state[k];
    return state;
  };
  const save = () => {
    mkdirSync(o.dir, { recursive: true });
    writeWhole(stateFile, JSON.stringify(live()));
  };

  const matches = (q: TelemetryQuery) => {
    const from = q.from.toISOString();
    const to = q.to?.toISOString();
    return (l: TelemetryLine) => l.at >= from && (!to || l.at <= to) && (!q.type || l.type === q.type) && (!q.user || l.user === q.user) && (!q.turnId || ("turnId" in l && l.turnId === q.turnId));
  };

  return {
    file: log.file,
    get retentionDays() {
      return log.retentionDays;
    },
    months: () => log.months(),
    async append(line) {
      log.append(line);
      recent.push(line);
      trim();
    },
    async find(q) {
      const inWindow = q.from.getTime() >= now().getTime() - WINDOW_MS;
      return (inWindow ? [...recent].reverse() : log.since(q.from)).filter(matches(q));
    },
    state: {
      async get<T>(key: string) {
        return (live()[key]?.value as T | undefined) ?? null;
      },
      async put(key, value, ttlMs) {
        live()[key] = { value, until: now().getTime() + ttlMs };
        save();
      },
      async take<T>(key: string) {
        const e = live()[key];
        if (!e) return null;
        delete state[key];
        save();
        return e.value as T;
      },
      async list<T>(prefix: string) {
        return Object.entries(live())
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, e]) => ({ key, value: e.value as T }));
      },
    },
  };
}

/**
 * The key questions are hashed under: made once, kept beside the log (mode 600), never written into it. Equal texts
 * share a hash, and nobody without the key can test a guess against one.
 */
export function keyedHash(dir: string): (text: string) => string {
  mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, "telemetry.key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const key = readFileSync(keyFile, "utf8").trim();
  return (text) => createHmac("sha256", key).update(text).digest("hex").slice(0, 24);
}

/** Telemetry kept in a state directory: the file store and the keyed hash, with the rest of the options as given. */
export function fileTelemetry(dir: string, opts: Omit<TelemetryOptions, "store" | "hash"> & { retentionDays?: () => number } = {}) {
  const store = fileTelemetryStore({ dir, retentionDays: opts.retentionDays, now: opts.now });
  return { store, telemetry: turnTelemetry({ ...opts, store, hash: keyedHash(dir) }) };
}

/**
 * The items a config's telemetry section turns on, for a server with no settings page to change them: the
 * catalogue's defaults, then telemetry.groups and telemetry.items. Unknown names are refused.
 */
export function staticItems(c: { groups?: Record<string, boolean>; items?: Record<string, boolean>; questionText?: boolean }): () => ReadonlySet<string> {
  const d = switchDefaults();
  for (const k of Object.keys(c.groups ?? {})) if (!(k in d.groups)) throw new Error(`telemetry.groups.${k} is not a telemetry section; see docs/telemetry.md`);
  for (const k of Object.keys(c.items ?? {})) if (!(k in d.items)) throw new Error(`telemetry.items.${k} is not a telemetry item with a switch; see docs/telemetry.md`);
  const on = itemsOn({ telemetry: true, groups: { ...d.groups, ...c.groups }, items: { ...d.items, ...(c.questionText !== undefined ? { "question-text": c.questionText } : {}), ...c.items } }, { voice: true, cache: true, clarify: true });
  return () => on;
}
