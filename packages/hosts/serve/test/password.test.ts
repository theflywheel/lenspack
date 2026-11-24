import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seed } from "../../../../examples/campaign/seed";
import { type AuthConfig, addressKey, authFrom, claim, authSchema, createApp, effectiveAuth, hashPassword, openConfig, passwordAdapter, readConfig, seedBoards } from "../src";
import { listen } from "./fake-issuer";

// The default sign-in: the built-in admin and a password. The page, the
// session cookie, brute-force backoff, a password made at first start, and
// the same rights and pack rules as every other adapter.

const campaign = fileURLToPath(new URL("../../../../examples/campaign/", import.meta.url));
const PASSWORD = "correct horse battery staple";

describe("sign-in with the admin password", { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-password-"));
  let base: string;
  let close: () => Promise<void>;
  let stop: () => void;

  const form = (fields: Record<string, string>) => ({ method: "POST", redirect: "manual" as const, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const session = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith("lenspack_session="));
  const signIn = async () => (await fetch(`${base}/auth/login`, form({ user: "admin", password: PASSWORD, return: "/" }))).headers.getSetCookie()[0]!.split(";")[0]!;

  beforeAll(async () => {
    const db = await openDuckdb(join(dir, "campaign.duckdb"));
    await seed(db.writer, "duckdb", { households: 300 });
    await db.close();
    const file = join(dir, "lenspack.yaml");
    writeFileSync(
      file,
      `sources:\n  data: { kind: duckdb, path: ${join(dir, "campaign.duckdb")} }\npacks:\n  - pack: ${campaign}pack.yaml\n    source: data\n    boards: ${campaign}boards\n    now: "2026-09-01T00:00:00Z"\n    access:\n      - roles: [admin]\n        hide: [delivered_by]\n  - pack: ${campaign}pack.yaml\n    name: internal\n    source: data\n    access:\n      - roles: [staff]\nstore: { kind: memory }\n`,
    );
    const { config, dir: cfgDir } = readConfig(file);
    const opened = await openConfig(config, cfgDir);
    for (const h of opened.hosts) await seedBoards(h);
    close = opened.close;
    const ui = mkdtempSync(join(tmpdir(), "lenspack-ui-"));
    writeFileSync(join(ui, "index.html"), "<html><head><title>x</title></head><body>app</body></html>");
    const { adapter, rights } = authFrom(authSchema.parse({ kind: "password" }), { dir: join(dir, "state"), env: { LENSPACK_ADMIN_PASSWORD: PASSWORD } });
    const server = createServer(createApp(opened.hosts, { ui, auth: adapter, rights }));
    base = await listen(server);
    stop = () => server.close();
  });
  afterAll(async () => {
    stop();
    await close();
  });

  it("sends a page without a session to the sign-in page, and answers the API 401", async () => {
    const page = await fetch(`${base}/boards/x`, { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`/auth/login?return=${encodeURIComponent("/boards/x")}`);
    expect((await fetch(`${base}/api/`)).status).toBe(401);
    const login = await fetch(`${base}/auth/login?return=/boards/x`);
    expect(login.status).toBe(200);
    expect(login.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await login.text()).toContain('name="password"');
  });

  it("refuses a wrong password and signs in with the right one", async () => {
    const wrong = await fetch(`${base}/auth/login`, form({ user: "admin", password: "nope nope nope", return: "/boards/x" }));
    expect(wrong.status).toBe(401);
    expect(session(wrong)).toBeUndefined();
    expect((await fetch(`${base}/auth/login`, form({ user: "root", password: PASSWORD }))).status).toBe(401);
    const ok = await fetch(`${base}/auth/login`, form({ user: "admin", password: PASSWORD, return: "/boards/x" }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/boards/x");
    expect(session(ok)).toMatch(/HttpOnly; SameSite=Lax/);
    const back = await fetch(`${base}/auth/login`, form({ user: "admin", password: PASSWORD, return: "//evil.example/" }));
    expect(back.headers.get("location")).toBe("/");
  });

  it("gives admin every right, with pack rules applied to the role admin", async () => {
    const cookie = await signIn();
    const index = await (await fetch(`${base}/api/`, { headers: { cookie } })).json();
    expect(index.me).toEqual({ user: "admin", edit: true, maintain: true, usage: true, signOut: "/auth/logout" });
    expect(index.examples.map((e: { example: string }) => e.example)).toEqual(["campaign"]);
    expect((await fetch(`${base}/api/_usage`, { headers: { cookie } })).status).toBe(200);
    const catalogue = (await (await fetch(`${base}/api/campaign`, { headers: { cookie } })).json()).catalogue;
    expect(catalogue.dimensions.map((d: { key: string }) => d.key)).not.toContain("delivered_by");
    expect((await (await fetch(`${base}/api/campaign/overview/options?field=delivered_by`, { headers: { cookie } })).json())).toEqual([]);
    expect((await fetch(`${base}/api/internal`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/campaign/boards`, { method: "POST", body: "{}", headers: { cookie, "content-type": "application/json" } })).status).toBe(200);
  });

  it("believes no altered cookie and no change from another site, and signs out", async () => {
    const cookie = await signIn();
    const [name, value] = cookie.split("=") as [string, string];
    const [body, sig] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), exp: 9e9 })).toString("base64url");
    expect((await fetch(`${base}/api/`, { headers: { cookie: `${name}=${forged}.${sig}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/campaign/boards`, { method: "POST", body: "{}", headers: { cookie, origin: "https://evil.example" } })).status).toBe(401);
    expect((await fetch(`${base}/auth/login`, { ...form({ password: PASSWORD }), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" } })).status).toBe(400);
    const out = await fetch(`${base}/auth/logout`, { redirect: "manual", headers: { cookie } });
    expect(out.status).toBe(302);
    expect(out.headers.getSetCookie()[0]).toMatch(/^lenspack_session=; .*Max-Age=0/);
  });
});

// The adapter alone, driven with requests made by hand: a clock to move, addresses and cookies to vary.
function driver(adapter: ReturnType<typeof passwordAdapter>) {
  return async (password: string, addr = "10.0.0.1", extra: Record<string, string> = {}) => {
    const req = Object.assign(Readable.from([new URLSearchParams({ user: "admin", password }).toString()]), {
      method: "POST",
      url: "/auth/login",
      headers: { host: "lens", "content-type": "application/x-www-form-urlencoded", ...extra },
      socket: { remoteAddress: addr },
    }) as unknown as IncomingMessage;
    let status = 0;
    let headers: Record<string, unknown> = {};
    const res = { writeHead: (s: number, h: Record<string, unknown>) => ((status = s), (headers = h)), end: () => {} } as unknown as ServerResponse;
    await adapter.handle!(req, res, new URL("http://lens/auth/login"));
    const set = ([] as string[]).concat((headers["set-cookie"] as string[] | string | undefined) ?? []);
    const jar = set.map((c) => c.split(";")[0]!).join("; ");
    return { status, headers, set, jar };
  };
}
// Who a request carrying these headers is, to the adapter.
const who = (adapter: ReturnType<typeof passwordAdapter>, headers: Record<string, string>, method = "GET") => adapter.identify({ method, headers } as unknown as IncomingMessage);
const tmp = () => mkdtempSync(join(tmpdir(), "lp-"));

describe("the password adapter", { timeout: 60_000 }, () => {
  it("makes callers wait after five failures, longer each time, without checking the password", async () => {
    let clock = 1_000_000;
    const a = passwordAdapter({ password: PASSWORD, dir: tmp(), sessionHours: 1, now: () => clock });
    const login = driver(a);
    for (let i = 0; i < 5; i++) expect((await login("wrong password!")).status).toBe(401);
    const locked = await login(PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.headers["retry-after"]).toBe("1");
    // Another address is not held up by this one.
    expect((await login(PASSWORD, "10.0.0.2")).status).toBe(303);
    clock += 1_001;
    expect((await login("wrong password!")).status).toBe(401);
    expect((await login(PASSWORD)).headers["retry-after"]).toBe("2");
    clock += 2_001;
    const ok = await login(PASSWORD);
    expect(ok.status).toBe(303);
    // Success does not clear the address, which an attacker may share; the browser's device cookie gets its own count.
    expect((await login(PASSWORD)).status).toBe(429);
    const device = ok.jar.split("; ").find((c) => c.startsWith("lenspack_device="))!;
    expect((await login(PASSWORD, "10.0.0.1", { cookie: device })).status).toBe(303);
    // An hour without a failure forgets them.
    for (let i = 0; i < 6; i++) await login("wrong password!", "10.0.0.3");
    expect((await login(PASSWORD, "10.0.0.3")).status).toBe(429);
    clock += 61 * 60_000;
    expect((await login("wrong password!", "10.0.0.3")).status).toBe(401);
    expect((await login(PASSWORD, "10.0.0.3")).status).toBe(303);
  });

  it("checks no more than five of a burst sent at once from one address, against a hash", async () => {
    const a = passwordAdapter({ passwordHash: hashPassword(PASSWORD), dir: tmp(), sessionHours: 1 });
    const login = driver(a);
    const burst = await Promise.all(Array.from({ length: 40 }, () => login("wrong password!")));
    expect(burst.filter((r) => r.status === 401).length).toBeLessThanOrEqual(5);
    expect(burst.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(35);
  });

  it("checks only a few passwords at once from anywhere, but lets a known browser in past an attacker on its address", async () => {
    const clock = 1_000_000;
    const a = passwordAdapter({ passwordHash: hashPassword(PASSWORD), dir: tmp(), sessionHours: 1, now: () => clock });
    const login = driver(a);
    const ok = await login(PASSWORD, "10.0.0.9");
    expect(ok.status).toBe(303);
    expect(ok.set.find((c) => c.startsWith("lenspack_device="))).toMatch(/Path=\/auth\/login; HttpOnly/);
    const device = ok.jar.split("; ").find((c) => c.startsWith("lenspack_device="))!;
    const flood = await Promise.all(Array.from({ length: 20 }, (_, i) => login("wrong password!", `10.2.${i}.1`)));
    expect(flood.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    // Behind a proxy everyone shares one address: the attacker holds it up, not the admin's browser.
    for (let i = 0; i < 6; i++) await login("wrong password!", "10.0.0.9");
    expect((await login(PASSWORD, "10.0.0.9")).status).toBe(429);
    expect((await login(PASSWORD, "10.0.0.9", { cookie: device })).status).toBe(303);
    // A known browser's own failures are cleared by its success.
    for (let i = 0; i < 4; i++) expect((await login("wrong password!", "10.0.0.9", { cookie: device })).status).toBe(401);
    expect((await login(PASSWORD, "10.0.0.9", { cookie: device })).status).toBe(303);
    expect((await login(PASSWORD, "10.0.0.9", { cookie: device })).status).toBe(303);
    // A forged device cookie is someone without one.
    expect((await login(PASSWORD, "10.0.0.9", { cookie: `${device.slice(0, -2)}xx` })).status).toBe(429);
  });

  it("gives callers without a device cookie 100 failures in 10 minutes between them, wherever they come from", async () => {
    let clock = 9_000_000;
    const a = passwordAdapter({ password: PASSWORD, dir: tmp(), sessionHours: 1, now: () => clock });
    const login = driver(a);
    const ok = await login(PASSWORD, "10.0.0.1");
    const device = ok.jar.split("; ").find((c) => c.startsWith("lenspack_device="))!;
    for (let i = 0; i < 100; i++) expect((await login("wrong password!", `10.3.${i}.1`)).status).toBe(401);
    expect((await login(PASSWORD, "10.9.9.9")).status).toBe(429);
    // A browser that signed in before is not held up.
    expect((await login(PASSWORD, "10.9.9.9", { cookie: device })).status).toBe(303);
    clock += 10 * 60_000 + 1;
    expect((await login(PASSWORD, "10.9.9.9")).status).toBe(303);
  });

  it("counts an IPv6 /64 as one caller", () => {
    expect(addressKey("2001:db8:aa:bb:1::2")).toBe("2001:db8:aa:bb::/64");
    expect(addressKey("2001:0db8:00aa:00bb:ffff:1:2:3")).toBe("2001:db8:aa:bb::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(addressKey("10.1.2.3")).toBe("10.1.2.3");
  });

  it("makes a password at first start: the hash and a one-time file, each readable by this user only", async () => {
    const dir = join(tmp(), "state");
    const lines: string[] = [];
    const a = passwordAdapter({ dir, sessionHours: 1, log: (l) => lines.push(l) });
    for (const f of ["admin-password.hash", "admin-password.txt", "session.key"]) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
    const made = readFileSync(join(dir, "admin-password.txt"), "utf8").trim();
    expect(made.length).toBeGreaterThanOrEqual(24);
    expect(readFileSync(join(dir, "admin-password.hash"), "utf8")).not.toContain(made);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(join(dir, "admin-password.txt"));
    expect(lines.join("\n")).not.toContain(made);
    expect((await driver(a)(made)).status).toBe(303);
    // The password is written once: read and deleted, it is not written again, and the hash stays.
    const hash = readFileSync(join(dir, "admin-password.hash"), "utf8");
    rmSync(join(dir, "admin-password.txt"));
    const again = passwordAdapter({ dir, sessionHours: 1, log: (l) => lines.push(l) });
    expect(existsSync(join(dir, "admin-password.txt"))).toBe(false);
    expect(readFileSync(join(dir, "admin-password.hash"), "utf8")).toBe(hash);
    expect(lines).toHaveLength(1);
    expect((await driver(again)(made)).status).toBe(303);
    // Starting over with the old password file left behind: a new pair, and the file holds the new one.
    rmSync(join(dir, "admin-password.hash"));
    writeFileSync(join(dir, "admin-password.txt"), "old\n", { mode: 0o600 });
    const fresh = passwordAdapter({ dir, sessionHours: 1, log: (l) => lines.push(l) });
    const remade = readFileSync(join(dir, "admin-password.txt"), "utf8").trim();
    expect(remade).not.toBe("old");
    expect((await driver(fresh)(remade)).status).toBe(303);
  });

  it("refuses state another user could have planted: a link, or a file others may write", () => {
    const dir = tmp();
    const planted = join(tmp(), "key");
    writeFileSync(planted, "k".repeat(64));
    symlinkSync(planted, join(dir, "session.key"));
    expect(() => passwordAdapter({ password: PASSWORD, dir, sessionHours: 1 })).toThrow(/not a link/);
    const open = tmp();
    chmodSync(open, 0o777);
    expect(() => passwordAdapter({ password: PASSWORD, dir: open, sessionHours: 1 })).toThrow(/writable by everyone/);
    // A folder shared with a group, as a Kubernetes volume with fsGroup is, is fine; its files are still this user's alone.
    const group = tmp();
    chmodSync(group, 0o2775);
    expect(() => passwordAdapter({ password: PASSWORD, dir: group, sessionHours: 1 })).not.toThrow();
    chmodSync(join(group, "session.key"), 0o660);
    expect(() => passwordAdapter({ password: PASSWORD, dir: group, sessionHours: 1 })).toThrow(/writable by others/);
  });

  it("puts a state file in place only where none is", () => {
    const file = join(tmp(), "f");
    expect(claim(file, "first")).toBe(true);
    expect(claim(file, "second")).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("first");
  });

  it("needs no folder with a password and a session secret", () => {
    const dir = join(tmp(), "never");
    passwordAdapter({ password: PASSWORD, sessionSecret: "s".repeat(32), dir, sessionHours: 1 });
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves one matching password and hash when several start at once on one folder", async () => {
    const dir = join(tmp(), "shared");
    const src = fileURLToPath(new URL("../src/password.ts", import.meta.url));
    const script = `import { passwordAdapter } from ${JSON.stringify(src)}; passwordAdapter({ dir: ${JSON.stringify(dir)}, sessionHours: 1 });`;
    const run = () =>
      new Promise<number>((done) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "ignore" });
        child.on("exit", (code) => done(code ?? 1));
      });
    expect(await Promise.all([run(), run(), run(), run()])).toEqual([0, 0, 0, 0]);
    const made = readFileSync(join(dir, "admin-password.txt"), "utf8").trim();
    const a = passwordAdapter({ dir, sessionHours: 1 });
    expect((await driver(a)(made)).status).toBe(303);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("keys the session's password fingerprint, so a leaked cookie gives nothing to guess against", async () => {
    const fingerprint = async (sessionSecret: string) => {
      const a = passwordAdapter({ password: PASSWORD, sessionSecret, dir: tmp(), sessionHours: 1 });
      const body = (await driver(a)(PASSWORD)).jar.split("; ").find((c) => c.startsWith("lenspack_session="))!.split("=")[1]!.split(".")[0]!;
      return JSON.parse(Buffer.from(body, "base64url").toString()).f;
    };
    expect(await fingerprint("a".repeat(32))).not.toBe(await fingerprint("b".repeat(32)));
  });

  it("ends every session when the password changes", async () => {
    const dir = tmp();
    const a = passwordAdapter({ password: PASSWORD, dir, sessionHours: 1 });
    const session = (await driver(a)(PASSWORD)).jar.split("; ").find((c) => c.startsWith("lenspack_session="))!;
    expect(await who(a, { cookie: session })).toMatchObject({ user: "admin" });
    const b = passwordAdapter({ password: `${PASSWORD} 2`, dir, sessionHours: 1 });
    expect(await who(b, { cookie: session })).toBeNull();
  });

  it("believes a change from the configured address only, and marks the cookie Secure on https", async () => {
    const a = passwordAdapter({ password: PASSWORD, dir: tmp(), sessionHours: 1, baseUrl: "https://lens.example" });
    const ok = await driver(a)(PASSWORD, "10.0.0.1", { origin: "https://lens.example" });
    expect(ok.status).toBe(303);
    expect(ok.set[0]).toMatch(/; Secure;/);
    expect((await driver(a)(PASSWORD, "10.0.0.1", { origin: "https://lens.example.evil" })).status).toBe(400);
    const cookie = ok.jar.split("; ").find((c) => c.startsWith("lenspack_session="))!;
    expect(await who(a, { cookie, origin: "https://lens.example" }, "POST")).toMatchObject({ user: "admin" });
    expect(await who(a, { cookie, origin: "https://other.example" }, "POST")).toBeNull();
  });

  it("without an address set, takes the host a proxy forwarded, and nothing else", async () => {
    const a = passwordAdapter({ password: PASSWORD, dir: tmp(), sessionHours: 1 });
    const login = driver(a);
    expect((await login(PASSWORD, "10.0.0.1", { origin: "https://lens.example", "x-forwarded-host": "lens.example" })).status).toBe(303);
    expect((await login(PASSWORD, "10.0.0.1", { origin: "https://lens.example" })).status).toBe(400);
    expect((await login(PASSWORD, "10.0.0.1", { origin: "http://lens" })).status).toBe(303);
  });

  it("takes a scrypt hash, and refuses a short password or a malformed hash", async () => {
    const dir = tmp();
    const a = passwordAdapter({ passwordHash: hashPassword(PASSWORD), dir, sessionHours: 1 });
    expect((await driver(a)("wrong password!")).status).toBe(401);
    expect((await driver(a)(PASSWORD)).status).toBe(303);
    expect(() => passwordAdapter({ password: "short", dir, sessionHours: 1 })).toThrow(/12 characters/);
    expect(() => passwordAdapter({ passwordHash: "md5$abc", dir, sessionHours: 1 })).toThrow(/scrypt/);
    const good = hashPassword(PASSWORD).split("$");
    const bad = (i: number, v: string) => good.map((x, j) => (j === i ? v : x)).join("$");
    // A hash made cheap (a low N), an empty hash that would match anything, a short salt, a huge cost: refused.
    for (const h of [bad(1, "1024"), bad(5, "="), bad(4, "c2FsdA"), bad(2, "x"), bad(2, "1000000")]) expect(() => passwordAdapter({ passwordHash: h, dir, sessionHours: 1 }), h).toThrow(/scrypt/);
  });
});

describe("choosing the sign-in", () => {
  const proxy: AuthConfig = authSchema.parse({ kind: "proxy", secret: "s".repeat(32) });

  it("defaults to the admin password, and LENSPACK_AUTH picks another kind", () => {
    expect(effectiveAuth(undefined, {}).kind).toBe("password");
    expect(effectiveAuth(proxy, {}).kind).toBe("proxy");
    expect(effectiveAuth(proxy, { LENSPACK_AUTH: "none" }).kind).toBe("none");
    expect(effectiveAuth(undefined, { LENSPACK_AUTH: "password" }).kind).toBe("password");
    expect(() => effectiveAuth(undefined, { LENSPACK_AUTH: "oidc" })).toThrow(/needs its settings/);
    expect(() => effectiveAuth(undefined, { LENSPACK_AUTH: "magic" })).toThrow(/not a kind/);
  });

  it("takes the yaml's password over the environment's, and a relative dir from the config's folder", async () => {
    const base = tmp();
    const { adapter } = authFrom(authSchema.parse({ kind: "password", passwordHash: hashPassword(PASSWORD), dir: "state" }), { dir: base, env: { LENSPACK_ADMIN_PASSWORD: "the environment's one" } });
    expect((await driver(adapter as ReturnType<typeof passwordAdapter>)(PASSWORD)).status).toBe(303);
    expect(existsSync(join(base, "state", "session.key"))).toBe(true);
  });

  it("builds the adapter each kind names; none has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-"));
    const kinds: [AuthConfig, string | undefined][] = [
      [authSchema.parse({ kind: "none" }), undefined],
      [authSchema.parse({ kind: "password" }), "password"],
      [proxy, "proxy"],
      [authSchema.parse({ kind: "tokens", users: [{ user: "a", token: "t" }] }), "tokens"],
      [authSchema.parse({ kind: "oidc", issuer: "https://idp.example", clientId: "c", baseUrl: "https://lens.example", sessionSecret: "s".repeat(32) }), "oidc"],
    ];
    for (const [auth, kind] of kinds) expect(authFrom(auth, { dir, env: { LENSPACK_ADMIN_PASSWORD: PASSWORD } }).adapter?.kind).toBe(kind);
  });
});
