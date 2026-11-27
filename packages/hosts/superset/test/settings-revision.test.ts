// Settings that don't drift apart (docs/hosts/superset/settings.md#changes-made-elsewhere): bin/serve.ts started as its
// own process against a stand-in Superset. Every settings answer says the revision it is at (ETag); a change sent with
// If-Match is refused with 409 when what it changes moved since, naming who moved it and giving the values as they are
// now; a change without If-Match writes as before. The same on the settings routes, the admin panel's routes, Superset's
// own (personal-dashboard limits), the pack, through a signed-in admin and with an admin API key. Made-up data only.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IDENTITY_HEADER, type Identity, signIdentity } from "../src/identity";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const KEY = "k".repeat(64);
// A made-up key for this test only.
const CI = "test-only-ci-key-0123456789abcdefghij";
const signed = (id: Partial<Identity>) => signIdentity({ u: "someone", a: false, t: Math.floor(Date.now() / 1000), ...id }, KEY);
const ANA = { u: "ana", r: ["Admin"] };
const BEN = { u: "ben", r: ["Admin"] };

const DATASET = {
  id: 11,
  table_name: "orders",
  schema: "public",
  main_dttm_col: "ordered_at",
  columns: [
    { column_name: "ordered_at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "region", groupby: true, type: "VARCHAR" },
    { column_name: "quantity", groupby: false, type: "BIGINT" },
  ],
  metrics: [{ metric_name: "count", expression: "COUNT(*)" }],
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

describe("settings changed in two places at once", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-settings-revision-"));
  const superset = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/api/v1/security/login") return send({ access_token: "token" });
    if (path === "/api/v1/security/csrf_token/") return send({ result: "csrf" });
    if (path === "/api/v1/dataset/11") return send({ result: DATASET });
    if (path === "/api/v1/lenspack/identity-key") return send({ result: { key: KEY } });
    if (path === "/api/v1/dashboard/") return send({ result: [] });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not here" }));
  }) as Server;
  let child: ChildProcess | undefined;
  let base = "";

  type Reply = { status: number; tag: string | null; body: any };
  const call = async (path: string, o: { method?: string; key?: string; as?: Partial<Identity>; body?: unknown; ifMatch?: string | null } = {}): Promise<Reply> => {
    const headers: Record<string, string> = {
      ...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
      ...(o.as ? { [IDENTITY_HEADER]: signed(o.as) } : {}),
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(o.ifMatch ? { "if-match": o.ifMatch } : {}),
    };
    const r = await fetch(`${base}${path}`, { method: o.method ?? "GET", headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, tag: r.headers.get("etag"), body };
  };
  const put = (path: string, body: unknown, o: { as?: Partial<Identity>; key?: string; ifMatch?: string | null; method?: string } = {}) => call(path, { method: o.method ?? "PUT", body, as: o.key ? undefined : (o.as ?? ANA), key: o.key, ifMatch: o.ifMatch });

  beforeAll(async () => {
    await new Promise<void>((r) => superset.listen(0, "127.0.0.1", r));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const config = join(dir, "superset.yaml");
    writeFileSync(config, ["superset: { url: env:TEST_SUPERSET_URL }", "datasets: [11]", "overlay: { pack: shop }", `port: ${port}`, `state: ${join(dir, "state", "boards.json")}`, ""].join("\n"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LENSPACK_|ANTHROPIC_|OPENROUTER_|SUPERSET_)/.test(k)));
    let output = "";
    child = spawn(join(root, "node_modules/.bin/tsx"), ["--tsconfig", join(root, "tsconfig.base.json"), join(root, "packages/hosts/superset/bin/serve.ts"), config], {
      cwd: root,
      env: { ...env, TEST_SUPERSET_URL: `http://127.0.0.1:${(superset.address() as AddressInfo).port}`, LENSPACK_SUPERSET_PASSWORD: "service-password", LENSPACK_ADMIN_API_KEYS: `ci:${CI}` },
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
  afterAll(async () => {
    if (child && child.exitCode === null) {
      const gone = new Promise((r) => child!.once("exit", r));
      child.kill();
      await gone;
    }
    superset.close();
  });

  it("says the revision in every settings answer, and in a cheap route an open page asks", async () => {
    const r = await call("/_superset/settings", { as: ANA });
    expect(r.status).toBe(200);
    expect(r.tag).toBe(`"settings-${r.body.revision}"`);
    const rev = await call("/_superset/settings/revision", { as: ANA });
    expect(rev.body).toMatchObject({ revision: r.body.revision, pack: { version: 0 } });
    expect(rev.tag).toBe(r.tag);
    // Not for people who aren't admins.
    expect((await call("/_superset/settings/revision", { as: { u: "bo", r: ["Gamma"] } })).status).toBe(403);
  });

  it("refuses a change made on an old copy of what it changes, with who changed it and the values now; nothing changes", async () => {
    const read = await call("/_superset/settings", { as: ANA });
    // Ben changes the language meanwhile, on the same revision Ana read.
    const ben = await put("/_superset/settings/language", { default: "fr" }, { as: BEN, ifMatch: read.tag });
    expect(ben.status, JSON.stringify(ben.body)).toBe(200);
    expect(ben.tag).toBe(`"settings-${read.body.revision + 1}"`);
    // Ana, on her old copy, sets it to English: refused.
    const ana = await put("/_superset/settings/language", { default: "en" }, { ifMatch: read.tag });
    expect(ana.status).toBe(409);
    expect(ana.body).toMatchObject({ code: "changed-elsewhere", section: "language", by: "ben", revision: read.body.revision + 1, current: { language: { default: "fr" }, revision: read.body.revision + 1 } });
    expect(ana.body.error).toMatch(/^the language settings changed elsewhere by ben since this copy was read/);
    expect(ana.tag).toBe(ben.tag);
    expect((await call("/_superset/settings", { as: ANA })).body.language.default).toBe("fr");
    // A change to something else on the same old copy is not a conflict: nobody changed that.
    expect((await put("/_superset/settings/queue", { maxWaiting: 7 }, { ifMatch: read.tag })).status).toBe(200);
    // On the copy it read again, the change goes through.
    const again = await call("/_superset/settings", { as: ANA });
    expect((await put("/_superset/settings/language", { default: "en" }, { ifMatch: again.tag })).status).toBe(200);
    expect((await call("/_superset/settings", { as: ANA })).body.lastChange).toMatchObject({ section: "language", by: "ana" });
  });

  it("lets a change without If-Match through, as before: the last write wins", async () => {
    expect((await put("/_superset/settings/language", { default: "fr" }, { as: BEN })).status).toBe(200);
    expect((await put("/_superset/settings/language", { default: "en" })).status).toBe(200);
    expect((await call("/_superset/settings", { as: ANA })).body.language.default).toBe("en");
  });

  it("refuses an If-Match that is not one of these settings' tags", async () => {
    for (const tag of ['"pack-1"', "12", '"settings-x"']) {
      const r = await put("/_superset/settings/language", { default: "fr" }, { ifMatch: tag });
      expect([tag, r.status]).toEqual([tag, 400]);
    }
  });

  it("with an admin API key through the passthrough: the same tags, the same refusal, attributed to the key", async () => {
    const read = await call("/_admin/settings", { key: CI });
    expect(read.tag).toBe(`"settings-${read.body.revision}"`);
    expect((await put("/_superset/settings/language", { default: "fr" }, { as: BEN })).status).toBe(200);
    const stale = await put("/_admin/settings/language", { default: "en" }, { key: CI, ifMatch: read.tag });
    expect(stale.body).toMatchObject({ code: "changed-elsewhere", by: "ben" });
    expect(stale.status).toBe(409);
    const fresh = await call("/_admin/settings/revision", { key: CI });
    expect((await put("/_admin/settings/language", { default: "en" }, { key: CI, ifMatch: fresh.tag })).status).toBe(200);
    // Ben's page, holding the copy from before the key's change, is refused in turn, and told who.
    const ben = await put("/_superset/settings/language", { default: "fr" }, { as: BEN, ifMatch: fresh.tag });
    expect([ben.status, ben.body.by]).toEqual([409, "api:ci"]);
  });

  it("on the admin panel's own routes (the switches, the name) and on Superset's (personal-dashboard limits)", async () => {
    const read = await call("/_superset/admin/api/settings", { as: ANA });
    expect(read.status).toBe(200);
    expect(read.tag).toMatch(/^"settings-\d+"$/);
    expect((await put("/_superset/settings/brand", { name: "Helper" }, { as: BEN })).status).toBe(200);
    const panel = await put("/_superset/admin/api/settings/brand", { name: "Other" }, { method: "POST", ifMatch: read.tag });
    expect([panel.status, panel.body.code, panel.body.by]).toEqual([409, "changed-elsewhere", "ben"]);
    const fresh = await put("/_superset/admin/api/settings/brand", { name: null }, { method: "POST", ifMatch: (await call("/_superset/settings/revision", { as: ANA })).tag });
    expect(fresh.status).toBe(200);
    expect(fresh.tag).toMatch(/^"settings-\d+"$/);

    const limits = await call("/_superset/settings", { as: ANA });
    expect((await put("/_superset/settings/personal", { maxDashboardsPerUser: 4 }, { as: BEN })).status).toBe(200);
    const stale = await put("/_superset/settings/personal", { maxDashboardsPerUser: 9 }, { ifMatch: limits.tag });
    expect([stale.status, stale.body.section]).toEqual([409, "personal"]);
    expect((await call("/_superset/settings", { as: ANA })).body.personal).toMatchObject({ maxDashboardsPerUser: 4 });
    const ok = await put("/_superset/settings/personal", { maxDashboardsPerUser: null }, { ifMatch: stale.tag });
    expect([ok.status, ok.tag]).toEqual([200, `"settings-${stale.body.revision + 1}"`]);
  });

  it("the pack's changes too: its version is its tag, and an old one is refused with the pack as it is now", async () => {
    const read = await call("/_superset/settings/pack", { as: ANA });
    expect(read.tag).toBe('"pack-0"');
    const ben = await put("/_superset/settings/pack", { fields: { description: "Ben's words" } }, { as: BEN, ifMatch: read.tag });
    expect([ben.status, ben.tag]).toEqual([200, '"pack-1"']);
    const ana = await put("/_admin/settings/pack", { fields: { description: "Older words" } }, { key: CI, ifMatch: read.tag });
    expect(ana.status).toBe(409);
    expect(ana.body).toMatchObject({ code: "changed-elsewhere", section: "pack", by: "ben", revision: 1, current: { version: 1 } });
    expect((await call("/_superset/settings/revision", { as: ANA })).body.pack).toMatchObject({ version: 1, by: "ben" });
    const reset = await put("/_superset/settings/pack/reset", {}, { method: "POST", ifMatch: '"pack-0"' });
    expect(reset.status).toBe(409);
    expect((await put("/_superset/settings/pack/reset", {}, { method: "POST", ifMatch: ana.tag })).status).toBe(200);
  });
});
