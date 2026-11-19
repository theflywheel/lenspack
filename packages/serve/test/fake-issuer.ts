import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { type Server, createServer } from "node:http";

// A stand-in OpenID Connect provider on localhost, for tests: discovery, its
// own JWKS, the authorization endpoint (signs in whoever state.user is), and
// a token endpoint that checks the client secret, the redirect URI and PKCE.

export const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
};

// The identity provider: one RSA key, codes kept in memory, and switches that make it misbehave.
export function fakeIssuer() {
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

