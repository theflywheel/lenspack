// dashboardScope: listed. The assistant on the listed dashboards only: bind refuses any other (so the overlay shows no
// button there), the dashboard list and the board API leave it out, and the settings say the scope. Started as a
// deployment runs it: bin/serve.ts as its own process against a stand-in Superset with two dashboards.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OUT_OF_SCOPE_MESSAGE, dashboardScopeFrom, madeBoards } from "../src/dashboard-scope";
import { IDENTITY_HEADER, type Identity, signIdentity } from "../src/identity";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const KEY = "k".repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const signed = (id: Partial<Identity>) => signIdentity({ u: "someone", a: false, t: now(), ...id }, KEY);
const ADMIN = { u: "boss", a: true };
const VIEWER = { u: "viewer", a: false };

describe("the dashboardScope setting", () => {
  it("is any unless set; the environment wins over the file", () => {
    expect(dashboardScopeFrom({})).toEqual({ dashboards: [], scope: { scope: "any" } });
    expect(dashboardScopeFrom({ dashboards: [12] })).toEqual({ dashboards: [12], scope: { scope: "any" } });
    expect(dashboardScopeFrom({ dashboards: [12, 25], dashboardScope: "listed" })).toEqual({ dashboards: [12, 25], scope: { scope: "listed", boards: ["superset-12", "superset-25"] } });
    expect(dashboardScopeFrom({ dashboards: [12], dashboardScope: "listed" }, { LENSPACK_DASHBOARDS: " 25, 31 ", LENSPACK_DASHBOARD_SCOPE: "listed" })).toEqual({ dashboards: [25, 31], scope: { scope: "listed", boards: ["superset-25", "superset-31"] } });
    expect(dashboardScopeFrom({ dashboards: [12], dashboardScope: "listed" }, { LENSPACK_DASHBOARD_SCOPE: "any" }).scope).toEqual({ scope: "any" });
  });

  it("refuses an unknown value, something that is not a dashboard id, and listed with none", () => {
    expect(() => dashboardScopeFrom({ dashboardScope: "mine" })).toThrow('dashboardScope (LENSPACK_DASHBOARD_SCOPE) must be "any" or "listed", not "mine"');
    expect(() => dashboardScopeFrom({}, { LENSPACK_DASHBOARD_SCOPE: "all" })).toThrow(/must be "any" or "listed", not "all"/);
    expect(() => dashboardScopeFrom({ dashboardScope: "listed" })).toThrow(/is "listed" but dashboards \(LENSPACK_DASHBOARDS\) lists none/);
    expect(() => dashboardScopeFrom({ dashboards: ["ops"] })).toThrow('dashboards must be Superset dashboard ids (whole numbers), not "ops"');
    expect(() => dashboardScopeFrom({}, { LENSPACK_DASHBOARDS: "25,,31" })).toThrow(/LENSPACK_DASHBOARDS must be Superset dashboard ids \(whole numbers, separated by commas, like 25,31\), not ""/);
  });

  it("names people's own dashboards by the board they were copied from", () => {
    expect(madeBoards([{ board: "superset-40", from: 25 }, { board: "superset-41", from: null }])).toEqual([{ board: "superset-40", from: "superset-25" }, { board: "superset-41", from: null }]);
  });
});

/** Two dashboards, 7 ("ops") and 8 ("other"), both open to everyone in Superset. */
function fakeSuperset(): Server {
  const dash = (id: number, title: string) => ({ result: { id, dashboard_title: title, position_json: null, json_metadata: null, changed_on: "2026-01-01T00:00:00" } });
  return createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/api/v1/security/login") return send({ access_token: "token" });
    if (path === "/api/v1/security/csrf_token/") return send({ result: "csrf" });
    if (path === "/api/v1/dataset/1") return send({ result: { id: 1, table_name: "visits", schema: "public", main_dttm_col: "created_at", columns: [{ column_name: "created_at", is_dttm: true, type: "TIMESTAMP" }, { column_name: "region", groupby: true, type: "TEXT" }], metrics: [{ metric_name: "visit_count", expression: "COUNT(*)" }] } });
    if (path === "/api/v1/lenspack/identity-key") return send({ result: { key: KEY } });
    if (path === "/api/v1/lenspack/access") {
      const q = new URL(req.url ?? "", "http://x").searchParams;
      const ids = (name: string) => (q.get(name) ?? "").split(",").filter(Boolean);
      return send({ result: { datasets: Object.fromEntries(ids("datasets").map((d) => [d, { access: true, rls: [] }])), dashboards: Object.fromEntries(ids("dashboards").map((d) => [d, true])) } });
    }
    if (path === "/api/v1/dashboard/7" || path === "/api/v1/dashboard/ops") return send(dash(7, "Ops"));
    if (path === "/api/v1/dashboard/8" || path === "/api/v1/dashboard/other") return send(dash(8, "Other team"));
    if (path === "/api/v1/dashboard/7/charts" || path === "/api/v1/dashboard/8/charts") return send({ result: [] });
    if (path === "/api/v1/dashboard/")
      return send({
        result: [
          { id: 7, dashboard_title: "Ops", changed_on_delta_humanized: "a day ago" },
          { id: 8, dashboard_title: "Other team", changed_on_delta_humanized: "a day ago" },
        ],
      });
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

/** Only what a test sets: no model, no switches from the machine running it. */
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LENSPACK_|ANTHROPIC_|OPENROUTER_|SUPERSET_)/.test(k)));
const serve = (config: string, env: Record<string, string>) =>
  spawn(join(root, "node_modules/.bin/tsx"), ["--tsconfig", join(root, "tsconfig.base.json"), join(root, "packages/hosts/superset/bin/serve.ts"), config], { cwd: root, env: { ...cleanEnv(), LENSPACK_SUPERSET_PASSWORD: "service-password", ...env }, stdio: ["ignore", "pipe", "pipe"] });

describe("a server with dashboardScope: listed", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-dashboard-scope-"));
  const superset = fakeSuperset();
  let child: ChildProcess;
  let base: string;
  let output = "";

  const call = async (path: string, init: RequestInit & { as?: Partial<Identity> } = {}) => {
    const { as, ...rest } = init;
    const r = await fetch(`${base}${path}`, { ...rest, headers: { ...(as ? { [IDENTITY_HEADER]: signed(as) } : {}), ...(rest.body ? { "content-type": "application/json" } : {}) } });
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, body };
  };
  const on = (d: number, who: Partial<Identity> = VIEWER) => ({ ...who, d, b: `superset-${d}`, p: "visits_pack", e: true, v: true });

  beforeAll(async () => {
    await new Promise<void>((r) => superset.listen(0, "127.0.0.1", r));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const config = join(dir, "superset.yaml");
    writeFileSync(config, ["superset: { url: env:TEST_SUPERSET_URL }", "datasets: [1]", "dashboards: [7]", "dashboardScope: listed", "overlay: { pack: visits_pack }", `port: ${port}`, `state: ${join(dir, "state", "boards.json")}`, ""].join("\n"));
    child = serve(config, { TEST_SUPERSET_URL: `http://127.0.0.1:${(superset.address() as AddressInfo).port}` });
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

  it("says the scope at start and in the settings", async () => {
    expect(output).toContain("lenspack-superset: dashboards: listed (7)");
    const settings = await call("/_superset/settings", { as: ADMIN });
    expect(settings.body.dashboardScope).toEqual({ scope: "listed", dashboards: [7] });
  });

  it("binds a listed dashboard, by id or slug, and refuses any other, admins too", async () => {
    expect(await call("/_superset/bind?dashboard=ops", { as: on(7) })).toMatchObject({ status: 200, body: { board: "superset-7", dashboard: 7 } });
    expect(await call("/_superset/bind?dashboard=7", { as: on(7) })).toMatchObject({ status: 200, body: { board: "superset-7" } });
    for (const key of ["other", "8"])
      for (const who of [VIEWER, ADMIN]) expect(await call(`/_superset/bind?dashboard=${key}`, { as: on(8, who) })).toMatchObject({ status: 403, body: { error: OUT_OF_SCOPE_MESSAGE, code: "out-of-scope" } });
    // Superset's own check still comes first: a dashboard it did not sign for is refused as before.
    expect(await call("/_superset/bind?dashboard=ops", { as: on(8) })).toMatchObject({ status: 403, body: { error: "Superset did not check your access to this dashboard." } });
    expect((await call("/_superset/settings", { as: ADMIN })).body.dashboards).toEqual([7]);
  });

  it("lists only the listed dashboards", async () => {
    expect(await call("/_superset/dashboards", { as: VIEWER })).toMatchObject({ status: 200, body: [{ id: 7, title: "Ops" }] });
  });

  it("refuses the board API and the chat on any other dashboard", async () => {
    const chat = { method: "POST", body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: "how many?" }] }] }) };
    expect((await call("/api/visits_pack/superset-7", { as: on(7) })).status).toBe(200);
    // No model here: the chat on a listed dashboard gets as far as that (503).
    expect((await call("/api/visits_pack/superset-7/chat", { ...chat, as: on(7) })).status).toBe(503);
    for (const path of ["", "/data", "/suggestions"]) expect([path, (await call(`/api/visits_pack/superset-8${path}`, { as: on(8) })).status]).toEqual([path, 404]);
    expect((await call("/api/visits_pack/superset-8/chat", { ...chat, as: on(8, ADMIN) })).status).toBe(404);
    // The pack's own listing names no board outside the scope.
    expect(((await call("/api/visits_pack", { as: VIEWER })).body.boards as { id: string }[]).map((b) => b.id)).toEqual(["superset-7"]);
  });
});

describe("a server whose dashboard scope is wrong", () => {
  const stops = async (yaml: string[], env: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "lenspack-dashboard-scope-bad-"));
    const config = join(dir, "superset.yaml");
    // Checked before Superset is called, so nothing needs to answer at this address.
    writeFileSync(config, ["superset: { url: http://127.0.0.1:9 }", "datasets: [1]", ...yaml, `state: ${join(dir, "state", "boards.json")}`, ""].join("\n"));
    const child = serve(config, env);
    let out = "";
    child.stdout!.on("data", (c) => (out += c));
    child.stderr!.on("data", (c) => (out += c));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    return { code, out };
  };

  it("does not start, and says which values are allowed", async () => {
    const unknown = await stops(["dashboardScope: some"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.out).toContain('dashboardScope (LENSPACK_DASHBOARD_SCOPE) must be "any" or "listed", not "some"');
    const empty = await stops([], { LENSPACK_DASHBOARD_SCOPE: "listed" });
    expect(empty.code).not.toBe(0);
    expect(empty.out).toContain('is "listed" but dashboards (LENSPACK_DASHBOARDS) lists none');
  });
});
