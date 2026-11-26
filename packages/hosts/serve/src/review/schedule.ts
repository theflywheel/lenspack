// When the daily review runs: a local time of day in a time zone, computed fresh from the settings
// each time, so a change applies to the next run with no restart. The last slot that ran is kept
// on disk, so a server that was down when its slot came catches up once when it starts, and never
// runs the same slot twice. Plain timers, checked at least hourly: a clock change or a settings
// change is picked up within the hour, and at once when the settings page says so (reschedule).

/** "06:00" → [6, 0], or null. */
export function parseTime(s: string): [number, number] | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function validZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar fields of an instant in a zone. */
function fields(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: n("year"), mo: n("month"), d: n("day"), h: n("hour") % 24, mi: n("minute"), s: n("second") };
}

/** The zone's offset from UTC at an instant, in ms. */
function offset(at: Date, tz: string) {
  const f = fields(at, tz);
  return Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a local wall time happens in a zone (a time skipped by a clock change falls an hour later). */
export function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall - offset(new Date(wall), tz);
  t = wall - offset(new Date(t), tz);
  return new Date(t);
}

/** The latest slot at or before now, and the first after it. */
export function slots(time: string, tz: string, now: Date): { last: Date; next: Date } {
  const [h, mi] = parseTime(time) ?? [6, 0];
  const f = fields(now, tz);
  const today = zonedInstant(f.y, f.mo, f.d, h, mi, tz);
  const shift = (days: number) => {
    const base = new Date(Date.UTC(f.y, f.mo - 1, f.d + days));
    return zonedInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, mi, tz);
  };
  return today.getTime() <= now.getTime() ? { last: today, next: shift(1) } : { last: shift(-1), next: today };
}

export type SchedulerDeps = {
  now: () => Date;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** Read on every check. */
  enabled: () => boolean;
  when: () => { time: string; timeZone: string };
  /** The last slot handled (run, or passed while switched off), kept across restarts. */
  lastSlot: { get(): string | null; set(iso: string): void };
  run: (slot: Date) => Promise<unknown>;
  log?: (line: string) => void;
};

const HOUR = 3_600_000;

export function scheduler(d: SchedulerDeps) {
  let timer: unknown = null;
  let running: Promise<unknown> | null = null;
  let stopped = true;
  const arm = (ms: number) => {
    if (timer !== null) d.clearTimer(timer);
    timer = stopped ? null : d.setTimer(() => void check(), Math.max(1000, Math.min(ms, HOUR)));
  };
  /** Runs the latest slot if it is due and not yet handled; then waits for the next one. */
  async function check() {
    timer = null;
    if (stopped) return;
    const { time, timeZone } = d.when();
    const now = d.now();
    const { last, next } = slots(time, timeZone, now);
    const handled = d.lastSlot.get();
    if (!d.enabled() || handled === null) {
      // Off, or never run: slots that pass are not owed. Only a slot missed while on is caught up.
      d.lastSlot.set(last.toISOString());
    } else if (handled < last.toISOString() && !running) {
      d.lastSlot.set(last.toISOString());
      d.log?.(`daily review: running the ${last.toISOString()} slot${now.getTime() - last.getTime() > 5 * 60_000 ? " (catching up: the server was down when it came)" : ""}`);
      running = d.run(last).catch((e) => d.log?.(`daily review failed: ${e instanceof Error ? e.message : String(e)}`)).finally(() => (running = null));
      await running;
    }
    arm(next.getTime() - d.now().getTime());
  }
  return {
    start() {
      stopped = false;
      return check();
    },
    stop() {
      stopped = true;
      if (timer !== null) d.clearTimer(timer);
      timer = null;
    },
    /** The settings changed: look again now. */
    reschedule() {
      if (!stopped) arm(0);
    },
    next(): Date | null {
      if (!d.enabled()) return null;
      const { time, timeZone } = d.when();
      return slots(time, timeZone, d.now()).next;
    },
    check,
  };
}
