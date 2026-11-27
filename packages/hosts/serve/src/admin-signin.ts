import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type Principal, passwordAdmin, passwordNameOk, passwordUser } from "@lenspack/policy";

import type { AuditEvent } from "./audit";
import { escapeHtml, readBody } from "./http";
import { type NamedSecret, type NamedSecretKind, addressKey, attemptLimiter, namedSecret, namedSecretsFrom, passwordChecker, sessionKey, stateFolder } from "./password";
import { cookie, cookies, sameSite, sealer } from "./session";

// The admin pages' own sign-in, for a deployment whose admin access includes "password" (@lenspack/policy, access.ts):
// named passwords from the deployment's secrets, each person signing in with their name and their own password, and
// named "admin:<name>" in the audit log. Independent of the host's sign-in. It reuses the standalone server's password
// sign-in (password.ts): the equal-time check, the attempt limiter and the signed session. What differs: everything
// lives under the admin prefix, the session cookie is Secure, HttpOnly and SameSite=Strict and scoped to that prefix,
// tries are limited per name as well as per browser, every sign-in, failure and wait is in the audit log, and policy
// gives the admin role to a name only while it is on the list (passwordAdmin, adminRights).
//
// Where the passwords come from (adminPasswordsFrom):
//   LENSPACK_ADMIN_PASSWORDS       name:secret pairs, separated by commas or new lines (a secret here can't hold a comma)
//   LENSPACK_ADMIN_PASSWORDS_FILE  a file with one name:secret per line, any characters (a Kubernetes Secret mounted as a
//                                  file); blank lines and lines starting with # are skipped
//   LENSPACK_ADMIN_PASSWORD        one unnamed password, as before: the name "password", "admin:password" in the log
//   LENSPACK_ADMIN_PASSWORD_HASH   the same, as a scrypt hash
// A secret that starts with "scrypt$" is a hash (`lenspack hash-password`). A secret is 12 characters or more. Removing
// a person is removing their line and restarting: their session ends, since their name is no longer on the list.

/** One admin password from the deployment: its name, the password or its hash, and where it was set. */
export type AdminPassword = NamedSecret;

/** Admin passwords, in words, for namedSecretsFrom: 12 characters or more, named like a password (passwordNameOk). */
const ADMIN_PASSWORD: NamedSecretKind = { a: "an admin password", noun: "password", nameOk: passwordNameOk };

/**
 * The admin passwords the environment sets, checked. Throws on a line that isn't name:secret, a bad or repeated name, or
 * a secret that can't be used, naming where it is (never the secret), so a mistake stops the server at start.
 */
export function adminPasswordsFrom(env: NodeJS.ProcessEnv = process.env, read: (path: string) => string = (f) => readFileSync(f, "utf8")): AdminPassword[] {
  const out = namedSecretsFrom(env, { ...ADMIN_PASSWORD, list: "LENSPACK_ADMIN_PASSWORDS", file: "LENSPACK_ADMIN_PASSWORDS_FILE", read });
  const unnamed = env.LENSPACK_ADMIN_PASSWORD ? (["LENSPACK_ADMIN_PASSWORD", env.LENSPACK_ADMIN_PASSWORD] as const) : env.LENSPACK_ADMIN_PASSWORD_HASH ? (["LENSPACK_ADMIN_PASSWORD_HASH", env.LENSPACK_ADMIN_PASSWORD_HASH.trim()] as const) : null;
  if (unnamed) out.push(namedSecret(out, "password", unnamed[1], unnamed[0], ADMIN_PASSWORD, ' (LENSPACK_ADMIN_PASSWORD is the name "password")'));
  return out;
}

const SESSION = "lenspack_admin";
const DEVICE = "lenspack_admin_device";
const DEVICE_S = 400 * 86_400;

export type AdminSignInOptions = {
  /** Where the admin pages are on this server: /_admin. Sign-in at <prefix>/auth/login. */
  prefix: string;
  /** The state directory: the session key is kept there unless LENSPACK_ADMIN_SESSION_SECRET is set. */
  dir: string;
  env?: NodeJS.ProcessEnv;
  /** The admin passwords (adminPasswordsFrom); read from env when absent. */
  passwords?: AdminPassword[];
  /** Where browsers reach this server ("/superset/lenspack", or "" at its own address), for the cookie's path and links. */
  publicBase: (req: IncomingMessage) => string;
  /** The caller's address, when a host in front vouches for it (Superset's plugin signs it); else the socket's. */
  clientAddress?: (req: IncomingMessage) => string | undefined;
  audit?: (e: AuditEvent) => void;
  /** What the assistant is called, for the sign-in page's title. */
  name?: () => string;
  log?: (line: string) => void;
  now?: () => number;
};

export type AdminSignIn = {
  /** The sign-in paths: <prefix>/auth/login (GET the form, POST a try) and <prefix>/auth/logout. False for any other. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** The password admin signed in, when the request carries a live session for a name still on the list; else null. */
  identify(req: IncomingMessage): Principal | null;
  /** Where a page request without a session goes. */
  signInPath(req: IncomingMessage, url: URL): string;
  /** The sign-out address, as browsers reach it. */
  signOutPath(req: IncomingMessage): string;
};

/** The sign-in, or why it is refused (no password set): the host then answers its pages with that reason. */
export function adminSignIn(o: AdminSignInOptions): AdminSignIn | { refused: string } {
  const env = o.env ?? process.env;
  let list: AdminPassword[];
  try {
    list = o.passwords ?? adminPasswordsFrom(env);
  } catch (e) {
    return { refused: e instanceof Error ? e.message : String(e) };
  }
  if (!list.length)
    return { refused: "admin access includes password (LENSPACK_ADMIN_ACCESS), but no admin password is set: set LENSPACK_ADMIN_PASSWORDS (name:secret pairs) or LENSPACK_ADMIN_PASSWORDS_FILE from the deployment's secrets, then restart" };
  const now = o.now ?? Date.now;
  const folder = stateFolder(o.dir);
  const secret = sessionKey(o.dir, env.LENSPACK_ADMIN_SESSION_SECRET || undefined, "admin-session.key", folder);
  // Each name's checker and fingerprint: a session is for one name and one secret; a new secret ends its sessions.
  const byName = new Map<string, { check: (attempt: string) => Promise<boolean>; fingerprint: string }>();
  for (const p of list) {
    let checker: ReturnType<typeof passwordChecker>;
    try {
      checker = passwordChecker(p.password !== undefined ? { password: p.password, dir: o.dir } : { passwordHash: p.passwordHash, dir: o.dir }, folder);
    } catch (e) {
      return { refused: `${p.from}: the password named "${p.name}" can't be used: ${e instanceof Error ? e.message : String(e)}` };
    }
    byName.set(p.name, { check: checker.check, fingerprint: createHmac("sha256", secret).update(`${p.name}\0`).update(checker.material).digest().subarray(0, 12).toString("base64url") });
  }
  // A name that isn't on the list still costs one equal-time comparison, so a wrong name and a wrong password look alike.
  const decoy = randomBytes(32);
  const unknownCheck = async (attempt: string) => (timingSafeEqual(createHmac("sha256", decoy).update(attempt).digest(), decoy), false);
  const unnamed = byName.has("password");
  const { seal, unseal } = sealer(secret, now);
  const hours = Number(env.LENSPACK_ADMIN_SESSION_HOURS);
  const ttl = Math.round((hours > 0 && hours <= 720 ? hours : 8) * 3600);
  const limiter = attemptLimiter(now);
  const p = o.prefix;
  const at = (req: IncomingMessage) => `${o.publicBase(req)}${p}`;
  /** The audit log's user for a name typed in: "admin:<name>" when it could be one, else "admin:?" (never raw input). */
  const userFor = (name: string) => (passwordNameOk(name) ? passwordUser(name === "password" ? undefined : name) : "admin:?");
  const audit = (user: string, action: string, outcome: "ok" | "denied", detail: string) => o.audit?.({ at: new Date(now()).toISOString(), user, action, outcome, detail });

  /** Its own base path, so a return address can only lead back to an admin page, never to the sign-in itself. */
  const safeReturn = (req: IncomingMessage, r: string | null) => {
    const home = `${at(req)}/`;
    return r && r.startsWith(home) && !/[\x00-\x20\x7f\\]/.test(r) && !r.slice(home.length).startsWith("auth/") && !r.includes("/../") ? r : home;
  };
  const https = (req: IncomingMessage) => !!(req.socket as { encrypted?: boolean }).encrypted || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim() === "https";
  const loopback = (req: IncomingMessage) => {
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]!.trim().replace(/:\d+$/, "");
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  };
  const session = (req: IncomingMessage, value: string, maxAgeS: number) => cookie(SESSION, value, { path: `${at(req)}/`, maxAgeS, secure: true, sameSite: "Strict" });

  function form(req: IncomingMessage, res: ServerResponse, status: number, ret: string, message = "", headers: Record<string, string> = {}, typed = "") {
    const name = escapeHtml(o.name?.() ?? "Lenspack");
    // The cookie is Secure: over plain http (other than this machine) a browser drops it, so say so before anyone types.
    const insecure = !https(req) && !loopback(req);
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      ...headers,
    });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${name} admin · Sign in</title>
<style>
:root{--bg:#f4f6f7;--card:#fff;--fg:#17212b;--mute:#5b6773;--line:#d9e0e5;--acc:#0e6f86;--bad:#b3361f;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f1418;--card:#161d22;--fg:#e4eaee;--mute:#93a1ad;--line:#2a353e;--acc:#5ec0d6;--bad:#f08b78;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
form{width:min(360px,100%);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:28px 28px 24px;display:grid;gap:16px}
h1{font-size:20px;margin:0;letter-spacing:-.01em}p{margin:0}.sub{color:var(--mute);font-size:13px;margin-top:-10px}
label{display:grid;gap:6px;font-size:13px;color:var(--mute)}input{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:9px 11px}
input:focus-visible,button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
button{font:inherit;font-weight:600;border:0;border-radius:6px;padding:10px 14px;background:var(--acc);color:#fff;cursor:pointer}
.err{color:var(--bad);font-size:14px}.hint{font-size:12px;color:var(--mute)}
</style>
<form method="post" action="${escapeHtml(`${at(req)}/auth/login`)}"><h1>${name} admin</h1><p class="sub">Sign in with your name and admin password.</p>${message ? `<p class="err" role="alert">${escapeHtml(message)}</p>` : ""}${insecure ? `<p class="err">Open this page over https: the sign-in cookie is not kept over plain http.</p>` : ""}
<label>Name <input name="name" autocomplete="username" value="${escapeHtml(typed)}" ${unnamed ? "" : "required "}${typed ? "" : "autofocus"}>${unnamed ? `<span class="hint">Leave empty for the deployment's shared password.</span>` : ""}</label>
<label>Password <input name="password" type="password" autocomplete="current-password" ${typed ? "autofocus " : ""}required></label>
<input type="hidden" name="return" value="${escapeHtml(ret)}"><button>Sign in</button></form></html>`);
  }

  return {
    identify(req) {
      if (!sameSite(req)) return null;
      const s = unseal<{ f?: string; n?: string }>("admin-surface-session", cookies(req)[SESSION]);
      const entry = s?.n ? byName.get(s.n) : undefined;
      return entry && s!.f === entry.fingerprint ? passwordAdmin(s!.n) : null;
    },
    signInPath: (req, url) => `${at(req)}/auth/login?return=${encodeURIComponent(`${o.publicBase(req)}${url.pathname}${url.search}`)}`,
    signOutPath: (req) => `${at(req)}/auth/logout`,
    async handle(req, res, url) {
      if (url.pathname === `${p}/auth/login` && req.method === "GET") {
        form(req, res, 200, safeReturn(req, url.searchParams.get("return")));
        return true;
      }
      if (url.pathname === `${p}/auth/login` && req.method === "POST") {
        const body = await readBody(req, 4096).then((b) => new URLSearchParams(b.toString("utf8")), () => null);
        const ret = safeReturn(req, body?.get("return") ?? null);
        const address = addressKey(o.clientAddress?.(req) ?? req.socket.remoteAddress);
        const typed = (body?.get("name") ?? "").trim().slice(0, 80);
        const name = typed || (unnamed ? "password" : "");
        const user = userFor(name);
        if (!body || !sameSite(req)) {
          audit(user, "admin sign-in", "denied", `from another site (${address})`);
          form(req, res, 400, ret, "This sign-in came from another site.");
          return true;
        }
        const entry = byName.get(name);
        // Tries count per browser (its device cookie once it has signed in, else its address) and per name, so guessing
        // one person's password from many addresses is held up too. A browser that signed in as this name before is
        // not held up by the name's count, so someone hammering a name can't lock its owner out.
        const dev = unseal<{ d?: string; n?: string[] }>("admin-device", cookies(req)[DEVICE]);
        const known = !!dev?.d;
        const keys = [{ key: known ? `device:${dev!.d}` : `addr:${address}`, known }];
        if (!dev?.n?.includes(name)) keys.push({ key: `name:${passwordNameOk(name) ? name : "?"}`, known: true });
        const tried = await limiter.attemptAll(keys, () => (entry ? entry.check(body.get("password") ?? "") : unknownCheck(body.get("password") ?? "")));
        if ("waitS" in tried) {
          audit(user, "admin sign-in", "denied", `too many tries; waiting ${tried.waitS} s (${address})`);
          form(req, res, 429, ret, `Too many tries. Wait ${tried.waitS} s.`, { "retry-after": String(tried.waitS) }, typed);
          return true;
        }
        if (!tried.ok) {
          audit(user, "admin sign-in", "denied", `${entry ? "wrong password" : "no such name"} (${address})`);
          form(req, res, 401, ret, "Wrong name or password.", {}, typed);
          return true;
        }
        audit(user, "admin sign-in", "ok", address);
        const names = [...new Set([...(dev?.n ?? []), name])].slice(-5);
        res.writeHead(303, {
          location: ret,
          "cache-control": "no-store",
          "set-cookie": [
            session(req, seal("admin-surface-session", { f: entry!.fingerprint, n: name }, ttl), ttl),
            cookie(DEVICE, seal("admin-device", { d: dev?.d ?? randomBytes(12).toString("base64url"), n: names }, DEVICE_S), { path: `${at(req)}/auth/`, maxAgeS: DEVICE_S, secure: true, sameSite: "Strict" }),
          ],
        });
        res.end();
        return true;
      }
      if (url.pathname === `${p}/auth/logout` && (req.method === "POST" || req.method === "GET")) {
        if (req.method === "POST" && !sameSite(req)) return false;
        const was = unseal<{ n?: string }>("admin-surface-session", cookies(req)[SESSION]);
        if (was) audit(userFor(was.n ?? "password"), "admin sign-out", "ok", addressKey(o.clientAddress?.(req) ?? req.socket.remoteAddress));
        res.writeHead(303, { location: `${at(req)}/auth/login`, "cache-control": "no-store", "set-cookie": session(req, "", 0) });
        res.end();
        return true;
      }
      return false;
    },
  };
}
