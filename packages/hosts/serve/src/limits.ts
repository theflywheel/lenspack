// Per-person question limits (docs/features/limits.md): the counters the host keeps, and the settings they are read
// against. What is allowed is decided in @lenspack/policy (decideQuestion); this file only counts.
//
//   - The rolling windows (per minute, per hour) are kept in memory: a restart forgets them, which at worst lets a
//     person ask one window's worth again. Every question that is let through counts, a saved answer too.
//   - Today's quota counts questions that reach the model, and is kept in limits.json in the state directory (file mode
//     600, like usage.jsonl), so a restart does not hand everyone a new day. A question takes a place in it when it is
//     let through, so many at once cannot all slip under the quota; the place is kept when the question goes to the
//     model, and given back when it is answered from a saved answer, turned away by a full queue, or fails before that.
//   - Refusals are counted per person for the admin pages; the audit log has each one.

import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { LIMIT_KEYS, type LimitDecision, type LimitKey, type LimitRefusal, type PerUserLimits, type QuestionLimits, decideQuestion, limitsFor, limitsOn, perUserLimitsFrom, questionLimitsFrom } from "@lenspack/policy";

import type { SettingsStore } from "./settings";
import { writeWhole } from "./settings";

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
const HOUR_MS = 3_600_000;

/** LENSPACK_LIMIT_QUESTIONS_PER_DAY, LENSPACK_LIMIT_PER_MINUTE, LENSPACK_LIMIT_PER_HOUR and LENSPACK_LIMIT_ADMINS_EXEMPT, where set. */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): PerUserLimits {
  const names: Record<LimitKey, string> = { questionsPerDay: "LENSPACK_LIMIT_QUESTIONS_PER_DAY", perMinute: "LENSPACK_LIMIT_PER_MINUTE", perHour: "LENSPACK_LIMIT_PER_HOUR" };
  const raw: Record<string, unknown> = {};
  for (const k of LIMIT_KEYS) {
    const v = env[names[k]]?.trim();
    if (v) raw[k] = Number(v);
  }
  const out: PerUserLimits = questionLimitsFrom(raw, "LENSPACK_LIMIT_*");
  const exempt = env.LENSPACK_LIMIT_ADMINS_EXEMPT?.trim().toLowerCase();
  if (exempt) {
    if (["true", "on", "1", "yes"].includes(exempt)) out.adminsExempt = true;
    else if (["false", "off", "0", "no"].includes(exempt)) out.adminsExempt = false;
    else throw new Error("LENSPACK_LIMIT_ADMINS_EXEMPT is true or false");
  }
  return out;
}

/**
 * The limits in force: the deployment's (the config's `limits.perUser`, then LENSPACK_LIMIT_*, which win), then an
 * admin's changes on the settings page (settings.json, section "limits"), which win over both. Off by default.
 */
export function limitSettings(settings: SettingsStore | null, config?: unknown, env: NodeJS.ProcessEnv = process.env) {
  const fromConfig = perUserLimitsFrom(config);
  const defaults: PerUserLimits = { ...fromConfig, ...limitsFromEnv(env) };
  const saved = () => settings?.get<PerUserLimits>("limits") ?? {};
  const get = (): PerUserLimits => ({ ...defaults, ...saved() });
  return {
    get,
    view: (writable: boolean) => {
      const now = get();
      return { questionsPerDay: now.questionsPerDay ?? 0, perMinute: now.perMinute ?? 0, perHour: now.perHour ?? 0, adminsExempt: !!now.adminsExempt, users: now.users ?? {}, on: limitsOn(now), defaults, source: Object.keys(saved()).length ? "settings" : "default", writable };
    },
    /** Any of questionsPerDay, perMinute, perHour (0: no limit), adminsExempt, users; null puts one back to the deployment's value. */
    update(body: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
      if (!settings) return { ok: false, error: "settings cannot be changed on this server" };
      const next: Record<string, unknown> = { ...saved() };
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === null) delete next[k];
        else set[k] = v;
      }
      for (const k of Object.keys(body)) if (![...LIMIT_KEYS, "adminsExempt", "users"].includes(k)) return { ok: false, error: `limits: unknown setting "${k}" (${[...LIMIT_KEYS, "adminsExempt", "users"].join(", ")})` };
      try {
        Object.assign(next, perUserLimitsFrom(set, "limits"));
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      settings.set("limits", Object.keys(next).length ? next : undefined);
      return { ok: true };
    },
    /** For the start-up log and the settings log line. */
    line: () => limitsLine(get()),
  };
}
export type LimitSettings = ReturnType<typeof limitSettings>;

/** "limits per person: off", or what each person may ask and whether admins are held to it. */
export function limitsLine(l: PerUserLimits): string {
  if (!limitsOn(l)) return "limits per person: off";
  const parts = [l.questionsPerDay ? `${l.questionsPerDay} questions a day (UTC)` : null, l.perHour ? `${l.perHour} an hour` : null, l.perMinute ? `${l.perMinute} a minute` : null].filter(Boolean);
  const named = Object.keys(l.users ?? {}).length;
  return `limits per person: ${parts.length ? parts.join(", ") : "none for everyone"}${named ? `; ${named} named ${named === 1 ? "person" : "people"} with their own` : ""}; admins ${l.adminsExempt ? "exempt" : "not exempt"}`;
}

/** A question let through: its place in today's quota is kept (charge) or given back (release); the first call settles it. */
export type LimitPlace = { charge(): void; release(): void };

type PersonDay = { questions: number; refused: number; lastRefused?: { at: string; limit: LimitKey } };
type DayFile = { day: string; users: Record<string, PersonDay> };

/** One person's line on the admin pages. */
export type LimitRow = {
  user: string;
  /** Questions counted against today's quota (including any running now). */
  today: number;
  lastMinute: number;
  lastHour: number;
  /** Their limits (0: none). */
  limits: Required<QuestionLimits>;
  /** At a limit now: their next question would be refused (unless they are an exempt admin). */
  atLimit: LimitKey | null;
  refusedToday: number;
  lastRefused: { at: string; limit: LimitKey } | null;
};

/**
 * The counters. With a file, today's counts are read back at start and written as they change; without one (no state
 * directory), they are kept in memory only.
 */
export function limitCounter(o: { limits: () => PerUserLimits; file?: string; now?: () => number; log?: (line: string) => void }) {
  const now = o.now ?? Date.now;
  const recent = new Map<string, number[]>();
  const pending = new Map<string, number>();
  let data: DayFile = { day: dayOf(now()), users: {} };
  if (o.file) {
    mkdirSync(dirname(o.file), { recursive: true });
    if (existsSync(o.file)) {
      try {
        const read = JSON.parse(readFileSync(o.file, "utf8")) as DayFile;
        if (read && read.day === data.day && read.users && typeof read.users === "object") data = read;
        chmodSync(o.file, 0o600);
      } catch (e) {
        o.log?.(`limits: could not read ${o.file} (${e instanceof Error ? e.message : String(e)}); today's counts start from zero`);
      }
    }
  }
  // A refusal changes only the admin pages' counts: written soon, not at once, so a script hammering away cannot keep the disk busy.
  let soon: NodeJS.Timeout | null = null;
  const write = () => {
    if (soon) clearTimeout(soon);
    soon = null;
    if (!o.file) return;
    try {
      writeWhole(o.file, JSON.stringify(data), 0o600);
    } catch (e) {
      o.log?.(`limits: could not save today's counts to ${o.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const writeSoon = () => {
    if (!o.file || soon) return;
    soon = setTimeout(write, 5000);
    soon.unref?.();
  };
  /** Today's record, a new day starting from zero. */
  const today = () => {
    const d = dayOf(now());
    if (data.day !== d) {
      data = { day: d, users: {} };
      pending.clear();
    }
    return data;
  };
  const person = (user: string) => (today().users[user] ??= { questions: 0, refused: 0 });
  const recentOf = (user: string, at: number) => {
    const kept = (recent.get(user) ?? []).filter((t) => t > at - HOUR_MS);
    if (kept.length) recent.set(user, kept);
    else recent.delete(user);
    return kept;
  };
  const counted = (user: string) => (today().users[user]?.questions ?? 0) + (pending.get(user) ?? 0);
  const rowOf = (user: string, at: number, limits: PerUserLimits): LimitRow => {
    const times = recentOf(user, at);
    const p = today().users[user];
    const d = decideQuestion(limits, { user, admin: false, today: counted(user), recent: times, now: at });
    return {
      user,
      today: counted(user),
      lastMinute: times.filter((t) => t > at - 60_000).length,
      lastHour: times.length,
      limits: limitsFor(limits, user),
      atLimit: d.ok ? null : d.limit,
      refusedToday: p?.refused ?? 0,
      lastRefused: p?.lastRefused ?? null,
    };
  };

  return {
    /** Whether any limit is set now. */
    on: () => limitsOn(o.limits()),
    /**
     * Before any model or data call: may this person ask now? Let through, the question counts in the windows and
     * takes a place in today's quota (the place settles it). Refused, nothing is counted but the refusal.
     */
    admit(who: { user: string; admin: boolean }): { ok: true; place: LimitPlace } | LimitRefusal {
      const at = now();
      const limits = o.limits();
      const d: LimitDecision = decideQuestion(limits, { user: who.user, admin: who.admin, today: counted(who.user), recent: recentOf(who.user, at), now: at });
      if (!d.ok) {
        const p = person(who.user);
        p.refused += 1;
        p.lastRefused = { at: new Date(at).toISOString(), limit: d.limit };
        writeSoon();
        return d;
      }
      recent.set(who.user, [...recentOf(who.user, at), at]);
      const day = today().day;
      pending.set(who.user, (pending.get(who.user) ?? 0) + 1);
      let settled = false;
      const settle = (charge: boolean) => {
        if (settled) return;
        settled = true;
        // A question begun yesterday is not today's.
        if (today().day !== day) return;
        const n = (pending.get(who.user) ?? 1) - 1;
        if (n > 0) pending.set(who.user, n);
        else pending.delete(who.user);
        if (!charge) return;
        person(who.user).questions += 1;
        write();
      };
      return { ok: true, place: { charge: () => settle(true), release: () => settle(false) } };
    },
    /**
     * Who is at a limit now or was refused today (all: everyone counted today), most refused first, then most asked.
     * For the admin pages and the usage report.
     */
    report(opts: { all?: boolean } = {}) {
      const at = now();
      const limits = o.limits();
      const users = new Set([...Object.keys(today().users), ...pending.keys(), ...recent.keys()]);
      const rows = [...users].map((u) => rowOf(u, at, limits)).filter((r) => opts.all || r.atLimit || r.refusedToday > 0);
      rows.sort((a, b) => b.refusedToday - a.refusedToday || b.today - a.today || a.user.localeCompare(b.user));
      return { day: today().day, on: limitsOn(limits), limits, people: rows, counted: users.size, kept: o.file ? "file" : "memory" };
    },
    /** One person's counts for today, and their rolling windows, back to zero (an admin's choice). False: nothing was counted. */
    clear(user: string): boolean {
      const had = !!today().users[user] || recent.has(user);
      delete today().users[user];
      recent.delete(user);
      if (had) write();
      return had;
    },
    /** Writes any refusal counts not yet saved (at shutdown, and in tests). */
    flush: write,
    file: o.file ?? null,
  };
}
export type LimitCounter = ReturnType<typeof limitCounter>;
