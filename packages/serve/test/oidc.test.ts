import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { seed } from "../../../examples/campaign/seed";
import { authFrom, authSchema, createApp, oidcSignIn, openConfig, readConfig, seedBoards, verifyJwt } from "../src";

// lenspack's own sign-in against a stand-in identity provider on localhost:
// discovery, the authorization code flow with PKCE, the ID token's checks,
// the session cookie, roles from claims into pack access, and sign-out.

const campaign = fileURLToPath(new URL("../../../examples/campaign/", import.meta.url));
const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
};

// The identity provider: one RSA key, codes kept in memory, and switches that make it misbehave.
function fakeIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string; claims: Record<string, unknown> }>();
  const state = {
    url: "",
    user: { preferred_username: "amina", groups: ["internal"] } as Record<string, unknown>,
    tamper: null as null | "signature" | "audience" | "expired" | "nonce" | "none" | "issuer",
    tokenCalls: [] as { auth?: string; body: URLSearchParams }[],
  };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const idToken = (claims: Record<string, unknown>) => {
    const header = { alg: state.tamper === "none" ? "none" : "RS256", kid: "k1", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const body = {
      iss: state.tamper === "issuer" ? `${state.url}/other` : state.url,
      aud: state.tamper === "audience" ? "someone-else" : "lenspack",
      iat: now,
      exp: state.tamper === "expired" ? now - 3600 : now + 300,
      sub: "u-1",
      ...claims,
      ...(state.tamper === "nonce" ? { nonce: "forged" } : {}),
    };
    const input = `${b64(header)}.${b64(body)}`;
    if (state.tamper === "none") return `${input}.`;
    return `${input}.${sign("sha256", Buffer.from(input), state.tamper === "signature" ? other : privateKey).toString("base64url")}`;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", state.url);
    const send = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
    if (url.pathname === "/.well-known/openid-configuration")
      return send(200, { issuer: state.url, authorization_endpoint: `${state.url}/auth`, token_endpoint: `${state.url}/token`, jwks_uri: `${state.url}/jwks`, end_session_endpoint: `${state.url}/logout` });
    if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
    if (url.pathname === "/auth") {
      // Signs in whoever state.user is, and sends the browser back with a code.
      const p = url.searchParams;
      if (p.get("response_type") !== "code" || p.get("client_id") !== "lenspack" || p.get("code_challenge_method") !== "S256") return send(400, { error: "invalid_request" });
      const code = randomBytes(8).toString("hex");
      codes.set(code, { nonce: p.get("nonce")!, challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")!, claims: { ...state.user } });
      res.writeHead(302, { location: `${p.get("redirect_uri")}?code=${code}&state=${p.get("state")}` });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      const body = new URLSearchParams(raw);
      state.tokenCalls.push({ auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Basic ${Buffer.from("lenspack:client-secret").toString("base64")}`) return send(401, { error: "invalid_client" });
      const grant = codes.get(body.get("code") ?? "");
      codes.delete(body.get("code") ?? "");
      if (!grant || grant.redirect !== body.get("redirect_uri")) return send(400, { error: "invalid_grant" });
      // PKCE: the verifier must hash to the challenge the browser carried.
      if (createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") !== grant.challenge) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: "at", token_type: "Bearer", id_token: idToken({ ...grant.claims, nonce: grant.nonce }) });
    }
    send(404, {});
  });
  return { server, state, jwk };
}

describe("sign-in with OpenID Connect", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-oidc-"));
  const idp = fakeIssuer();
  let lens: Server;
  let base: string;
  let close: () => Promise<void>;

  // A browser: follows nothing on its own, keeps cookies per name.
  let jar: Record<string, string> = {};
  const go = async (url: string, init: RequestInit = {}) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetch(url, { redirect: "manual", ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });
    for (const c of r.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [name, value] = [pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1)];
      if (attrs.some((a) => a.trim() === "Max-Age=0")) delete jar[name];
      else jar[name] = value;
    }
    return r;
  };
  // Signs in through the identity provider; the response lenspack's callback gave.
  const signIn = async (path = "/") => {
    const login = await go(`${base}/auth/login?return=${encodeURIComponent(path)}`);
    expect(login.status).toBe(302);
    const atIdp = await go(login.headers.get("location")!);
    expect(atIdp.status).toBe(302);
    return go(atIdp.headers.get("location")!);
  };

  beforeAll(async () => {
    idp.state.url = await listen(idp.server);
    const db = await openDuckdb(join(dir, "campaign.duckdb"));
    await seed(db.writer, "duckdb", { households: 500 });
    await db.close();
    const file = join(dir, "lenspack.yaml");
    writeFileSync(
      file,
      `sources:\n  data: { kind: duckdb, path: ${join(dir, "campaign.duckdb")} }\npacks:\n  - pack: ${campaign}pack.yaml\n    source: data\n    boards: ${campaign}boards\n    now: "2026-09-01T00:00:00Z"\n    access:\n      - roles: [internal]\n      - roles: [external]\n        hide: [delivered_by, not_delivered_reason]\nstore: { kind: memory }\n`,
    );
    const { config, dir: cfgDir } = readConfig(file);
    const opened = await openConfig(config, cfgDir);
    for (const h of opened.hosts) await seedBoards(h);
    close = opened.close;
    const ui = mkdtempSync(join(tmpdir(), "lenspack-ui-"));
    writeFileSync(join(ui, "index.html"), "<html><head><title>x</title></head><body>app</body></html>");
    // The port is known only once listening, and baseUrl names it: bind first, then hand the app over.
    lens = createServer();
    base = await listen(lens);
    const auth = authFrom(
      authSchema.parse({
        kind: "oidc",
        issuer: idp.state.url,
        clientId: "lenspack",
        clientSecret: "client-secret",
        baseUrl: base,
        sessionSecret: "s".repeat(40),
        rolesClaims: ["groups", "realm_access.roles"],
        editors: ["*"],
        maintainers: ["role:lenspack-maintainers"],
      }),
    );
    lens.on("request", createApp(opened.hosts, { ui, ...auth }));
  });
  afterAll(async () => {
    lens.close();
    idp.server.close();
    await close();
  });
  beforeEach(() => {
    jar = {};
    idp.state.tamper = null;
    idp.state.user = { preferred_username: "amina", groups: ["internal"] };
  });

  it("sends a page without a session to sign in, and answers the API 401", async () => {
    const page = await go(`${base}/boards/x?y=1`);
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`/auth/login?return=${encodeURIComponent("/boards/x?y=1")}`);
    expect((await go(`${base}/api/`)).status).toBe(401);
  });

  it("signs in with the code flow and PKCE, and keeps the user, roles and return path", async () => {
    const back = await signIn("/boards/x?y=1");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/boards/x?y=1");
    expect(jar.lenspack_session).toBeTruthy();
    expect(jar.lenspack_login).toBeUndefined();
    const call = idp.state.tokenCalls.at(-1)!;
    expect(call.body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(call.body.get("redirect_uri")).toBe(`${base}/auth/callback`);
    const index = await (await go(`${base}/api/`)).json();
    expect(index.me).toMatchObject({ user: "amina", edit: true, maintain: false, signOut: "/auth/logout" });
    expect(index.examples.map((e: { example: string }) => e.example)).toEqual(["campaign"]);
    expect((await go(`${base}/`)).status).toBe(200);
  });

  it("maps realm roles and groups into pack access and app rights", async () => {
    idp.state.user = { preferred_username: "ext", groups: ["external"], realm_access: { roles: ["lenspack-maintainers"] } };
    await signIn();
    const index = await (await go(`${base}/api/`)).json();
    expect(index.me).toMatchObject({ user: "ext", maintain: true, usage: true });
    const keys = (await (await go(`${base}/api/campaign`)).json()).catalogue.dimensions.map((d: { key: string }) => d.key);
    expect(keys).not.toContain("delivered_by");
    expect((await (await go(`${base}/api/campaign/overview/data`)).json()).not_delivered.error).toMatch(/not available/);
    // In no group a pack names: signed in, and shown nothing.
    jar = {};
    idp.state.user = { preferred_username: "stranger" };
    await signIn();
    expect((await (await go(`${base}/api/`)).json()).examples).toEqual([]);
    expect((await go(`${base}/api/campaign`)).status).toBe(404);
  });

  it("refuses an ID token that does not check out", async () => {
    for (const tamper of ["signature", "audience", "expired", "nonce", "none", "issuer"] as const) {
      jar = {};
      idp.state.tamper = tamper;
      const back = await signIn();
      expect(back.status, tamper).toBe(401);
      expect(jar.lenspack_session, tamper).toBeUndefined();
    }
  });

  it("refuses a callback it did not start, and a return path to another site", async () => {
    expect((await go(`${base}/auth/callback?code=x&state=y`)).status).toBe(400);
    const login = await go(`${base}/auth/login?return=${encodeURIComponent("//evil.example/")}`);
    const atIdp = await go(login.headers.get("location")!);
    // A state from elsewhere, with this browser's sign-in cookie, is still refused.
    const forged = atIdp.headers.get("location")!.replace(/state=[^&]+/, "state=forged");
    expect((await go(forged)).status).toBe(400);
    // A browser drops a tab or newline from a URL, so "/\t/evil" would read as "//evil".
    for (const evil of ["//evil.example/", "/\t/evil.example/", "/\\evil.example/", "/ /evil.example/"]) {
      jar = {};
      const back = await signIn(evil);
      expect(back.headers.get("location"), JSON.stringify(evil)).toBe("/");
    }
  });

  it("believes no altered session cookie, and no change from another site", async () => {
    await signIn();
    const good = jar.lenspack_session!;
    const [body, sig] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), r: ["internal"], user: "admin" })).toString("base64url");
    jar.lenspack_session = `${forged}.${sig}`;
    expect((await go(`${base}/api/`)).status).toBe(401);
    jar.lenspack_session = good;
    const create = (origin?: string) => go(`${base}/api/campaign/boards`, { method: "POST", body: "{}", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) } });
    expect((await create("https://evil.example")).status).toBe(401);
    expect((await create(base)).status).toBe(200);
  });

  it("signs out here and at the identity provider", async () => {
    await signIn();
    const out = await go(`${base}/auth/logout`);
    expect(out.status).toBe(302);
    const to = new URL(out.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(`${idp.state.url}/logout`);
    expect(to.searchParams.get("client_id")).toBe("lenspack");
    expect(to.searchParams.get("post_logout_redirect_uri")).toBe(`${base}/`);
    expect(to.searchParams.get("id_token_hint")).toMatch(/^ey/);
    expect(jar.lenspack_session).toBeUndefined();
    expect((await go(`${base}/api/`)).status).toBe(401);
  });

  it("ends a session after its hours, and wants a long secret", async () => {
    let clock = Date.now();
    const server = createServer();
    const at = await listen(server);
    const o = oidcSignIn({ issuer: idp.state.url, clientId: "lenspack", clientSecret: "client-secret", baseUrl: at, sessionSecret: "t".repeat(32), sessionHours: 1, scopes: ["openid"], userClaim: "preferred_username", rolesClaims: ["groups"], now: () => clock });
    server.on("request", createApp([], { signIn: o, access: (req) => (o.session(req) ? { user: o.session(req)!.user } : null) }));
    const was = base;
    base = at;
    try {
      await signIn();
      expect((await go(`${at}/api/`)).status).toBe(200);
      clock += 61 * 60_000;
      expect((await go(`${at}/api/`)).status).toBe(401);
    } finally {
      base = was;
      server.close();
    }
    expect(() => oidcSignIn({ issuer: "http://x", clientId: "c", baseUrl: "http://lens", sessionSecret: "short", sessionHours: 1, scopes: [], userClaim: "sub", rolesClaims: [] })).toThrow(/32 characters/);
    expect(() => oidcSignIn({ issuer: "http://x", clientId: "c", baseUrl: "http://lens/sub", sessionSecret: "s".repeat(32), sessionHours: 1, scopes: [], userClaim: "sub", rolesClaims: [] })).toThrow(/origin/);
  });
});

describe("verifyJwt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e1" } as { kty: string; kid: string };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (claims: Record<string, unknown>, alg = "ES256") => {
    const input = `${b64({ alg, kid: "e1" })}.${b64(claims)}`;
    return `${input}.${sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const expect_ = { issuer: "https://idp", audience: "c", nowS: 1000 };

  it("checks an ES256 signature, the audience list and azp", () => {
    expect(verifyJwt(token({ iss: "https://idp", aud: ["c", "x"], azp: "c", exp: 2000 }), [jwk], expect_)).toMatchObject({ aud: ["c", "x"] });
    expect(() => verifyJwt(token({ iss: "https://idp", aud: ["c", "x"], azp: "x", exp: 2000 }), [jwk], expect_)).toThrow(/another client/);
    expect(() => verifyJwt(token({ iss: "https://idp", aud: "c", azp: "x", exp: 2000 }), [jwk], expect_)).toThrow(/another client/);
    // An issuer ending in "/" is compared as written.
    expect(verifyJwt(token({ iss: "https://idp/", aud: "c", exp: 2000 }), [jwk], { ...expect_, issuer: "https://idp/" })).toMatchObject({ iss: "https://idp/" });
    expect(() => verifyJwt(token({ iss: "https://idp", aud: "c", exp: 2000 }, "HS256"), [jwk], expect_)).toThrow(/not accepted/);
    expect(() => verifyJwt(token({ iss: "https://idp", aud: "c", exp: 2000, nbf: 5000 }), [jwk], expect_)).toThrow(/not valid yet/);
  });
});
