// The Superset-mode server started as a deployment runs it (bin/serve.ts, its own process) while Superset is down,
// then refusing the service sign-in, then closing a connection mid-answer: it stays up past the old limit with
// /healthz alive and /readyz not ready, the chat's routes answer 503 "starting", and it becomes ready by itself once
// Superset answers. A mistake no wait fixes (bad YAML, a dataset Superset doesn't have, malformed admin API keys)
// still stops it at once.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const KEY = "k".repeat(64);
const DATASET = {
  id: 1,
  table_name: "visits",
  schema: "public",
  main_dttm_col: "created_at",
  columns: [
    { column_name: "created_at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "region", groupby: true, type: "TEXT" },
  ],
  metrics: [{ metric_name: "visit_count", expression: "COUNT(*)" }],
};

type Mode = "down" | "refusing" | "up";

/** A stand-in Superset: 503 while down, 401 on the sign-in while refusing; once up, it closes the first dashboard read. */
function fakeSuperset() {
  const s = { mode: "down" as Mode, logins: 0, dashboardReads: 0 };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (s.mode === "down") return send(503, { message: "Service Unavailable" });
    if (path === "/api/v1/security/login") {
      s.logins++;
      return s.mode === "refusing" ? send(401, { message: "Not authorized" }) : send(200, { access_token: "token" });
    }
    if (path === "/api/v1/security/csrf_token/") return send(200, { result: "csrf" });
    if (path === "/api/v1/dataset/") return send(200, { result: [] });
    if (path === "/api/v1/dataset/1") return send(200, { result: DATASET });
    if (path === "/api/v1/lenspack/identity-key") return send(200, { result: { key: KEY } });
    if (path === "/api/v1/dashboard/7") {
      // Superset closing the socket mid-seed (the flake seen in CI): read again, never a failed start.
      if (s.dashboardReads++ === 0) return void req.socket.destroy();
      return send(200, { result: { id: 7, dashboard_title: "Ops", position_json: null, json_metadata: null, changed_on: "2026-01-01T00:00:00" } });
    }
    if (path === "/api/v1/dashboard/7/charts") return send(200, { result: [] });
    send(404, { message: "not here" });
  });
  return Object.assign(s, { server });
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Only what each test sets: no model, no switches from the machine running it.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LENSPACK_|ANTHROPIC_|OPENROUTER_|SUPERSET_)/.test(k)));

function start(config: string, env: Record<string, string>) {
  let output = "";
  const child = spawn(join(root, "node_modules/.bin/tsx"), ["--tsconfig", join(root, "tsconfig.base.json"), join(root, "packages/hosts/superset/bin/serve.ts"), config], {
    cwd: root,
    env: { ...cleanEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (c) => (output += c));
  child.stderr!.on("data", (c) => (output += c));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, exited, output: () => output };
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms: number, said: () => string) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ok()) return;
  throw new Error(`${what} did not happen in ${ms} ms:\n${said()}`);
}

const children: ChildProcess[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const c of children) c.kill();
  for (const s of servers) s.close();
});

describe("starting while Superset is down or refusing", () => {
  it("stays up past the old limit, not ready, and becomes ready by itself once Superset answers", async () => {
    const superset = fakeSuperset();
    servers.push(superset.server);
    await new Promise<void>((r) => superset.server.listen(0, "127.0.0.1", r));
    const supersetUrl = `http://127.0.0.1:${(superset.server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), "lp-startup-serve-"));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const config = join(dir, "superset.yaml");
    writeFileSync(config, [`superset: { url: "${supersetUrl}" }`, "datasets: [1]", "dashboards: [7]", "overlay: { pack: visits_pack }", `port: ${port}`, `state: ${join(dir, "state", "boards.json")}`, ""].join("\n"));
    const lp = start(config, { LENSPACK_SUPERSET_PASSWORD: "service-password", LENSPACK_STARTUP_RETRY_SECONDS: "0.1,0.2" });
    children.push(lp.child);
    const get = async (p: string) => {
      const r = await fetch(base + p).catch(() => null);
      return r ? { status: r.status, body: (await r.json()) as any } : null;
    };
    const tries = () => (lp.output().match(/trying again in/g) ?? []).length;

    // Superset down (503): past the old limit of five tries, and still answering.
    await until("the address answering", async () => (await get("/healthz"))?.status === 200, 30_000, lp.output);
    await until("ten tries", () => tries() >= 10, 30_000, lp.output);
    expect(lp.child.exitCode).toBeNull();
    expect(lp.output()).toContain("reading the datasets from Superset failed: Superset answered 503 (not up yet, or restarting); trying again in 0.2 s");
    expect(await get("/healthz")).toMatchObject({ status: 200, body: { ok: true, ready: false } });
    const notReady = await get("/readyz");
    expect(notReady?.status).toBe(503);
    expect(notReady?.body).toMatchObject({ ready: false, reason: expect.stringContaining("reading the datasets from Superset failed: Superset answered 503") });
    // The chat's routes refuse with "starting", which the chat's scripts show as restarting, reconnecting.
    expect(await get("/_superset/info")).toMatchObject({ status: 503, body: { code: "starting", error: expect.stringContaining("starting") } });

    // Superset up but refusing the service sign-in (401): still trying, still up.
    superset.mode = "refusing";
    await until("a refused sign-in", () => lp.output().includes("Superset refused the service sign-in (401)"), 30_000, lp.output);
    const logins = superset.logins;
    await until("more sign-ins", () => superset.logins >= logins + 3, 30_000, lp.output);
    expect(lp.child.exitCode).toBeNull();
    expect((await get("/readyz"))?.status).toBe(503);

    // Fixed: ready by itself, without a restart; the dashboard whose first read was cut off is read again.
    superset.mode = "up";
    await until("ready", async () => (await get("/readyz"))?.status === 200, 60_000, lp.output);
    expect(await get("/healthz")).toMatchObject({ status: 200, body: { ok: true, ready: true, identity: true } });
    expect(lp.output()).toContain("reading dashboard 7 failed (Superset closed the connection mid-answer); reading it again in 0.5 s");
    expect(lp.output()).toContain(`${base}/`);
    expect(lp.child.exitCode).toBeNull();
  }, 120_000);
});

describe("mistakes no wait fixes still stop the start at once", () => {
  const supersetUp = async () => {
    const superset = fakeSuperset();
    superset.mode = "up";
    servers.push(superset.server);
    await new Promise<void>((r) => superset.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(superset.server.address() as AddressInfo).port}`;
  };
  const write = async (lines: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "lp-startup-stop-"));
    const config = join(dir, "superset.yaml");
    writeFileSync(config, [...lines, `port: ${await freePort()}`, `state: ${join(dir, "state", "boards.json")}`, ""].join("\n"));
    return config;
  };
  const stops = async (config: string, env: Record<string, string>, said: RegExp) => {
    const lp = start(config, { LENSPACK_SUPERSET_PASSWORD: "service-password", LENSPACK_STARTUP_RETRY_SECONDS: "0.1", ...env });
    children.push(lp.child);
    const code = await Promise.race([lp.exited, sleep(60_000).then(() => "still running")]);
    expect(code, lp.output()).toBe(1);
    expect(lp.output()).toMatch(said);
    expect(lp.output()).not.toContain("trying again in");
    return lp.output();
  };

  it("a dataset name Superset says doesn't exist, once signed in", async () => {
    const config = await write([`superset: { url: "${await supersetUp()}" }`, "datasets: [orders]", "overlay: { pack: p }"]);
    await stops(config, {}, /Superset dataset "orders": not found/);
  }, 90_000);

  it("malformed LENSPACK_ADMIN_API_KEYS, even with Superset unreachable", async () => {
    // Nothing listens on this port: a config mistake is found before Superset is asked anything.
    const config = await write([`superset: { url: "http://127.0.0.1:${await freePort()}" }`, "datasets: [1]", "overlay: { pack: p }"]);
    const out = await stops(config, { LENSPACK_ADMIN_API_KEYS: "script:short" }, /LENSPACK_ADMIN_API_KEYS/);
    expect(out).not.toContain("answering /healthz");
  }, 90_000);

  it("bad YAML", async () => {
    const config = await write(["superset: { url: http://127.0.0.1:1", "datasets: [1"]);
    await stops(config, {}, /./);
  }, 90_000);
});
