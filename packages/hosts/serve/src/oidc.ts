import { type KeyObject, constants, createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthAdapter, Identity } from "./auth";
import { escapeHtml } from "./http";
import { cookie as makeCookie, cookies, safeReturn, sameSite, sealer } from "./session";

// Sign-in with an OpenID Connect provider (Keycloak, Entra ID, Google, any
// issuer with discovery), so a deployment needs no login proxy in front.
// The authorization code flow with PKCE: lenspack sends the browser to the
// issuer, takes the code back at /auth/callback, exchanges it for an ID
// token, checks that token's signature, issuer, audience, expiry and nonce,
// and keeps who the caller is (user, roles, tenant) in a signed cookie. Roles
// are read from the claims the config names, so groups, realm roles and
// client roles all work. Nothing is stored server side.

export type OidcOptions = {
  issuer: string;
  clientId: string;
  /** A confidential client's secret; absent for a public client (PKCE alone). */
  clientSecret?: string;
  /** Where lenspack is reached; the callback is <baseUrl>/auth/callback. */
  baseUrl: string;
  /** Signs the session cookie; 32+ characters. */
  sessionSecret: string;
  sessionHours: number;
  scopes: string[];
  /** The claim that names the user. */
  userClaim: string;
  /** Claims holding roles or groups, as dotted paths ("groups", "realm_access.roles"). */
  rolesClaims: string[];
  tenantClaim?: string;
  /** For tests: the clock, in ms. */
  now?: () => number;
};


type Meta = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string };
type Jwk = { kid?: string; kty: string; alg?: string; use?: string; [k: string]: unknown };

const SESSION = "lenspack_session";
const LOGIN = "lenspack_login";
const HINT = "lenspack_idt";
const SKEW_S = 60;
// A browser keeps a cookie up to about 4 KB with its name and attributes.
const MAX_COOKIE = 3800;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const random = (n: number) => b64url(randomBytes(n));

/** The signature algorithms accepted for an ID token. "none" and shared-secret (HS*) are not. */
const ALGS: Record<string, { hash: string | null; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  PS256: { hash: "sha256", pss: true },
  PS384: { hash: "sha384", pss: true },
  PS512: { hash: "sha512", pss: true },
  ES256: { hash: "sha256", ec: true },
  ES384: { hash: "sha384", ec: true },
  ES512: { hash: "sha512", ec: true },
  EdDSA: { hash: null },
};

export class TokenError extends Error {}

/**
 * The claims of a signed JWT, once its signature verifies with one of the
 * keys and its issuer, audience and expiry hold.
 */
export function verifyJwt(token: string, keys: Jwk[], expect: { issuer: string; audience: string; nowS: number }): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("not a signed JWT");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    throw new TokenError("unreadable JWT");
  }
  const alg = ALGS[header.alg ?? ""];
  if (!alg) throw new TokenError(`signature algorithm ${String(header.alg)} is not accepted`);
  const candidates = keys.filter((k) => k.use !== "enc" && (!header.kid || k.kid === header.kid) && (!k.alg || k.alg === header.alg));
  if (candidates.length === 0) throw new TokenError("no key of the issuer matches the token");
  const data = Buffer.from(`${h}.${p}`);
  const signature = Buffer.from(s, "base64url");
  const ok = candidates.some((jwk) => {
    let key: KeyObject;
    try {
      key = createPublicKey({ key: jwk as never, format: "jwk" });
    } catch {
      return false;
    }
    const opts = alg.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : alg.ec ? { key, dsaEncoding: "ieee-p1363" as const } : key;
    try {
      return verify(alg.hash, data, opts, signature);
    } catch {
      return false;
    }
  });
  if (!ok) throw new TokenError("the token's signature does not verify");
  if (claims.iss !== expect.issuer) throw new TokenError("the token is from another issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expect.audience)) throw new TokenError("the token is for another client");
  if (claims.azp !== undefined && claims.azp !== expect.audience) throw new TokenError("the token was issued to another client");
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < expect.nowS) throw new TokenError("the token has expired");
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > expect.nowS) throw new TokenError("the token is not valid yet");
  return claims;
}

/** A claim by dotted path ("realm_access.roles"); a key with a dot in it is matched whole first. */
export function claimAt(claims: Record<string, unknown>, path: string): unknown {
  if (path in claims) return claims[path];
  let here: unknown = claims;
  for (const part of path.split(".")) {
    if (!here || typeof here !== "object") return undefined;
    here = (here as Record<string, unknown>)[part];
  }
  return here;
}

/** Every role a set of claims carries: strings and arrays of strings under the named paths. */
export function rolesFrom(claims: Record<string, unknown>, paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const v = claimAt(claims, p);
    for (const r of Array.isArray(v) ? v : [v]) if (typeof r === "string" && r) out.add(r);
  }
  return [...out];
}

function page(res: ServerResponse, status: number, text: string, cookies: string[] = []) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) });
  res.end(`<!doctype html><meta charset="utf-8"><title>Sign-in</title><p>${escapeHtml(text)}</p><p><a href="/">Try again</a></p>`);
}

export function oidcSignIn(o: OidcOptions) {
  if (o.sessionSecret.length < 32) throw new Error("auth.oidc sessionSecret must be at least 32 characters");
  const now = o.now ?? Date.now;
  const base = o.baseUrl.replace(/\/+$/, "");
  const origin = new URL(base).origin;
  // The sign-in routes and cookies live at the root: a path prefix would break them, so it is refused.
  if (base !== origin) throw new Error("auth.oidc baseUrl must be an origin (https://host[:port]), with no path");
  const callback = `${base}/auth/callback`;
  const secure = base.startsWith("https:");
  // Compared exactly as written (some issuers end in "/"); only the discovery URL is built without the slash.
  const issuer = o.issuer;

  const { seal, unseal } = sealer(o.sessionSecret, now);
  const cookie = (name: string, value: string, path: string, maxAgeS: number) => makeCookie(name, value, { path, maxAgeS, secure });

  // Discovery and keys are fetched when first needed, so the server starts while the issuer is down.
  let meta: Promise<Meta> | null = null;
  const discover = () =>
    (meta ??= (async () => {
      const r = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`discovery answered ${r.status}`);
      const m = (await r.json()) as Meta;
      if (m.issuer !== issuer) throw new Error(`the issuer calls itself ${m.issuer}, not ${issuer}`);
      return m;
    })().catch((e) => {
      meta = null;
      throw e;
    }));
  let jwks: { keys: Jwk[]; at: number } | null = null;
  const keysFor = async (kid: string | undefined) => {
    // A key that is not known yet may be a rotation: fetch again, at most every 30 s.
    if (!jwks || (kid && !jwks.keys.some((k) => k.kid === kid) && now() - jwks.at > 30_000)) {
      const r = await fetch((await discover()).jwks_uri, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`the issuer's keys answered ${r.status}`);
      jwks = { keys: ((await r.json()) as { keys: Jwk[] }).keys ?? [], at: now() };
    }
    return jwks.keys;
  };

  async function login(res: ServerResponse, url: URL) {
    const m = await discover();
    const state = random(16);
    const nonce = random(16);
    const verifier = random(32);
    const auth = new URL(m.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: o.clientId,
      redirect_uri: callback,
      scope: o.scopes.join(" "),
      state,
      nonce,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    }))
      auth.searchParams.set(k, v);
    const sealed = seal("login", { state, nonce, verifier, ret: safeReturn(url.searchParams.get("return")) }, 600);
    res.writeHead(302, { location: auth.toString(), "cache-control": "no-store", "set-cookie": cookie(LOGIN, sealed, "/auth", 600) });
    res.end();
  }

  async function finish(req: IncomingMessage, res: ServerResponse, url: URL) {
    const clearLogin = cookie(LOGIN, "", "/auth", 0);
    const pending = unseal<{ state: string; nonce: string; verifier: string; ret: string }>("login", cookies(req)[LOGIN]);
    if (!pending || url.searchParams.get("state") !== pending.state) return page(res, 400, "This sign-in has expired or was started elsewhere.", [clearLogin]);
    const error = url.searchParams.get("error");
    if (error) return page(res, 401, `The identity provider did not sign you in (${error.slice(0, 80)}).`, [clearLogin]);
    const code = url.searchParams.get("code");
    if (!code) return page(res, 400, "The identity provider sent no code.", [clearLogin]);
    const m = await discover();
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callback, code_verifier: pending.verifier, client_id: o.clientId });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    // client_secret_basic, each part form-encoded first (RFC 6749 2.3.1).
    if (o.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString("base64")}`;
    const r = await fetch(m.token_endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(10_000) });
    const tokens = (await r.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!r.ok || !tokens.id_token) return page(res, 502, `The identity provider refused the code (${String(tokens.error ?? r.status).slice(0, 80)}).`, [clearLogin]);
    let claims: Record<string, unknown>;
    try {
      const kid = JSON.parse(Buffer.from(tokens.id_token.split(".")[0] ?? "", "base64url").toString("utf8") || "{}").kid as string | undefined;
      claims = verifyJwt(tokens.id_token, await keysFor(kid), { issuer, audience: o.clientId, nowS: Math.floor(now() / 1000) });
    } catch (e) {
      return page(res, 401, `The sign-in could not be checked: ${e instanceof Error ? e.message : String(e)}.`, [clearLogin]);
    }
    if (claims.nonce !== pending.nonce) return page(res, 401, "The sign-in could not be checked: the nonce does not match.", [clearLogin]);
    const user = claimAt(claims, o.userClaim);
    if (typeof user !== "string" || !user) return page(res, 401, `Your account has no ${o.userClaim}.`, [clearLogin]);
    const tenant = o.tenantClaim ? claimAt(claims, o.tenantClaim) : undefined;
    const session: Identity = { user, roles: rolesFrom(claims, o.rolesClaims), ...(typeof tenant === "string" && tenant ? { tenant } : {}) };
    const ttl = Math.round(o.sessionHours * 3600);
    const sealed = seal("session", session, ttl);
    if (sealed.length > MAX_COOKIE) return page(res, 500, "Your account carries too many roles to keep in a session. Narrow the roles claims or the identity provider's mapper.", [clearLogin]);
    const set = [clearLogin, cookie(SESSION, sealed, "/", ttl)];
    // The ID token goes back to the issuer at sign-out (id_token_hint), when it fits in a cookie.
    if (tokens.id_token.length <= MAX_COOKIE) set.push(cookie(HINT, tokens.id_token, "/auth/logout", ttl));
    res.writeHead(302, { location: pending.ret, "cache-control": "no-store", "set-cookie": set });
    res.end();
  }

  async function logout(req: IncomingMessage, res: ServerResponse) {
    const hint = cookies(req)[HINT];
    const clear = [cookie(SESSION, "", "/", 0), cookie(HINT, "", "/auth/logout", 0)];
    let to = `${base}/`;
    const m = await discover().catch(() => null);
    if (m?.end_session_endpoint) {
      const end = new URL(m.end_session_endpoint);
      end.searchParams.set("client_id", o.clientId);
      end.searchParams.set("post_logout_redirect_uri", `${base}/`);
      if (hint) end.searchParams.set("id_token_hint", hint);
      to = end.toString();
    }
    res.writeHead(302, { location: to, "cache-control": "no-store", "set-cookie": clear });
    res.end();
  }

  return {
    kind: "oidc",
    signOutUrl: "/auth/logout",
    /** Who the session cookie names, or null. A change from another site (its Origin) is not believed. */
    identify(req: IncomingMessage): Identity | null {
      if (!sameSite(req, origin)) return null;
      const s = unseal<Identity>("session", cookies(req)[SESSION]);
      return s && typeof s.user === "string" ? { user: s.user, roles: Array.isArray(s.roles) ? s.roles : [], ...(s.tenant ? { tenant: s.tenant } : {}) } : null;
    },
    /** Answers /auth/login, /auth/callback and /auth/logout; false for any other path. */
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (req.method !== "GET") return false;
      try {
        if (url.pathname === "/auth/login") await login(res, url);
        else if (url.pathname === "/auth/callback") await finish(req, res, url);
        else if (url.pathname === "/auth/logout") await logout(req, res);
        else return false;
      } catch (e) {
        page(res, 502, `The identity provider could not be reached: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
      }
      return true;
    },
    /** Where a page request without a session is sent. */
    signInPath(url: URL) {
      return `/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`;
    },
  };
}

export const oidcAdapter = (o: OidcOptions): AuthAdapter => oidcSignIn(o);
