import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { PASSWORD_ADMIN, type Principal, passwordAdmin } from "@lenspack/policy";

import type { AuditEvent } from "./audit";
import { escapeHtml, readBody } from "./http";
import { addressKey, attemptLimiter, passwordChecker, sessionKey, stateFolder } from "./password";
import { cookie, cookies, sameSite, sealer } from "./session";

// The admin pages' own sign-in, for a deployment whose admin access is "password" (@lenspack/policy, access.ts): one
// password from the deployment's secrets (LENSPACK_ADMIN_PASSWORD, or its scrypt hash in LENSPACK_ADMIN_PASSWORD_HASH),
// independent of the host's sign-in. It reuses the standalone server's password sign-in (password.ts): the equal-time
// check, the attempt limiter and the signed session. What differs: everything lives under the admin prefix, the
// session cookie is Secure, HttpOnly and SameSite=Strict and scoped to that prefix, every sign-in, failure and wait
// is in the audit log, and the one user is the password admin ("admin:password"), whom policy gives the admin role.

const SESSION = "lenspack_admin";
const DEVICE = "lenspack_admin_device";
const DEVICE_S = 400 * 86_400;

export type AdminSignInOptions = {
  /** Where the admin pages are on this server: /_admin. Sign-in at <prefix>/auth/login. */
  prefix: string;
  /** The state directory: the session key is kept there unless LENSPACK_ADMIN_SESSION_SECRET is set. */
  dir: string;
  env?: NodeJS.ProcessEnv;
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
  /** The password admin, when the request carries a live session; else null. */
  identify(req: IncomingMessage): Principal | null;
  /** Where a page request without a session goes. */
  signInPath(req: IncomingMessage, url: URL): string;
  /** The sign-out address, as browsers reach it. */
  signOutPath(req: IncomingMessage): string;
};

/** The sign-in, or why the surface is refused (no password set): the host then answers its pages with that reason. */
export function adminSignIn(o: AdminSignInOptions): AdminSignIn | { refused: string } {
  const env = o.env ?? process.env;
  const password = env.LENSPACK_ADMIN_PASSWORD || undefined;
  const passwordHash = password ? undefined : env.LENSPACK_ADMIN_PASSWORD_HASH || undefined;
  if (!password && !passwordHash)
    return { refused: "admin access is password (LENSPACK_ADMIN_ACCESS), but no admin password is set: set LENSPACK_ADMIN_PASSWORD (12+ characters) or LENSPACK_ADMIN_PASSWORD_HASH from the deployment's secrets, then restart" };
  const now = o.now ?? Date.now;
  const folder = stateFolder(o.dir);
  let checker: ReturnType<typeof passwordChecker>;
  try {
    checker = passwordChecker({ ...(password ? { password } : { passwordHash }), dir: o.dir }, folder);
  } catch (e) {
    return { refused: `the admin password cannot be used: ${e instanceof Error ? e.message : String(e)}` };
  }
  const secret = sessionKey(o.dir, env.LENSPACK_ADMIN_SESSION_SECRET || undefined, "admin-session.key", folder);
  const { seal, unseal } = sealer(secret, now);
  const hours = Number(env.LENSPACK_ADMIN_SESSION_HOURS);
  const ttl = Math.round((hours > 0 && hours <= 720 ? hours : 8) * 3600);
  const fingerprint = createHmac("sha256", secret).update(checker.material).digest().subarray(0, 12).toString("base64url");
  const limiter = attemptLimiter(now);
  const p = o.prefix;
  const at = (req: IncomingMessage) => `${o.publicBase(req)}${p}`;
  const audit = (action: string, outcome: "ok" | "denied", detail: string) => o.audit?.({ at: new Date(now()).toISOString(), user: PASSWORD_ADMIN, action, outcome, detail });

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

  function form(req: IncomingMessage, res: ServerResponse, status: number, ret: string, message = "", headers: Record<string, string> = {}) {
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
.err{color:var(--bad);font-size:14px}
</style>
<form method="post" action="${escapeHtml(`${at(req)}/auth/login`)}"><h1>${name} admin</h1><p class="sub">Sign in with the deployment's admin password.</p>${message ? `<p class="err" role="alert">${escapeHtml(message)}</p>` : ""}${insecure ? `<p class="err">Open this page over https: the sign-in cookie is not kept over plain http.</p>` : ""}
<label>Password <input name="password" type="password" autocomplete="current-password" autofocus required></label>
<input type="hidden" name="return" value="${escapeHtml(ret)}"><button>Sign in</button></form></html>`);
  }

  return {
    identify(req) {
      if (!sameSite(req)) return null;
      const s = unseal<{ f?: string }>("admin-surface-session", cookies(req)[SESSION]);
      return s?.f === fingerprint ? passwordAdmin() : null;
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
        if (!body || !sameSite(req)) {
          audit("admin sign-in", "denied", `from another site (${address})`);
          form(req, res, 400, ret, "This sign-in came from another site.");
          return true;
        }
        const device = unseal<{ d?: string }>("admin-device", cookies(req)[DEVICE])?.d;
        const known = !!device;
        const key = known ? `device:${device}` : `addr:${address}`;
        const tried = await limiter.attempt(key, known, () => checker.check(body.get("password") ?? ""));
        if ("waitS" in tried) {
          audit("admin sign-in", "denied", `too many tries; waiting ${tried.waitS} s (${address})`);
          form(req, res, 429, ret, `Too many tries. Wait ${tried.waitS} s.`, { "retry-after": String(tried.waitS) });
          return true;
        }
        if (!tried.ok) {
          audit("admin sign-in", "denied", `wrong password (${address})`);
          form(req, res, 401, ret, "Wrong password.");
          return true;
        }
        audit("admin sign-in", "ok", address);
        res.writeHead(303, {
          location: ret,
          "cache-control": "no-store",
          "set-cookie": [
            session(req, seal("admin-surface-session", { f: fingerprint }, ttl), ttl),
            cookie(DEVICE, seal("admin-device", { d: device ?? randomBytes(12).toString("base64url") }, DEVICE_S), { path: `${at(req)}/auth/`, maxAgeS: DEVICE_S, secure: true, sameSite: "Strict" }),
          ],
        });
        res.end();
        return true;
      }
      if (url.pathname === `${p}/auth/logout` && (req.method === "POST" || req.method === "GET")) {
        if (req.method === "POST" && !sameSite(req)) return false;
        if (unseal("admin-surface-session", cookies(req)[SESSION])) audit("admin sign-out", "ok", addressKey(o.clientAddress?.(req) ?? req.socket.remoteAddress));
        res.writeHead(303, { location: `${at(req)}/auth/login`, "cache-control": "no-store", "set-cookie": session(req, "", 0) });
        res.end();
        return true;
      }
      return false;
    },
  };
}
