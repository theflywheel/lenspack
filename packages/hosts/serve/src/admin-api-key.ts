import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";

import { type Principal, apiKeyAdmin, apiKeyNameOk } from "@lenspack/policy";

import type { AuditEvent } from "./audit";
import { type NamedSecret, type NamedSecretKind, addressKey, attemptLimiter, namedSecretsFrom, passwordChecker } from "./password";

// Admin API keys: a master override for administration from a script or a terminal (docs/access/admin-api.md). This
// file reads the keys from the environment and the key a request presents, compares them, and limits wrong tries. Which
// key matched is all it says: what that key may do is policy's (@lenspack/policy, access.ts: apiKeyAdmin, adminRights).
//
// Where the keys come from (adminApiKeysFrom), read by the same code as the named admin passwords:
//   LENSPACK_ADMIN_API_KEYS       name:secret pairs, separated by commas or new lines
//   LENSPACK_ADMIN_API_KEYS_FILE  a file with one name:secret per line (a Kubernetes Secret mounted as a file)
// A secret is 32 characters or more, or a scrypt hash ("scrypt$…", from `lenspack hash-password`). With none set, no key
// is accepted and the Authorization header means nothing, as before.
//
// A key is sent as "Authorization: Bearer <secret>", never in the address: a key in a query string is not read at all.

/** The shortest plain key: long enough that guessing one is hopeless, even at the rate limit. */
export const API_KEY_MIN_LENGTH = 32;

const ADMIN_API_KEY: NamedSecretKind = { a: "an admin API key", noun: "admin API key", minLength: API_KEY_MIN_LENGTH, nameOk: apiKeyNameOk };

/** One admin API key from the deployment: its name, the key or its hash, and where it was set. */
export type AdminApiKey = NamedSecret;

/** The admin API keys the environment sets, checked; throws naming the bad entry, never the secret. */
export function adminApiKeysFrom(env: NodeJS.ProcessEnv = process.env, read: (path: string) => string = (f) => readFileSync(f, "utf8")): AdminApiKey[] {
  return namedSecretsFrom(env, { ...ADMIN_API_KEY, list: "LENSPACK_ADMIN_API_KEYS", file: "LENSPACK_ADMIN_API_KEYS_FILE", read });
}

/**
 * What the request presents, read from its Authorization header only: null when it has none (the request is not about
 * a key), "" when the header is there but is not "Bearer <secret>".
 */
export function presentedKey(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (h === undefined) return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(h));
  return m ? m[1]! : "";
}

/** The outcome of checking a presented key: the key's principal, or a refusal with its status. */
export type KeyCheck = { who: Principal } | { status: 401 | 429; error: string; retryAfterS?: number };

export type AdminApiKeys = ReturnType<typeof adminApiKeys>;

/**
 * The keys in force: their names (for the log and the admin pages; never a secret), and the check a request's key goes
 * through. Every key is compared each time, in equal time for plain keys, so timing doesn't say which one matched. A
 * hashed key costs a scrypt check (tens of milliseconds); one that passed is remembered for a few minutes, keyed by a
 * keyed hash of the secret, so a script making many calls doesn't pay it on each. Wrong tries are limited per address as
 * the password sign-ins are (5 tries, then a doubling wait up to 15 minutes; 100 wrong tries in 10 minutes from anywhere
 * hold every new try), and each is in the audit log, without the key.
 */
export function adminApiKeys(o: { keys: readonly AdminApiKey[]; audit?: (e: AuditEvent) => void; log?: (line: string) => void; now?: () => number }) {
  const now = o.now ?? Date.now;
  const limiter = attemptLimiter(now);
  const plain = o.keys.filter((k) => k.password !== undefined).map((k) => ({ name: k.name, digest: createHash("sha256").update(k.password!).digest() }));
  const hashed = o.keys.filter((k) => k.passwordHash !== undefined).map((k) => ({ name: k.name, check: passwordChecker({ passwordHash: k.passwordHash, dir: "" }).check }));
  // Hashed keys that passed lately: keyed hash of the secret (with a key made at start) → name and until when.
  const remember = randomBytes(32);
  const passed = new Map<string, { name: string; until: number }>();
  const REMEMBER_MS = 5 * 60_000;
  const tag = (secret: string) => createHmac("sha256", remember).update(secret).digest("base64url");
  const sources = [...new Set(o.keys.map((k) => k.from))];

  /** The name of the key this secret is, or null. Plain keys are all compared, whatever matched first. */
  async function match(secret: string): Promise<string | null> {
    const d = createHash("sha256").update(secret).digest();
    let found: string | null = null;
    for (const k of plain) if (timingSafeEqual(d, k.digest) && found === null) found = k.name;
    if (found !== null || !hashed.length) return found;
    const t = tag(secret);
    const seen = passed.get(t);
    if (seen && seen.until > now() && hashed.some((k) => k.name === seen.name)) return seen.name;
    for (const k of hashed) if ((await k.check(secret)) && found === null) found = k.name;
    if (found !== null) {
      if (passed.size > 100) passed.clear();
      passed.set(t, { name: found, until: now() + REMEMBER_MS });
    }
    return found;
  }

  return {
    /** Whether any key is set: without one, nothing reads the Authorization header. */
    on: o.keys.length > 0,
    names: o.keys.map((k) => k.name),
    sources,
    /** The start-up line: how many keys and their names, never a secret. */
    line(): string {
      if (!o.keys.length) return "admin API keys: none (LENSPACK_ADMIN_API_KEYS and LENSPACK_ADMIN_API_KEYS_FILE are not set)";
      return `admin API keys: ${o.keys.length} (${o.keys.map((k) => k.name).join(", ")}) from ${sources.join(", ")}; admin routes only (through Superset: <root>/lenspack/_admin/…)`;
    },
    /**
     * Checks the key a request presents (presentedKey). `client` is the caller's address when a host in front vouches
     * for it (Superset's plugin signs it on the admin passthrough), so wrong tries count per caller, not against
     * Superset's one address; else the socket's.
     */
    async check(req: IncomingMessage, secret: string, client?: string): Promise<KeyCheck> {
      const address = addressKey(client ?? req.socket.remoteAddress);
      const audit = (user: string, outcome: "ok" | "denied", detail: string) => o.audit?.({ at: new Date(now()).toISOString(), user, action: "admin API key", outcome, detail });
      if (!secret) {
        audit("api:?", "denied", `no key in the Authorization header (${address})`);
        return { status: 401, error: "send the admin API key as Authorization: Bearer <key>" };
      }
      let name: string | null = null;
      const tried = await limiter.attempt(`addr:${address}`, false, async () => (name = await match(secret)) !== null);
      if ("waitS" in tried) {
        audit("api:?", "denied", `too many wrong keys; waiting ${tried.waitS} s (${address})`);
        o.log?.(`admin API key: too many wrong keys from ${address}; waiting ${tried.waitS} s`);
        return { status: 429, error: `Too many wrong keys. Wait ${tried.waitS} s.`, retryAfterS: tried.waitS };
      }
      if (!tried.ok || name === null) {
        audit("api:?", "denied", `wrong key (${address})`);
        o.log?.(`admin API key: a wrong key from ${address}`);
        return { status: 401, error: "not a valid admin API key" };
      }
      return { who: apiKeyAdmin(name) };
    },
  };
}
