import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import type { AuthAdapter, Identity } from "./auth";
import { cookie, cookies, escapeHtml, safeReturn, sameSite, sealer } from "./session";

// The sign-in a deployment gets when it names no other: one built-in user,
// admin, with a password. lenspack keeps no other users; for people with their
// own accounts, use oidc (or a login proxy). The password comes from the
// environment (plain, or as a scrypt hash); with neither, one is made at first
// start, only its hash is kept, and the password itself is written once to a
// file only the server's user can read.

export const ADMIN = "admin";
const SESSION = "lenspack_session";
const DEVICE = "lenspack_device";
const MIN_LENGTH = 12;
// scrypt at N=2^15, r=8: about 32 MiB and tens of milliseconds per try.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** A password as "scrypt$N$r$p$salt$hash" (base64url), for LENSPACK_ADMIN_PASSWORD_HASH. */
export function hashPassword(password: string, salt = randomBytes(16)): string {
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

function parseHash(stored: string) {
  const [kind, n, rs, ps, s, h] = stored.trim().split("$");
  const [N, r, p] = [Number(n), Number(rs), Number(ps)];
  const salt = Buffer.from(s ?? "", "base64url");
  const hash = Buffer.from(h ?? "", "base64url");
  // Every part is bounded: an empty hash would match anything, and a huge cost would stall the server.
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (kind !== "scrypt" || !int(N, 1 << 14, 1 << 20) || (N & (N - 1)) !== 0 || !int(r, 1, 16) || !int(p, 1, 4) || N * r > 1 << 22 || salt.length < 16 || hash.length !== 32) throw new Error("a password hash must be scrypt$N$r$p$salt$hash, as `lenspack hash-password` writes it");
  return { N, r, p, salt, hash };
}

function verifyHash(password: string, stored: ReturnType<typeof parseHash>): Promise<boolean> {
  return new Promise((resolve) =>
    scrypt(password, stored.salt, stored.hash.length, { N: stored.N, r: stored.r, p: stored.p, maxmem: 128 * stored.N * stored.r * 2 + 1024 * 1024 }, (err, key) =>
      resolve(!err && key.length === stored.hash.length && timingSafeEqual(key, stored.hash)),
    ),
  );
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export type PasswordOptions = {
  /** The admin password itself (LENSPACK_ADMIN_PASSWORD), 12+ characters. */
  password?: string;
  /** Or its hash (LENSPACK_ADMIN_PASSWORD_HASH). */
  passwordHash?: string;
  /** Where a made password's hash, its one-time file and the session key are kept. */
  dir: string;
  /** The address people use (https://lens.example.com): changes must come from it, and an https one marks the cookie Secure. */
  baseUrl?: string;
  /** Signs the session cookie; absent, a key kept in dir. */
  sessionSecret?: string;
  sessionHours: number;
  log?: (line: string) => void;
  now?: () => number;
};

/** A file only this user may read, never over an existing one (or a link planted in its place). */
const writePrivate = (path: string, data: string) => writeFileSync(path, data, { mode: 0o600, flag: "wx" });

/** Whether anything is at path, a dangling link included. */
const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Refuses a state file or folder another user could have planted or may change. */
function checkOwn(path: string, what: "dir" | "file") {
  const st = lstatSync(path);
  const uid = process.getuid?.();
  if (st.isSymbolicLink() || (what === "dir" ? !st.isDirectory() : !st.isFile())) throw new Error(`${path} must be a plain ${what === "dir" ? "folder" : "file"}, not a link`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${path} must belong to the user lenspack runs as`);
  if (st.mode & 0o022) throw new Error(`${path} must not be writable by others`);
}

export function passwordAdapter(o: PasswordOptions): AuthAdapter & { kind: "password" } {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const origin = o.baseUrl ? new URL(o.baseUrl).origin : undefined;
  let checked = false;
  const ensureDir = () => {
    if (!checked) {
      try {
        if (!existsSync(o.dir)) {
          mkdirSync(o.dir, { recursive: true, mode: 0o700 });
          // So the folder is never committed by accident with the config next to it.
          writeFileSync(join(o.dir, ".gitignore"), "*\n", { mode: 0o600 });
        }
      } catch (e) {
        throw new Error(`cannot write the sign-in state to ${o.dir} (${(e as Error).message}); set LENSPACK_STATE_DIR or auth.dir to a writable folder, or LENSPACK_ADMIN_PASSWORD`);
      }
      checkOwn(o.dir, "dir");
      checked = true;
    }
  };
  const readOwn = (path: string) => {
    checkOwn(path, "file");
    return readFileSync(path, "utf8");
  };

  // How the password is checked: against the plain one given, or a hash.
  // The password's fingerprint goes into each session, so a new password ends every session made with the old one.
  let check: (attempt: string) => Promise<boolean>;
  let fingerprint: string;
  if (o.password !== undefined) {
    if (o.password.length < MIN_LENGTH) throw new Error(`the admin password must be at least ${MIN_LENGTH} characters`);
    const want = digest(o.password);
    check = async (attempt) => timingSafeEqual(digest(attempt), want);
    fingerprint = digest(`password:${want.toString("hex")}`).subarray(0, 12).toString("base64url");
  } else {
    let stored = o.passwordHash;
    if (stored === undefined) {
      const hashFile = join(o.dir, "admin-password.hash");
      if (!present(hashFile)) {
        ensureDir();
        const made = randomBytes(18).toString("base64url");
        const plainFile = join(o.dir, "admin-password.txt");
        // The password file first, then the hash, renamed into place whole: a crash
        // between leaves no hash, and the next start makes a new pair.
        rmSync(plainFile, { force: true });
        writePrivate(plainFile, `${made}\n`);
        const tmp = `${hashFile}.${process.pid}.tmp`;
        rmSync(tmp, { force: true });
        writePrivate(tmp, `${hashPassword(made)}\n`);
        renameSync(tmp, hashFile);
        log(`made a password for ${ADMIN}; it is in ${plainFile}, readable by this user only. Read it, then delete the file. Set LENSPACK_ADMIN_PASSWORD to choose one.`);
      }
      ensureDir();
      stored = readOwn(hashFile);
    }
    const parsed = parseHash(stored);
    check = (attempt) => verifyHash(attempt, parsed);
    fingerprint = digest(`hash:${parsed.hash.toString("hex")}`).subarray(0, 12).toString("base64url");
  }

  let secret = o.sessionSecret;
  if (secret === undefined) {
    const keyFile = join(o.dir, "session.key");
    ensureDir();
    if (!present(keyFile)) writePrivate(keyFile, randomBytes(32).toString("hex"));
    secret = readOwn(keyFile).trim();
  }
  if (secret.length < 32) throw new Error("the session secret must be at least 32 characters");
  const { seal, unseal } = sealer(secret, now);
  const ttl = Math.round(o.sessionHours * 3600);

  // Brute force. Each try counts as a failure before the password is checked
  // (a burst sent at once cannot slip past); success forgets them. After
  // five failures, a caller waits longer for each (1 s, doubling, at most 15
  // minutes); failures are forgotten after an hour without one. A caller is
  // its address, or, once it has signed in on this browser, the device cookie
  // set then: an attacker sharing the address (behind a proxy, everyone does)
  // cannot hold the admin's own browser up. Few passwords are checked at once,
  // so a flood cannot take the server's memory or threads.
  const tries = new Map<string, { fails: number; until: number; last: number }>();
  const MAX_CHECKING = 4;
  let checking = 0;
  const waitFor = (key: string) => {
    const t = now();
    const mine = tries.get(key);
    if (mine && t - mine.last > 60 * 60_000) tries.delete(key);
    return mine && mine.until > t ? mine.until - t : 0;
  };
  const failed = (key: string) => {
    const t = now();
    const mine = tries.get(key) ?? { fails: 0, until: 0, last: t };
    mine.fails++;
    mine.last = t;
    if (mine.fails >= 5) mine.until = t + Math.min(1000 * 2 ** (mine.fails - 5), 15 * 60_000);
    tries.set(key, mine);
    // Old entries go, so the map cannot grow without end.
    if (tries.size > 10_000) for (const [k, v] of tries) if (t - v.last > 60 * 60_000 || tries.size > 10_000) tries.delete(k);
  };

  const secureFor = (req: IncomingMessage) => origin?.startsWith("https:") || !!(req.socket as { encrypted?: boolean }).encrypted || req.headers["x-forwarded-proto"] === "https";
  const sessionCookie = (req: IncomingMessage, value: string, maxAgeS: number) => cookie(SESSION, value, { path: "/", maxAgeS, secure: secureFor(req) });
  const DEVICE_S = 400 * 86_400;

  function form(res: ServerResponse, status: number, ret: string, message = "", headers: Record<string, string> = {}) {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      ...headers,
    });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0 16px}form{display:grid;gap:12px;width:min(320px,100%)}input,button{font:inherit;padding:8px}p{margin:0;color:#b00}</style>
<form method="post" action="/auth/login"><h1>Sign in</h1>${message ? `<p role="alert">${escapeHtml(message)}</p>` : ""}
<label>User <input name="user" value="${ADMIN}" readonly></label>
<label>Password <input name="password" type="password" autocomplete="current-password" autofocus required></label>
<input type="hidden" name="return" value="${escapeHtml(ret)}"><button>Sign in</button></form></html>`);
  }

  const readForm = (req: IncomingMessage) =>
    new Promise<URLSearchParams>((resolve, reject) => {
      let s = "";
      req.on("data", (c) => {
        s += c;
        if (s.length > 4096) req.destroy(new Error("too large"));
      });
      req.on("end", () => resolve(new URLSearchParams(s)));
      req.on("error", reject);
    });

  return {
    kind: "password",
    signOutUrl: "/auth/logout",
    identify(req) {
      if (!sameSite(req, origin)) return null;
      // Its own purpose: an OIDC session under the same secret, even for a user named admin, is not this one.
      const s = unseal<{ user?: string; f?: string }>("admin-session", cookies(req)[SESSION]);
      return s?.user === ADMIN && s.f === fingerprint ? admin() : null;
    },
    async handle(req, res, url) {
      if (url.pathname === "/auth/login" && req.method === "GET") {
        form(res, 200, safeReturn(url.searchParams.get("return")));
        return true;
      }
      if (url.pathname === "/auth/login" && req.method === "POST") {
        const body = await readForm(req).catch(() => null);
        const ret = safeReturn(body?.get("return") ?? null);
        if (!body || !sameSite(req, origin)) {
          form(res, 400, ret, "This sign-in came from another site.");
          return true;
        }
        const device = unseal<{ d?: string }>("device", cookies(req)[DEVICE])?.d;
        const key = device ? `device:${device}` : `addr:${req.socket.remoteAddress ?? "?"}`;
        const wait = waitFor(key);
        // While waiting, the password is not even checked: a right guess then teaches nothing.
        // A known device is not held up by others' checks in flight.
        if (wait > 0 || (!device && checking >= MAX_CHECKING)) {
          const s = Math.max(1, Math.ceil(wait / 1000));
          form(res, 429, ret, `Too many tries. Wait ${s} s.`, { "retry-after": String(s) });
          return true;
        }
        failed(key);
        checking++;
        let ok: boolean;
        try {
          ok = (body.get("user") ?? ADMIN) === ADMIN && (await check(body.get("password") ?? ""));
        } finally {
          checking--;
        }
        if (!ok) {
          form(res, 401, ret, "Wrong password.");
          return true;
        }
        tries.delete(key);
        res.writeHead(303, {
          location: ret,
          "cache-control": "no-store",
          "set-cookie": [
            sessionCookie(req, seal("admin-session", { user: ADMIN, f: fingerprint }, ttl), ttl),
            cookie(DEVICE, seal("device", { d: device ?? randomBytes(12).toString("base64url") }, DEVICE_S), { path: "/auth/login", maxAgeS: DEVICE_S, secure: secureFor(req) }),
          ],
        });
        res.end();
        return true;
      }
      if (url.pathname === "/auth/logout" && req.method === "GET") {
        res.writeHead(302, { location: "/", "cache-control": "no-store", "set-cookie": sessionCookie(req, "", 0) });
        res.end();
        return true;
      }
      return false;
    },
    signInPath: (url) => `/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`,
  };
}

/** The one built-in user: every right, and the role admin for pack rules to match. */
const admin = (): Identity => ({ user: ADMIN, roles: [ADMIN], edit: true, maintain: true, usage: true });
