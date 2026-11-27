import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// The signed cookies lenspack's own sign-ins keep: who the caller is, for a
// while, and nothing on the server. A value is sealed with its purpose and an
// expiry under an HMAC, so it cannot be altered, outlive its time, or pass
// for another kind of cookie.

export function sealer(secret: string, now: () => number = Date.now) {
  const mac = (s: string) => createHmac("sha256", secret).update(s).digest();
  return {
    seal(purpose: string, value: object, ttlS: number) {
      const body = Buffer.from(JSON.stringify({ ...value, p: purpose, exp: Math.floor(now() / 1000) + ttlS })).toString("base64url");
      return `${body}.${mac(body).toString("base64url")}`;
    },
    unseal<T>(purpose: string, sealed: string | undefined): T | null {
      if (!sealed) return null;
      const [body, sig] = sealed.split(".");
      if (!body || !sig) return null;
      const want = mac(body);
      const got = Buffer.from(sig, "base64url");
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      try {
        const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { p?: string; exp?: number };
        return v.p === purpose && typeof v.exp === "number" && v.exp > now() / 1000 ? (v as T) : null;
      } catch {
        return null;
      }
    },
  };
}

export function cookie(name: string, value: string, o: { path: string; maxAgeS: number; secure: boolean; sameSite?: "Lax" | "Strict" }) {
  return `${name}=${value}; Path=${o.path}; HttpOnly; SameSite=${o.sameSite ?? "Lax"}${o.secure ? "; Secure" : ""}; Max-Age=${o.maxAgeS}`;
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Whether a change request may ride on a session cookie: a browser names the
 * page that sent it in Origin, and one from another site is not believed.
 * Without a known origin, it must match the host the request was sent to, as
 * Host or as a proxy's X-Forwarded-Host (a page on another site cannot set
 * either).
 */
export function sameSite(req: IncomingMessage, origin?: string) {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const from = req.headers.origin;
  if (!from) return true;
  if (origin) return from === origin;
  try {
    const host = new URL(from).host;
    const forwarded = req.headers["x-forwarded-host"];
    return host === req.headers.host || (typeof forwarded === "string" && forwarded.split(",").some((h) => h.trim() === host));
  } catch {
    return false;
  }
}

// A return path stays on this server: one absolute path, never another origin
// or the sign-in itself. Control characters, spaces and backslashes are
// refused outright: a browser drops a tab from "/\t/x" and reads "//x".
export const safeReturn = (r: string | null) => (r && /^\/(?![/\\])/.test(r) && !/[\x00-\x20\x7f\\]/.test(r) && !r.startsWith("/auth/") ? r : "/");

