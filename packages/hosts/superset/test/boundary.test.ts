// The deployment's data boundary on a running server (docs/hosts/superset/runtime.md#the-boundary-narrows-only): an
// admin, or an admin API key, may narrow the datasets, the scope, the dashboards, the host and edit policies and who
// administers and uses the assistant; never widen any past the deploy config. The policy (boundary.ts) on its own, then
// bin/serve.ts as its own process against a stand-in Superset. Made-up data only.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Boundary, boundaryRefusals, narrowAdminAccess, narrowedBoundary, narrowingStillValid, narrowRights, usersUnder } from "@lenspack/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IDENTITY_HEADER, type Identity, signIdentity } from "../src/identity";

const DEPLOY: Boundary = {
  datasets: [11, "public.returns"],
  scope: [{ dimension: "region", op: "in", value: ["North", "South"] }],
  dashboards: { scope: "listed", boards: ["superset-25", "superset-31"] },
  hostPolicy: "off",
  accessFallback: "rls-only",
  editPolicy: "signed-in",
  adminAccess: ["superset-role", "password"],
  adminRoles: ["Admin", "Ops"],
  usageRoles: ["Admin", "Ops"],
  adminUsers: [],
  userAccess: ["superset-role", "granted"],
  userRoles: ["Gamma", "Sales"],
  seedUsers: ["cy", "dee"],
};

describe("the boundary policy: narrowing only", () => {
  it("lets each field narrow", () => {
    const narrowing = {
      datasets: ["PUBLIC.RETURNS"],
      scope: [{ dimension: "region", op: "eq", value: "North" }],
      dashboards: ["superset-25"],
      hostPolicy: "superset",
      accessFallback: "none",
      editPolicy: "superset",
      adminAccess: ["superset-role"],
      adminRoles: ["Admin"],
      usageRoles: [],
      userAccess: ["granted"],
      userRoles: ["Sales"],
      seedUsers: ["cy"],
    };
    for (const [k, v] of Object.entries(narrowing)) expect([k, boundaryRefusals(DEPLOY, { [k]: v })]).toEqual([k, []]);
    expect(boundaryRefusals(DEPLOY, narrowing, {})).toEqual([]);
    const b = narrowedBoundary(DEPLOY, narrowing as never);
    expect(b.datasets).toEqual(["public.returns"]);
    // The deploy config's clause always stays; the admin's is added.
    expect(b.scope).toEqual([...DEPLOY.scope, { dimension: "region", op: "eq", value: "North" }]);
    expect(b.dashboards).toEqual({ scope: "listed", boards: ["superset-25"] });
    expect([b.hostPolicy, b.accessFallback, b.editPolicy]).toEqual(["superset", "none", "superset"]);
    expect(usersUnder({ modes: b.userAccess, seeded: b.seedUsers, granted: [] }, b.userRoles?.map((r) => `role:${r}`))).toEqual(["cy"]);
  });

  it("refuses each field widening", () => {
    const widening: Record<string, unknown> = {
      datasets: [11, 12],
      dashboards: ["superset-25", "superset-99"],
      hostPolicy: "off",
      accessFallback: "rls-only",
      editPolicy: "signed-in",
      adminAccess: ["superset-role", "superset-users"],
      adminRoles: ["Admin", "Alpha"],
      usageRoles: ["Gamma"],
      adminUsers: ["mallory"],
      userAccess: ["everyone"],
      userRoles: ["Gamma", "Public"],
      seedUsers: ["mallory"],
    };
    for (const [k, v] of Object.entries(widening)) {
      const why = boundaryRefusals(DEPLOY, { [k]: v });
      expect([k, why.length]).toEqual([k, 1]);
      expect(why[0]).toMatch(/would widen the deployment's boundary|may only be set to/);
    }
    // At least one dataset, one dashboard and one admin mode stay; a scope clause has the clause's shape.
    expect(boundaryRefusals(DEPLOY, { datasets: [] })[0]).toMatch(/at least one/);
    expect(boundaryRefusals(DEPLOY, { scope: [{ dimension: "region" }] })[0]).toMatch(/scope\[0\] is a filter clause/);
    expect(boundaryRefusals(DEPLOY, { colour: "red" })[0]).toMatch(/not part of the boundary/);
  });

  it("refuses fields that widen together: superset-role alone, with no role named, is everyone", () => {
    const open: Boundary = { ...DEPLOY, userRoles: undefined };
    expect(boundaryRefusals(open, { userAccess: ["superset-role"] })).toEqual([]);
    expect(boundaryRefusals(open, { userAccess: ["superset-role"] }, {})[0]).toMatch(/lets everyone signed in use the assistant/);
  });

  it("under dashboardScope any, or user access everyone, any list narrows", () => {
    const wide: Boundary = { ...DEPLOY, dashboards: { scope: "any" }, userAccess: ["everyone"], userRoles: undefined, seedUsers: [] };
    expect(boundaryRefusals(wide, { dashboards: ["superset-7"], userAccess: ["superset-role"], userRoles: ["Analyst"] }, {})).toEqual([]);
    const b = narrowedBoundary(wide, { dashboards: ["superset-7"], userAccess: ["superset-role"], userRoles: ["Analyst"] });
    expect(b.dashboards).toEqual({ scope: "listed", boards: ["superset-7"] });
    expect(usersUnder({ modes: b.userAccess, seeded: [], granted: [] }, b.userRoles?.map((r) => `role:${r}`))).toEqual(["role:Analyst"]);
  });

  it("narrows the admin access policy decides on, and the host's role rules", () => {
    const state = narrowAdminAccess({ modes: ["superset-role", "password"], roles: ["role:Admin", "role:Ops"], owners: [], granted: [], passwords: ["ops"] }, { adminAccess: ["superset-role"], adminUsers: [], adminRoles: ["Ops"] });
    expect([state.modes, state.roles]).toEqual([["superset-role"], ["role:Ops"]]);
    const r = narrowRights({ editors: [], maintainers: [], admins: ["role:Admin", "role:Ops"], usage: ["role:Admin", "role:Ops"] }, { adminRoles: ["Ops"], usageRoles: [], userRoles: undefined });
    expect([r.admins, r.usage]).toEqual([["role:Ops"], []]);
  });

  it("sets aside a saved narrowing the deploy config no longer allows", () => {
    const r = narrowingStillValid({ ...DEPLOY, datasets: [11] }, { datasets: ["public.returns"], editPolicy: "superset" });
    expect(r.kept).toEqual({ editPolicy: "superset" });
    expect(r.dropped[0]).toMatch(/datasets: "public.returns" is not in the deploy config's datasets/);
  });
});

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const KEY = "k".repeat(64);
// A made-up key for this test only.
const CI = "test-only-ci-key-0123456789abcdefghij";
const now = () => Math.floor(Date.now() / 1000);
const signed = (id: Partial<Identity>) => signIdentity({ u: "someone", a: false, t: now(), ...id }, KEY);
const ADMIN = { u: "ana", r: ["Admin"] };
const OPS = { u: "olu", r: ["Ops"] };
const GAMMA = { u: "bo", r: ["Gamma"] };
const SALES = { u: "sam", r: ["Sales"] };

const dataset = (id: number, table: string) => ({
  id,
  table_name: table,
  schema: "public",
  main_dttm_col: "at",
  columns: [
    { column_name: "at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "region", groupby: true, type: "VARCHAR" },
  ],
  metrics: [{ metric_name: "count", expression: "COUNT(*)" }],
});

const CONFIG = (port: number, dir: string) =>
  [
    "superset: { url: env:TEST_SUPERSET_URL }",
    "datasets: [11, 12]",
    "overlay: { pack: shop }",
    "scope: [{ dimension: region, op: in, value: [North, South] }]",
    "dashboards: [25, 31]",
    "dashboardScope: listed",
    "hostPolicy: off",
    "editPolicy: signed-in",
    "auth: { admins: [Admin, Ops], users: [Gamma, Sales], userAccess: [superset-role, granted], seedUsers: [cy] }",
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

describe("narrowing the boundary on a running Superset-mode server", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-boundary-"));
  const accessAsked: string[] = [];
  const superset = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/api/v1/security/login") return send({ access_token: "token" });
    if (path === "/api/v1/security/csrf_token/") return send({ result: "csrf" });
    if (path === "/api/v1/dataset/11") return send({ result: dataset(11, "orders") });
    if (path === "/api/v1/dataset/12") return send({ result: dataset(12, "returns") });
    if (path === "/api/v1/lenspack/identity-key") return send({ result: { key: KEY } });
    if (path === "/api/v1/lenspack/access") {
      const q = new URL(req.url ?? "", "http://x").searchParams;
      accessAsked.push(q.get("user") ?? "");
      return send({ result: { datasets: Object.fromEntries((q.get("datasets") ?? "").split(",").filter(Boolean).map((d) => [d, { access: true, rls: [] }])), dashboards: {} } });
    }
    if (/^\/api\/v1\/dashboard\/\d+/.test(path)) return send({ result: path.endsWith("/charts") ? [] : { id: Number(path.split("/")[4]), dashboard_title: "A dashboard", position_json: "{}", json_metadata: "{}" } });
    if (path === "/api/v1/dashboard/") return send({ result: [] });
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
    output = "";
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
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const gone = new Promise((r) => child!.once("exit", r));
    child.kill();
    await gone;
  };
  const call = async (path: string, o: { key?: string; as?: Partial<Identity>; body?: unknown } = {}) => {
    const headers: Record<string, string> = {
      ...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
      ...(o.as ? { [IDENTITY_HEADER]: signed(o.as) } : {}),
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
    };
    const r = await fetch(`${base}${path}`, { method: o.body !== undefined ? "PUT" : "GET", headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* a page */
    }
    return { status: r.status, body };
  };
  const narrow = (body: unknown) => call("/_admin/settings/boundary", { key: CI, body });
  const settings = async () => (await call("/_admin/settings", { key: CI })).body;
  const audit = async () => (await call("/_admin/audit?limit=500", { key: CI })).body.events as { user: string; action: string; outcome: string; detail?: string }[];
  const datasetsNow = async () => ((await settings()).datasets as { id: number }[]).map((d) => d.id);
  const mayUse = async (as: Partial<Identity>) => (await call("/api/", { as })).status;

  beforeAll(async () => {
    await new Promise<void>((r) => superset.listen(0, "127.0.0.1", r));
    await start();
  });
  afterAll(async () => {
    await stop();
    superset.close();
  });

  it("shows the deploy config's boundary, the narrowing and the one in force, for admins only", async () => {
    const b = (await settings()).boundary;
    expect(b.deploy).toMatchObject({ datasets: [11, 12], hostPolicy: "off", editPolicy: "signed-in", dashboards: { scope: "listed", dashboards: [25, 31] }, userRoles: ["Gamma", "Sales"] });
    expect(b.narrowed).toEqual({});
    expect(b.source).toBe("config");
    expect(b.rule).toMatch(/narrow only/);
    expect((await call("/_superset/settings/boundary", { as: GAMMA, body: { editPolicy: "superset" } })).status).toBe(403);
    expect((await call("/_superset/settings/boundary", { body: { editPolicy: "superset" } })).status).toBe(401);
  });

  it("datasets: fewer is built again and swapped in; more is refused; null hands them back", async () => {
    expect(await datasetsNow()).toEqual([11, 12]);
    const wider = await narrow({ datasets: [11, 12, 13] });
    expect([wider.status, wider.body.error]).toEqual([400, expect.stringMatching(/"13" is not in the deploy config's datasets .* would widen/)]);
    const fewer = await narrow({ datasets: [11] });
    expect([fewer.status, fewer.body.now.datasets]).toEqual([200, [11]]);
    expect(await datasetsNow()).toEqual([11]);
    expect((await audit()).find((e) => e.action === "settings boundary" && e.outcome === "ok")).toMatchObject({ user: "api:ci", detail: expect.stringContaining("datasets [11] (pack built again") });
    expect((await audit()).find((e) => e.action === "settings boundary" && e.outcome === "refused")?.detail).toMatch(/would widen/);
    expect((await narrow({ datasets: null })).body.now.datasets).toEqual([11, 12]);
    expect(await datasetsNow()).toEqual([11, 12]);
  });

  it("scope: a clause is added to the deploy config's and checked first; one the pack can't apply is refused", async () => {
    const bad = await narrow({ scope: [{ dimension: "colour", op: "eq", value: "red" }] });
    expect([bad.status, bad.body.error]).toEqual([400, expect.stringMatching(/nothing changed: the scope clause an admin added, scope\[0\] filters on "colour", which is not a dimension/)]);
    expect((await settings()).scope).toHaveLength(1);
    const ok = await call("/_superset/settings/boundary", { as: ADMIN, body: { scope: [{ dimension: "region", op: "eq", value: "North" }] } });
    expect(ok.status).toBe(200);
    expect((await settings()).scope).toEqual([
      { dimension: "region", op: "in", value: ["North", "South"] },
      { dimension: "region", op: "eq", value: "North" },
    ]);
    expect((await audit()).find((e) => e.action === "settings boundary" && e.user === "ana" && e.outcome === "ok")).toBeTruthy();
    expect((await narrow({ scope: null })).body.now.scope).toHaveLength(1);
  });

  it("dashboards: fewer of the listed ones; another is refused", async () => {
    expect((await narrow({ dashboards: [25, 99] })).body.error).toMatch(/"superset-99" is not one of the deploy config's listed dashboards/);
    const r = await narrow({ dashboards: [25] });
    expect(r.body.now.dashboards).toEqual({ scope: "listed", dashboards: [25] });
    expect((await settings()).dashboardScope).toEqual({ scope: "listed", dashboards: [25] });
    await narrow({ dashboards: null });
  });

  it("host and edit policies: on, never off", async () => {
    const r = await narrow({ hostPolicy: "superset", editPolicy: "superset" });
    expect(r.status).toBe(200);
    expect((await settings())).toMatchObject({ hostPolicy: "superset", editPolicy: "superset" });
    // Each person's own Superset access is asked for again, from the next request.
    accessAsked.length = 0;
    await call("/api/", { as: { u: "sam-2", r: ["Sales"] } });
    expect(accessAsked).toContain("sam-2");
    expect((await narrow({ hostPolicy: "off" })).body.error).toMatch(/would widen/);
    expect((await narrow({ hostPolicy: null, editPolicy: null })).body.now).toMatchObject({ hostPolicy: "off", editPolicy: "signed-in" });
  });

  it("access: fewer admin roles, user roles and seeded people; more are refused", async () => {
    expect(await mayUse(GAMMA)).toBe(200);
    expect((await call("/_superset/settings/boundary", { as: OPS })).status).toBe(200);
    expect((await narrow({ adminRoles: ["Admin", "Alpha"] })).body.error).toMatch(/"Alpha" is not in the deploy config's adminRoles/);
    expect((await narrow({ userRoles: ["Gamma", "Public"] })).body.error).toMatch(/would widen/);
    expect((await narrow({ userAccess: ["everyone"] })).body.error).toMatch(/would widen/);
    expect((await narrow({ seedUsers: ["mallory"] })).body.error).toMatch(/would widen/);
    const r = await narrow({ adminRoles: ["Admin"], userRoles: ["Sales"] });
    expect(r.status).toBe(200);
    // Ops is no longer an admin, and Gamma no longer uses the assistant; the key still works.
    expect((await call("/_superset/settings/boundary", { as: OPS })).status).toBe(403);
    expect(await mayUse(GAMMA)).toBe(403);
    expect(await mayUse(SALES)).toBe(200);
    expect((await call("/_superset/settings/boundary", { as: ADMIN })).status).toBe(200);
    await narrow({ adminRoles: null, userRoles: null });
    expect(await mayUse(GAMMA)).toBe(200);
  });

  it("keeps the narrowing after a restart, and builds the pack for it at start", async () => {
    await narrow({ datasets: [12], scope: [{ dimension: "region", op: "eq", value: "South" }], editPolicy: "superset", userRoles: ["Sales"] });
    await stop();
    await start();
    const s = await settings();
    expect(s.datasets.map((d: { id: number }) => d.id)).toEqual([12]);
    expect(s.scope).toHaveLength(2);
    expect(s.editPolicy).toBe("superset");
    expect(s.boundary).toMatchObject({ source: "settings", narrowed: { datasets: [12], editPolicy: "superset", userRoles: ["Sales"] } });
    expect(await mayUse(GAMMA)).toBe(403);
  });
});
