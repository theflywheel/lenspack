// Admin API keys on the Superset-mode server (docs/access/admin-api.md): bin/serve.ts started as its own process
// against a stand-in Superset, with two keys (one plain, one a scrypt hash from a mounted file) and admins named by
// user (superset-users), so the key is seen to override the mode. Called over HTTP the way a script would.
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "@lenspack/serve";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IDENTITY_HEADER, type Identity, signIdentity } from "../src/identity";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const KEY = "k".repeat(64);
// Made-up keys for this test only.
const CI = "test-only-ci-key-0123456789abcdefghij";
const OPS = "test-only-ops-key-zyxwvutsrqponmlkjihg";
const now = () => Math.floor(Date.now() / 1000);
const signed = (id: Partial<Identity>) => signIdentity({ u: "someone", a: false, t: now(), ...id }, KEY);
/** The caller's address as Superset's plugin signs it on the admin passthrough (x-lenspack-client). */
const client = (address: string) => {
  const body = Buffer.from(JSON.stringify({ c: address, t: now() })).toString("base64url");
  return `${body}.${createHmac("sha256", KEY).update(`client:${body}`).digest("hex")}`;
};

const DATASET = { id: 1, table_name: "visits", schema: "public", main_dttm_col: "created_at", columns: [{ column_name: "created_at", is_dttm: true, type: "TIMESTAMP" }, { column_name: "region", groupby: true, type: "TEXT" }], metrics: [{ metric_name: "visit_count", expression: "COUNT(*)" }] };

function fakeSuperset(): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/api/v1/security/login") return send({ access_token: "token" });
    if (path === "/api/v1/security/csrf_token/") return send({ result: "csrf" });
    if (path === "/api/v1/dataset/1") return send({ result: DATASET });
    if (path === "/api/v1/lenspack/identity-key") return send({ result: { key: KEY } });
    if (path === "/api/v1/lenspack/access") {
      const q = new URL(req.url ?? "", "http://x").searchParams;
      const ids = (name: string) => (q.get(name) ?? "").split(",").filter(Boolean);
      return send({ result: { datasets: Object.fromEntries(ids("datasets").map((d) => [d, { access: true, rls: [] }])), dashboards: {} } });
    }
    if (path === "/api/v1/dashboard/") return send({ result: [] });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not here" }));
  });
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

describe("admin API keys on the Superset-mode server", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-api-key-"));
  const superset = fakeSuperset();
  let child: ChildProcess;
  let base: string;
  let output = "";

  const call = async (path: string, o: { method?: string; key?: string; auth?: string; as?: Partial<Identity>; from?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {
      ...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
      ...(o.auth ? { authorization: o.auth } : {}),
      ...(o.as ? { [IDENTITY_HEADER]: signed(o.as) } : {}),
      ...(o.from ? { "x-lenspack-client": client(o.from) } : {}),
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
    };
    const r = await fetch(`${base}${path}`, { method: o.method ?? "GET", headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* a page */
    }
    return { status: r.status, headers: r.headers, body };
  };
  const audit = async () => (await call("/_admin/audit?limit=500", { key: CI })).body.events as { user: string; action: string; outcome: string; detail?: string }[];

  beforeAll(async () => {
    await new Promise<void>((r) => superset.listen(0, "127.0.0.1", r));
    const supersetUrl = `http://127.0.0.1:${(superset.address() as AddressInfo).port}`;
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const config = join(dir, "superset.yaml");
    writeFileSync(config, ["superset: { url: env:TEST_SUPERSET_URL }", "datasets: [1]", "overlay: { pack: visits_pack }", `port: ${port}`, `state: ${join(dir, "state", "boards.json")}`, ""].join("\n"));
    // The ops key as a Kubernetes Secret would hold it: only its hash, in a mounted file.
    const keys = join(dir, "api-keys");
    writeFileSync(keys, `# admin API keys\nops:${hashPassword(OPS)}\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LENSPACK_|ANTHROPIC_|OPENROUTER_|SUPERSET_)/.test(k)));
    child = spawn(join(root, "node_modules/.bin/tsx"), ["--tsconfig", join(root, "tsconfig.base.json"), join(root, "packages/hosts/superset/bin/serve.ts"), config], {
      cwd: root,
      env: { ...env, TEST_SUPERSET_URL: supersetUrl, LENSPACK_SUPERSET_PASSWORD: "service-password", LENSPACK_ADMIN_ACCESS: "superset-users", LENSPACK_ADMIN_USERS: "olga", LENSPACK_ADMIN_API_KEYS: `ci:${CI}`, LENSPACK_ADMIN_API_KEYS_FILE: keys },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (c) => (output += c));
    child.stderr!.on("data", (c) => (output += c));
    for (let i = 0; i < 300 && !output.includes(`${base}/`); i++) {
      if (child.exitCode !== null) throw new Error(`the server stopped: ${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!output.includes(`${base}/`)) throw new Error(`the server did not start: ${output}`);
  });
  afterAll(() => {
    child?.kill();
    superset.close();
  });

  it("says at start how many keys there are and their names, never a key", () => {
    expect(output).toContain("admin API keys: 2 (ci, ops) from LENSPACK_ADMIN_API_KEYS, LENSPACK_ADMIN_API_KEYS_FILE");
    expect(output).not.toContain(CI);
    expect(output).not.toContain(OPS);
  });

  it("answers who the key is, changing nothing, on both prefixes", async () => {
    const me = await call("/_admin/whoami", { key: CI });
    expect([me.status, me.body]).toEqual([200, { user: "api:ci", administer: true, users: true, owner: true, via: "api-key", detail: "ci", usesAssistant: false }]);
    expect((await call("/_superset/whoami", { key: CI })).body.user).toBe("api:ci");
    // The hashed key from the file.
    expect((await call("/_admin/whoami", { key: OPS })).body).toMatchObject({ user: "api:ops", administer: true });
  });

  it("refuses a wrong key, a header that isn't Bearer, and a key in the address", async () => {
    const wrong = await call("/_admin/settings", { key: `${CI}x` });
    expect([wrong.status, wrong.body.error]).toEqual([401, "not a valid admin API key"]);
    expect((await call("/_admin/settings", { auth: `Basic ${Buffer.from(`ci:${CI}`).toString("base64")}` })).status).toBe(401);
    // A key in a query string is never read: the request is an ordinary one, without a Superset signature.
    for (const q of ["key", "api_key", "token", "access_token"]) {
      const r = await call(`/_superset/settings?${q}=${CI}`);
      expect([q, r.status, r.body.error]).toEqual([q, 401, "sign in to Superset first"]);
    }
    const events = await audit();
    expect(events).toContainEqual(expect.objectContaining({ user: "api:?", action: "admin API key", outcome: "denied", detail: expect.stringMatching(/^wrong key/) }));
    expect(JSON.stringify(events)).not.toContain(CI);
  });

  it("is the master override: an admin under superset-users without being an owner, who may grant admins and users", async () => {
    // A Superset Admin is not an admin in this mode; the key is.
    expect((await call("/_superset/settings", { as: { u: "ana", a: true, r: ["Admin"] } })).status).toBe(403);
    const settings = await call("/_admin/settings", { key: CI });
    expect(settings.status).toBe(200);
    expect(settings.body.adminAccess).toMatchObject({ mode: "superset-users", apiKeys: { names: ["ci", "ops"] } });
    expect(JSON.stringify(settings.body)).not.toContain(CI);
    const granted = await call("/_admin/settings/admins", { method: "PUT", key: CI, body: { add: "bea" } });
    expect([granted.status, granted.body.granted]).toEqual([200, [expect.objectContaining({ user: "bea", by: "api:ci" })]]);
    expect((await call("/_superset/settings", { as: { u: "bea", a: false } })).status).toBe(200);
    expect((await call("/_admin/settings/admins", { method: "PUT", key: CI, body: { remove: "bea" } })).status).toBe(200);
  });

  it("changes settings and switches, every change audited as api:<name>, with its first use on the roster", async () => {
    expect((await call("/_admin/settings/brand", { method: "PUT", key: CI, body: { name: "Field helper" } })).status).toBe(200);
    expect((await call("/_admin/settings/features", { method: "PUT", key: CI, body: { heatmap: false } })).status).toBe(200);
    expect((await call("/_admin/settings/personal", { method: "PUT", key: CI, body: { maxDashboardsPerUser: 3 } })).body).toMatchObject({ ok: true, limits: { maxDashboardsPerUser: 3 } });
    const events = await audit();
    expect(events).toContainEqual(expect.objectContaining({ user: "api:ci", action: "settings brand", outcome: "ok" }));
    expect(events).toContainEqual(expect.objectContaining({ user: "api:ci", action: "settings features", outcome: "ok" }));
    expect(events).toContainEqual(expect.objectContaining({ user: "api:ci", action: "PUT /_superset/settings/personal", outcome: "ok" }));
    expect(events).toContainEqual(expect.objectContaining({ user: "api:ci", action: "admin first use", detail: "API key ci" }));
    const roster = (await call("/_admin/settings/admins", { key: CI })).body.roster;
    expect(roster).toContainEqual(expect.objectContaining({ user: "api:ci", via: "api-key", how: "API key ci" }));
    expect((await call("/_admin/settings/features", { method: "PUT", key: CI, body: { heatmap: null } })).status).toBe(200);
  });

  it("reads and edits the pack's definitions, clears saved answers, and reads usage and the audit log", async () => {
    const added = await call("/_admin/admin/api/definitions", { method: "POST", key: CI, body: { kind: "instruction", text: "Visits are counted per day.", why: "from a script" } });
    expect(added.status).toBe(200);
    const doc = (await call("/_admin/admin/api/definitions", { key: CI })).body;
    expect(doc.entries).toContainEqual(expect.objectContaining({ kind: "instruction", text: "Visits are counted per day.", createdBy: "api:ci" }));
    expect((await call("/_admin/cache/clear", { method: "POST", key: CI })).body).toMatchObject({ ok: true });
    expect((await call("/_admin/turns", { key: CI })).status).toBe(200);
    expect((await call("/_admin/telemetry", { key: CI })).status).toBe(200);
    expect((await call("/_admin/admin/api/packs", { key: CI })).status).toBe(200);
  });

  it("reads and changes the question limits, and never counts as a question itself", async () => {
    const put = await call("/_admin/settings/limits", { method: "PUT", key: CI, body: { perMinute: 3, questionsPerDay: 100 } });
    expect([put.status, put.body]).toEqual([200, expect.objectContaining({ perMinute: 3, questionsPerDay: 100, on: true, source: "settings" })]);
    expect((await call("/_admin/settings", { key: CI })).body.limits).toMatchObject({ perMinute: 3, questionsPerDay: 100 });
    // The key may not chat, so it is never counted: nobody is at a limit or counted today.
    expect((await call("/api/visits_pack/overview/chat", { method: "POST", key: CI, body: { messages: [] } })).body.code).toBe("api-key-admin-only");
    expect((await call("/_admin/limits?all=1", { key: CI })).body).toMatchObject({ on: true, people: [] });
    expect(await audit()).toContainEqual(expect.objectContaining({ user: "api:ci", action: "settings limits", outcome: "ok" }));
    expect((await call("/_admin/settings/limits", { method: "PUT", key: CI, body: { perMinute: null, questionsPerDay: null } })).body).toMatchObject({ on: false, source: "default" });
  });

  it("works on the admin routes only: not the chat, the data, or a person's own pages, and the key isn't even checked there", async () => {
    for (const [method, path] of [
      ["POST", "/api/visits_pack/overview/chat"],
      ["GET", "/api/visits_pack"],
      ["GET", "/api/_usage"],
      ["GET", "/_superset/bind?dashboard=7"],
      ["GET", "/_superset/dashboards"],
      ["GET", "/_superset/my"],
      ["GET", "/_admin/auth/login"],
      ["GET", "/"],
    ] as const) {
      const r = await call(path, { method, key: CI, ...(method === "POST" ? { body: { messages: [] } } : {}) });
      expect([path, r.status, r.body.code]).toEqual([path, 403, "api-key-admin-only"]);
    }
    expect((await call("/healthz", { key: CI })).status).toBe(200);
  });

  it("limits wrong keys per caller, as Superset signs the caller's address, holding even a right key from there for a while", async () => {
    for (let i = 0; i < 5; i++) expect((await call("/_admin/whoami", { key: `wrong-${i}-${"x".repeat(32)}`, from: "203.0.113.9" })).status).toBe(401);
    const held = await call("/_admin/whoami", { key: CI, from: "203.0.113.9" });
    expect([held.status, Number(held.headers.get("retry-after")) > 0]).toEqual([429, true]);
    // Another caller is not held up.
    expect((await call("/_admin/whoami", { key: CI, from: "203.0.113.10" })).status).toBe(200);
    expect(await audit()).toContainEqual(expect.objectContaining({ user: "api:?", action: "admin API key", detail: expect.stringMatching(/too many wrong keys; waiting \d+ s \(203\.0\.113\.9\)/) }));
  });
});
