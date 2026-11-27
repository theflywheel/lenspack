// The deploy config's options an admin changes on a running server (docs/hosts/superset/runtime.md): bin/serve.ts
// started as its own process against a stand-in Superset and a stand-in model provider, then each option changed over
// HTTP, by a signed-in admin and with an admin API key on the admin passthrough. Each one: set, wins over the config,
// read where it is used, reset with null, audited with who did it, and kept after a restart. Made-up data only.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AUDIT_RETENTION_DAYS, RUNTIME_CONFIG, auditRetentionRefusal, offeredModels, offeredModelsRefusal } from "@lenspack/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IDENTITY_HEADER, type Identity, signIdentity } from "../src/identity";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const KEY = "k".repeat(64);
// A made-up key for this test only.
const CI = "test-only-ci-key-0123456789abcdefghij";
const now = () => Math.floor(Date.now() / 1000);
const signed = (id: Partial<Identity>) => signIdentity({ u: "someone", a: false, t: now(), ...id }, KEY);
const ADMIN = { u: "ana", r: ["Admin"] };
const VIEWER = { u: "bo", r: ["Gamma"] };

const DATASET = {
  id: 11,
  table_name: "orders",
  schema: "public",
  main_dttm_col: "ordered_at",
  columns: [
    { column_name: "ordered_at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "region", groupby: true, type: "VARCHAR" },
  ],
  metrics: [{ metric_name: "count", expression: "COUNT(*)" }],
};

const CONFIG = (port: number, dir: string) =>
  [
    "superset: { url: env:TEST_SUPERSET_URL }",
    "datasets: [11]",
    "overlay: { pack: shop, panel: dock }",
    "budget: { usdPerDay: 5, usdPerUserPerDay: 1 }",
    "audit: { retentionDays: 120 }",
    "historyTurns: 6",
    "explain: { sql: false }",
    "admin: { surface: separate }",
    "speech: { maxSeconds: 40 }",
    'context: { "role:Sales": { campaign: Spring } }',
    `port: ${port}`,
    `state: ${join(dir, "state", "boards.json")}`,
    "",
  ].join("\n");

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

describe("the rule for what changes at runtime (@lenspack/policy)", () => {
  it("keeps the audit log at least 30 days, or the deploy config's own when that is shorter", () => {
    expect(auditRetentionRefusal(45, 90)).toBeNull();
    expect(auditRetentionRefusal(10, 90)).toMatch(/from 30 to 3650/);
    expect(auditRetentionRefusal(7, 7)).toBeNull();
    expect(auditRetentionRefusal(AUDIT_RETENTION_DAYS.max + 1, 90)).toMatch(/whole number/);
    expect(auditRetentionRefusal(40.5, 90)).toMatch(/whole number/);
  });

  it("offers only models the deployment has keys for, at least one", () => {
    expect(offeredModelsRefusal(["small"], ["small", "big"])).toBeNull();
    expect(offeredModelsRefusal([], ["small", "big"])).toMatch(/one or more/);
    expect(offeredModelsRefusal(["huge"], ["small", "big"])).toMatch(/"huge" is not a model this deployment has a key for/);
    expect(offeredModels([{ name: "small" }, { name: "big" }], ["big"]).map((p) => p.name)).toEqual(["big"]);
    expect(offeredModels([{ name: "small" }, { name: "big" }], null).map((p) => p.name)).toEqual(["small", "big"]);
  });

  it("lists every option with one answer, and keeps secrets, the Superset login, the state and the port in the deploy config", () => {
    for (const k of RUNTIME_CONFIG) expect(["yes", "narrow", "no"]).toContain(k.runtime);
    const no = RUNTIME_CONFIG.filter((k) => k.runtime === "no").map((k) => k.key).join(" | ");
    for (const must of ["superset (url", "host, port, publicPath, state", "LENSPACK_ADMIN_API_KEYS", "LENSPACK_STT_API_KEY", "audit: false"]) expect(no).toContain(must);
    for (const k of RUNTIME_CONFIG.filter((x) => x.runtime === "yes")) expect(k.area).toBeTruthy();
  });
});

describe("changing the deploy config's options on a running Superset-mode server", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-runtime-settings-"));
  // Superset, and an OpenAI-compatible model provider on the same stand-in, which answers every call with "ok".
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
    if (path === "/api/v1/lenspack/access") {
      const q = new URL(req.url ?? "", "http://x").searchParams;
      return send({ result: { datasets: Object.fromEntries((q.get("datasets") ?? "").split(",").filter(Boolean).map((d) => [d, { access: true, rls: [] }])), dashboards: {} } });
    }
    if (path === "/api/v1/dashboard/") return send({ result: [] });
    if (path === "/v1/chat/completions") return send({ id: "x", object: "chat.completion", created: now(), model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not here" }));
  }) as Server;
  let child: ChildProcess | undefined;
  let base = "";
  let output = "";

  const start = async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const config = join(dir, "superset.yaml");
    writeFileSync(config, CONFIG(port, dir));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LENSPACK_|ANTHROPIC_|OPENROUTER_|SUPERSET_)/.test(k)));
    const stand = `http://127.0.0.1:${(superset.address() as AddressInfo).port}`;
    const providers = ["small", "big", "huge"].map((name) => ({ name, baseUrl: `${stand}/v1`, apiKey: "test-only", model: `m-${name}` }));
    output = "";
    child = spawn(join(root, "node_modules/.bin/tsx"), ["--tsconfig", join(root, "tsconfig.base.json"), join(root, "packages/hosts/superset/bin/serve.ts"), config], {
      cwd: root,
      env: { ...env, TEST_SUPERSET_URL: stand, LENSPACK_SUPERSET_PASSWORD: "service-password", LENSPACK_ADMIN_API_KEYS: `ci:${CI}`, LENSPACK_LLM_PROVIDERS: JSON.stringify(providers), LENSPACK_LLM_ROLES: JSON.stringify({ reviewer: "big" }) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (c) => (output += c));
    child.stderr!.on("data", (c) => (output += c));
    for (let i = 0; i < 300 && !output.includes(`${base}/`); i++) {
      if (child.exitCode !== null) throw new Error(`the server stopped: ${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!output.includes(`${base}/`)) throw new Error(`the server did not start: ${output}`);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const gone = new Promise((r) => child!.once("exit", r));
    child.kill();
    await gone;
  };

  const call = async (path: string, o: { method?: string; key?: string; as?: Partial<Identity>; body?: unknown } = {}) => {
    const headers: Record<string, string> = {
      ...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
      ...(o.as ? { [IDENTITY_HEADER]: signed(o.as) } : {}),
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
    };
    const r = await fetch(`${base}${path}`, { method: o.method ?? (o.body !== undefined ? "PUT" : "GET"), headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* a page */
    }
    return { status: r.status, body };
  };
  /** A change with the admin API key, through the admin passthrough's address. */
  const keyed = (area: string, body: unknown) => call(`/_admin/settings/${area}`, { key: CI, body });
  const settings = async () => (await call("/_admin/settings", { key: CI })).body;
  const audit = async () => (await call("/_admin/audit?limit=500", { key: CI })).body.events as { user: string; action: string; outcome: string; detail?: string }[];
  const audited = async (action: string, user = "api:ci") => (await audit()).filter((e) => e.action === action && e.user === user && e.outcome === "ok");

  beforeAll(async () => {
    await new Promise<void>((r) => superset.listen(0, "127.0.0.1", r));
    await start();
  });
  afterAll(async () => {
    await stop();
    superset.close();
  });

  it("shows each option with the deploy config's value, and the inventory of what can change", async () => {
    const s = await settings();
    expect(s.budget).toMatchObject({ usdPerDay: 5, usdPerUserPerDay: 1, defaults: { usdPerDay: 5, usdPerUserPerDay: 1 }, source: { usdPerDay: "config", usdPerUserPerDay: "config" } });
    expect(s.audit).toMatchObject({ retentionDays: 120, defaultDays: 120, min: 30, max: 3650, source: "default" });
    expect(s.history).toMatchObject({ historyTurns: 6, defaultTurns: 6, source: "default" });
    expect(s.explain).toMatchObject({ sql: false, defaultSql: false, source: "default" });
    expect(s.models).toMatchObject({ offered: ["small", "big", "huge"], all: ["small", "big", "huge"], source: "default", roles: { reviewer: "big", escalate: null, router: null }, rolesSource: { reviewer: "env" } });
    expect(s.speech).toMatchObject({ maxSeconds: 40, defaultMaxSeconds: 40 });
    expect(s.context).toMatchObject({ context: { "role:Sales": { campaign: "Spring" } }, source: "default" });
    expect(s.panelSetting).toMatchObject({ panel: "dock", default: "dock", from: "overlay.panel", source: "default" });
    expect(s.adminSurface).toMatchObject({ surface: "separate", default: "separate", from: "admin.surface", source: "default" });
    expect(s.runtime.find((k: { key: string }) => k.key.startsWith("budget"))).toMatchObject({ runtime: "yes", area: "budget" });
  });

  it("is for admins only", async () => {
    for (const area of ["budget", "models", "audit", "history", "explain", "context", "panel", "admin-surface"]) {
      const r = await call(`/_superset/settings/${area}`, { as: VIEWER, body: {} });
      expect([area, r.status]).toEqual([area, 403]);
    }
    expect((await call("/_superset/settings/budget", { body: { usdPerDay: 1 } })).status).toBe(401);
  });

  it("budget: set, wins over the config where chat reads it, refused when bad, reset with null, audited with the key's name", async () => {
    const set = await keyed("budget", { usdPerDay: 2.5, usdPerUserPerDay: 0 });
    expect([set.status, set.body]).toMatchObject([200, { usdPerDay: 2.5, usdPerUserPerDay: null, source: { usdPerDay: "settings", usdPerUserPerDay: "settings" } }]);
    // What chat checks before each turn: the caps in force.
    const usage = await call("/api/_usage", { as: ADMIN });
    expect(usage.body.budget).toMatchObject({ usdPerDay: 2.5 });
    expect(usage.body.budget.usdPerUserPerDay).toBeUndefined();
    expect((await keyed("budget", { usdPerDay: -1 })).status).toBe(400);
    expect((await keyed("budget", { perMonth: 3 })).body.error).toMatch(/unknown setting "perMonth"/);
    expect((await audited("settings budget"))[0]?.detail).toContain("2.5");
    const reset = await call("/_superset/settings/budget", { as: ADMIN, body: { usdPerDay: null, usdPerUserPerDay: null } });
    expect(reset.body).toMatchObject({ usdPerDay: 5, usdPerUserPerDay: 1, source: { usdPerDay: "config" } });
    expect((await audited("settings budget", "ana")).length).toBe(1);
  });

  it("models: offers some of the deployment's models, which the chat lists and the default must be among, and sets roles", async () => {
    expect((await keyed("models", { offered: ["nope"] })).body.error).toMatch(/not a model this deployment has a key for/);
    // A role on a model that isn't offered is refused.
    expect((await keyed("models", { offered: ["small"], roles: { escalate: "big" } })).body.error).toMatch(/roles.escalate is big, which is not offered/);
    const set = await keyed("models", { offered: ["small", "big"], roles: { escalate: "big" } });
    expect([set.status, set.body.offered, set.body.source, set.body.roles]).toEqual([200, ["small", "big"], "settings", { reviewer: "big", escalate: "big", router: null }]);
    // The chat menu lists only what is offered.
    const api = await call("/api/", { as: VIEWER });
    expect(api.body.models.map((m: { name: string }) => m.name)).toEqual(["small", "big"]);
    expect((await call("/_superset/settings/chat", { as: ADMIN, body: { model: "huge" } })).body.error).toMatch(/"huge" is not offered/);
    expect((await settings()).chat.options.map((m: { name: string }) => m.name)).toEqual(["small", "big"]);
    expect((await audited("settings models")).length).toBe(1);
    const reset = await keyed("models", { offered: null, roles: null });
    expect([reset.body.offered, reset.body.source, reset.body.roles.escalate]).toEqual([["small", "big", "huge"], "default", null]);
  });

  it("audit retention: longer or shorter down to 30 days, never below; reset with null", async () => {
    const refused = await keyed("audit", { retentionDays: 7 });
    expect([refused.status, refused.body.error]).toEqual([400, expect.stringMatching(/from 30 to 3650/)]);
    const set = await keyed("audit", { retentionDays: 45 });
    expect(set.body).toMatchObject({ retentionDays: 45, source: "settings" });
    expect((await call("/_admin/audit?limit=1", { key: CI })).body.retentionDays).toBe(45);
    expect((await audited("settings audit"))[0]?.detail).toBe("retentionDays 45");
    expect((await keyed("audit", { retentionDays: null })).body).toMatchObject({ retentionDays: 120, source: "default" });
  });

  it("history, explain, speech and context: set, win over the config, reset with null", async () => {
    expect((await keyed("history", { historyTurns: 12 })).body).toMatchObject({ historyTurns: 12, source: "settings" });
    expect((await keyed("history", { historyTurns: 0 })).status).toBe(400);
    expect((await keyed("explain", { sql: true })).body).toMatchObject({ sql: true, source: "settings" });
    const sp = await keyed("speech", { maxSeconds: 90 });
    expect(sp.body).toMatchObject({ maxSeconds: 90, defaultMaxSeconds: 40 });
    expect((await keyed("speech", { maxSeconds: 4 })).status).toBe(400);
    const ctx = await keyed("context", { context: { "role:Sales": { campaign: "Autumn" }, "*": { country: "Country A" } } });
    expect(ctx.body).toMatchObject({ context: { "role:Sales": { campaign: "Autumn" }, "*": { country: "Country A" } }, source: "settings" });
    expect((await keyed("context", { context: { "role:Sales": { colour: "red" } } })).status).toBe(400);
    for (const a of ["settings history", "settings explain", "settings speech", "settings context"]) expect((await audited(a)).length).toBeGreaterThan(0);
    expect((await keyed("history", { historyTurns: null })).body.historyTurns).toBe(6);
    expect((await keyed("explain", { sql: null })).body.sql).toBe(false);
    expect((await keyed("context", { context: null })).body.source).toBe("default");
  });

  it("panel and admin pages: set, read by the overlay and the pages, reset with null", async () => {
    expect((await call("/_superset/info", { as: VIEWER })).body.panel).toBe("dock");
    expect((await keyed("panel", { panel: "float" })).body).toMatchObject({ panel: "float", source: "settings" });
    expect((await call("/_superset/info", { as: VIEWER })).body.panel).toBe("float");
    expect((await keyed("panel", { panel: "sideways" })).status).toBe(400);
    expect((await keyed("admin-surface", { surface: "superset" })).body).toMatchObject({ surface: "superset", source: "settings" });
    expect((await call("/_superset/info", { as: ADMIN })).body.admin).toMatchObject({ surface: "superset", page: "all", panel: null });
    expect((await audited("settings panel"))[0]?.detail).toBe("panel float");
    expect((await audited("settings admin-surface"))[0]?.detail).toBe("surface superset");
    expect((await audit()).find((e) => e.action === "settings panel" && e.outcome === "refused")?.detail).toMatch(/panel must be/);
    expect((await keyed("admin-surface", { surface: null })).body.surface).toBe("separate");
  });

  it("keeps every admin's value after a restart", async () => {
    await keyed("budget", { usdPerDay: 3 });
    await keyed("models", { offered: ["big"] });
    await keyed("audit", { retentionDays: 365 });
    await keyed("history", { historyTurns: 4 });
    await keyed("explain", { sql: true });
    await keyed("panel", { panel: "float" });
    await keyed("admin-surface", { surface: "split" });
    await keyed("speech", { maxSeconds: 30 });
    await stop();
    await start();
    const s = await settings();
    expect([s.budget.usdPerDay, s.models.offered, s.audit.retentionDays, s.history.historyTurns, s.explain.sql, s.panelSetting.panel, s.adminSurface.surface, s.speech.maxSeconds]).toEqual([3, ["big"], 365, 4, true, "float", "split", 30]);
    expect((await call("/api/_usage", { as: ADMIN })).body.budget.usdPerDay).toBe(3);
  });
});
