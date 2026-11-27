// Starting while Superset may not be there yet. Every start-up step that talks to Superset (signing in, reading the
// datasets, reading the dashboards) is tried until it works, with waits that grow to a minute and then stay there,
// for as long as it takes: Superset down, restarting, answering 5xx, refusing the service sign-in (401/403) or
// closing the connection are all things that heal, and a server that exits on them only adds Kubernetes' own
// growing waits (CrashLoopBackOff) to Superset's. Meanwhile the address answers /healthz (alive) and /readyz (not
// ready, and why).
//
// A mistake no wait fixes stops the start at once instead, with what to change: it is thrown as a StartupConfigError
// (a dataset name Superset says doesn't exist, two datasets with one name, no way to make Lenspack's account). Bad
// YAML and bad settings are found before Superset is asked anything, so they stop the start at once too.

import { unreachableReason } from "@lenspack/engine";

import { SupersetError } from "./client";

/** A start-up mistake in the deployment's config that no wait fixes: the server stops with it. */
export class StartupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupConfigError";
  }
}

/** The waits between start-up tries: 2, 5, 10, 30, then 60 s for as long as it takes. */
export const STARTUP_WAITS_MS = [2000, 5000, 10_000, 30_000, 60_000];

/** LENSPACK_STARTUP_RETRY_SECONDS (comma-separated seconds; the last repeats), else STARTUP_WAITS_MS. */
export function startupWaits(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.LENSPACK_STARTUP_RETRY_SECONDS?.trim();
  if (!raw) return STARTUP_WAITS_MS;
  const waits = raw.split(",").map((s) => Number(s.trim()));
  if (!waits.length || waits.some((w) => !Number.isFinite(w) || w <= 0 || w > 3600))
    throw new StartupConfigError(`LENSPACK_STARTUP_RETRY_SECONDS must be seconds between 0 and 3600, separated by commas (like 2,5,10,30,60), not "${raw}"`);
  return waits.map((w) => Math.round(w * 1000));
}

/** The error under a failed fetch(): undici puts the socket's own error (code, message) in cause. */
function causeOf(e: unknown): { code?: string; message?: string } {
  const c = (e as { cause?: { code?: string; message?: string } } | null)?.cause;
  return c && typeof c === "object" ? c : {};
}

/**
 * Whether a request to Superset failed in a way that passes by itself: no connection, a connection dropped or closed
 * mid-answer, no answer in time, or a 5xx (Superset or a proxy in front of it restarting).
 */
export function transient(e: unknown): boolean {
  if (e instanceof SupersetError) return e.status >= 500 || e.status === 429;
  if (!(e instanceof Error)) return false;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  const text = `${e.message} ${causeOf(e).code ?? ""} ${causeOf(e).message ?? ""}`;
  return /fetch failed|other side closed|socket|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR/i.test(text);
}

/** What went wrong, in a few plain words for the log and /readyz (no addresses beyond Superset's own messages). */
export function startupCause(e: unknown): string {
  if (e instanceof SupersetError) {
    if (e.status >= 500) return `Superset answered ${e.status} (not up yet, or restarting)`;
    if (/sign-in failed/i.test(e.message)) return `Superset refused the service sign-in (${e.status}): check the account and its password, or wait for Superset to finish starting`;
    return e.message;
  }
  if (!(e instanceof Error)) return String(e);
  if (e.name === "TimeoutError" || e.name === "AbortError") return "Superset did not answer in time";
  const inner = `${causeOf(e).code ?? ""} ${causeOf(e).message ?? ""}`;
  if (/other side closed|UND_ERR_SOCKET|ECONNRESET|socket hang up/i.test(`${e.message} ${inner}`)) return "Superset closed the connection mid-answer";
  if (/fetch failed/i.test(e.message)) return `Superset is unreachable${unreachableReason(inner) ? ` (${unreachableReason(inner)})` : ""}`;
  return e.message;
}

/**
 * Runs one start-up step until it works. A StartupConfigError stops at once; anything else is logged as one line (the
 * step, the cause, the next wait) and tried again after the next wait, the last wait repeating, forever. `waiting`
 * hears the same words, for /readyz.
 */
export async function untilItWorks<T>(
  what: string,
  step: () => Promise<T>,
  o: { log: (line: string) => void; waits?: number[]; sleep?: (ms: number) => Promise<void>; waiting?: (why: string) => void },
): Promise<T> {
  const waits = o.waits?.length ? o.waits : STARTUP_WAITS_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      const done = await step();
      if (i) o.log(`${what}: worked on try ${i + 1}`);
      return done;
    } catch (e) {
      if (e instanceof StartupConfigError) throw e;
      const wait = waits[Math.min(i, waits.length - 1)]!;
      const why = `${what} failed: ${startupCause(e)}`;
      o.log(`${why}; trying again in ${wait / 1000} s (try ${i + 1}; the server stays up, not ready)`);
      o.waiting?.(`${why}; trying again in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}
