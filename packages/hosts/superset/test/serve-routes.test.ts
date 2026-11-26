// The Superset-mode server as a deployment runs it: bin/serve.ts started as its own process against a
// stand-in Superset, and every /_superset/* route, the pages, the scripts and /healthz called over HTTP.
// These pin what the routes answer, so the server can be rearranged without the overlay noticing.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type Server, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IDENTITY_HEADER, type Identity, signIdentity } from "../src/identity";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const KEY = "k".repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const signed = (id: Partial<Identity>) => signIdentity({ u: "someone", a: false, t: now(), ...id }, KEY);
const ADMIN = { u: "boss", a: true };
const VIEWER = { u: "viewer", a: false };

const DATASET = {
  id: 1,
  table_name: "visits",
  schema: "public",
  main_dttm_col: "created_at",
  columns: [
    { column_name: "created_at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "region", groupby: true, type: "TEXT" },
    // Groups, and has the same name as the saved metric: the metric keeps the key, the column becomes visit_count_value.
    { column_name: "visit_count", groupby: true, type: "BIGINT" },
  ],
  // A metric with no expression is left out, with a warning.
  metrics: [
    { metric_name: "visit_count", expression: "COUNT(*)", verbose_name: "Visits" },
    { metric_name: "half_made", expression: "" },
  ],
};

/** Just enough of Superset's API for Lenspack to start, bind a dashboard and list them; and a model list for speech. */
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
    // Each user's Superset access (hostPolicy: superset, the default): everyone reads the dataset and opens dashboard 7.
    if (path === "/api/v1/lenspack/access") {
      const q = new URL(req.url ?? "", "http://x").searchParams;
      const ids = (name: string) => (q.get(name) ?? "").split(",").filter(Boolean);
      return send({ result: { datasets: Object.fromEntries(ids("datasets").map((d) => [d, { access: true, rls: [] }])), dashboards: Object.fromEntries(ids("dashboards").map((d) => [d, d === "7"])) } });
    }
    if (path === "/api/v1/dashboard/7" || path === "/api/v1/dashboard/ops") return send({ result: { id: 7, dashboard_title: "Ops", position_json: null, json_metadata: null, changed_on: "2026-01-01T00:00:00" } });
    if (path === "/api/v1/dashboard/7/charts") return send({ result: [] });
    if (path === "/api/v1/dashboard/") return send({ result: [{ id: 7, dashboard_title: "Ops", changed_on_delta_humanized: "a day ago" }] });
    // Superset's action log: an export and a permalink on dashboard 7, a chart view there, and an export elsewhere.
    if (path === "/api/v1/log/")
      return send({
        result: [
          { action: "log", dttm: "2026-11-20T10:00:00", dashboard_id: 7, slice_id: 3, json: JSON.stringify({ event_name: "export_csv_dashboard_chart" }), user: { username: "ana" } },
          { action: "log", dttm: "2026-11-20T09:00:00", dashboard_id: null, json: JSON.stringify({ event_name: "copy_permalink", dashboard_id: 7 }), user: { username: "ben" } },
          { action: "log", dttm: "2026-11-20T08:00:00", dashboard_id: 7, json: JSON.stringify({ event_name: "mount_dashboard" }), user: { username: "ana" } },
          { action: "log", dttm: "2026-11-20T07:00:00", dashboard_id: 99, json: JSON.stringify({ event_name: "dashboard_download_as_pdf" }), user: { username: "cleo" } },
        ],
      });
    if (path === "/models") return send({ data: [{ id: "vendor/listen-1", name: "Listen 1", pricing: { prompt: "0.0001", completion: "0" } }] });
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

describe("Superset mode's server", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-superset-serve-"));
  const superset = fakeSuperset();
  let child: ChildProcess;
  let base: string;
  let supersetUrl: string;
  let output = "";

  const call = async (path: string, init: RequestInit & { as?: Partial<Identity> | null } = {}) => {
    const { as, ...rest } = init;
    const r = await fetch(`${base}${path}`, { ...rest, headers: { ...(as ? { [IDENTITY_HEADER]: signed(as) } : {}), ...(rest.body ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) } });
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* a page or a script */
    }
    return { status: r.status, headers: r.headers, body };
  };
  const put = (path: string, body: unknown, as: Partial<Identity> = ADMIN) => call(path, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body), as });

  beforeAll(async () => {
    await new Promise<void>((r) => superset.listen(0, "127.0.0.1", r));
    supersetUrl = `http://127.0.0.1:${(superset.address() as AddressInfo).port}`;
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const config = join(dir, "superset.yaml");
    writeFileSync(
      config,
      [
        "superset: { url: env:TEST_SUPERSET_URL }",
        "datasets: [1]",
        "overlay:",
        "  pack: visits_pack",
        "  examples:",
        "    - { question: { en: Visits by region, fr: Visites par région }, query: { kind: breakdown, dimension: region, measure: visit_count } }",
        `port: ${port}`,
        `state: ${join(dir, "state", "boards.json")}`,
        "budget: { usdPerDay: 5 }",
        `speech: { baseUrl: "${supersetUrl}" }`,
        "",
      ].join("\n"),
    );
    // Only what this test sets: no model, no speech key, no switches from the machine running it.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LENSPACK_|ANTHROPIC_|OPENROUTER_|SUPERSET_)/.test(k)));
    child = spawn(join(root, "node_modules/.bin/tsx"), ["--tsconfig", join(root, "tsconfig.base.json"), join(root, "packages/hosts/superset/bin/serve.ts"), config], {
      cwd: root,
      env: { ...env, TEST_SUPERSET_URL: supersetUrl, LENSPACK_SUPERSET_PASSWORD: "service-password" },
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

  it("answers /healthz and the public scripts without a signature", async () => {
    const health = await call("/healthz");
    expect(health).toMatchObject({ status: 200, body: { ok: true, identity: true } });
    for (const f of ["chat.js", "overlay.js"]) {
      const r = await call(`/${f}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(r.body).toBe(readFileSync(join(root, "packages/hosts/superset/web", f), "utf8"));
    }
  });

  it("allows Superset's origin, and only that, to call it", async () => {
    const pre = await fetch(`${base}/_superset/info`, { method: "OPTIONS", headers: { origin: supersetUrl } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(supersetUrl);
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");
    const other = await fetch(`${base}/_superset/info`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:1" } });
    expect(other.status).toBe(204);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses everything else without Superset's signature", async () => {
    for (const path of ["/_superset/info", "/_superset/settings", "/_superset/dashboards", "/", "/superset/7", "/nowhere"]) {
      expect(await call(path)).toMatchObject({ status: 401, body: { error: "sign in to Superset first" } });
    }
    expect(await call("/api/")).toMatchObject({ status: 401, body: { error: "sign in to use this API" } });
    expect((await call("/_superset/info", { headers: { [IDENTITY_HEADER]: signIdentity({ u: "x", a: true, t: now() }, "z".repeat(64)) } })).status).toBe(401);
  });

  it("tells any signed-in user what the panel needs", async () => {
    const r = await call("/_superset/info?lang=fr", { as: VIEWER });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(r.body).sort()).toEqual(["examples", "examplesByLang", "features", "language", "pack", "panel", "speech"]);
    expect(r.body).toMatchObject({ pack: "visits_pack", panel: "float", speech: { enabled: false }, language: { default: "auto" } });
    expect(r.body.examples).toEqual(["Visites par région"]);
    expect(r.body.examplesByLang).toMatchObject({ en: ["Visits by region"], fr: ["Visites par région"] });
    expect(r.body.language.options).toEqual(expect.arrayContaining(["auto", "en", "fr", "hi"]));
    // Every switch is on by default but the daily review, which costs money.
    const { "review.daily": daily, ...rest } = r.body.features;
    expect(daily).toBe(false);
    expect(Object.values(rest).every((v) => v === true)).toBe(true);
  });

  it("serves the admin panel to Superset admins only, under its own prefix", async () => {
    for (const path of ["/_superset/admin/", "/_superset/admin/api/packs", "/_superset/admin/api/usage/overview"]) expect((await call(path, { as: VIEWER })).status).toBe(403);
    const page = await call("/_superset/admin/", { as: ADMIN });
    expect(page.status).toBe(200);
    const packs = await call("/_superset/admin/api/packs", { as: ADMIN });
    expect(packs.status).toBe(200);
    expect(packs.body.packs.map((p: { name: string }) => p.name)).toEqual(["visits_pack"]);
    expect(packs.body.usage).toMatchObject({ board: "overview" });
    const audit = await call("/_superset/audit", { as: ADMIN });
    expect(audit.body.events).toContainEqual(expect.objectContaining({ user: "viewer", action: "GET /_superset/admin/api/packs", outcome: "denied" }));
  });

  it("names the signed user on the board API", async () => {
    const r = await call("/api/", { as: VIEWER });
    expect(r.status).toBe(200);
    expect(r.body.me).toMatchObject({ user: "viewer", edit: false, maintain: false, usage: false });
    expect(r.body.examples.map((e: { example: string }) => e.example)).toEqual(["visits_pack"]);
    // A Superset admin edits everywhere and reads the usage page; a dashboard's rights are not carried onto the listing.
    expect((await call("/api/", { as: ADMIN })).body.me).toMatchObject({ user: "boss", edit: true, maintain: true, usage: true });
    expect((await call("/api/", { as: { u: "owner", a: false, d: 7, b: "superset-7", e: true, v: true } })).status).toBe(403);
  });

  it("keeps the settings to Superset admins, and audits a refusal", async () => {
    for (const [method, path] of [["GET", "/_superset/settings"], ["GET", "/_superset/audit"], ["GET", "/_superset/turns"], ["PUT", "/_superset/settings/features"], ["PUT", "/_superset/settings/speech"], ["PUT", "/_superset/settings/language"], ["PUT", "/_superset/settings/chat"], ["PUT", "/_superset/settings/cache"], ["GET", "/_superset/cache"], ["POST", "/_superset/cache/abc/pin"]] as const) {
      const r = await call(path, { method, as: VIEWER, ...(method === "PUT" ? { body: "{}" } : {}) });
      expect(r).toMatchObject({ status: 403, body: { error: "only Superset admins can do this" } });
    }
    const audit = await call("/_superset/audit", { as: ADMIN });
    expect(audit.body.events).toContainEqual(expect.objectContaining({ user: "viewer", action: "GET /_superset/settings", outcome: "denied", detail: "not a Superset admin" }));
  });

  it("starts when a column and a metric come to one key, and says what it changed", async () => {
    const r = await call("/_superset/settings", { as: ADMIN });
    expect(r.body.measures).toEqual([expect.objectContaining({ key: "visit_count", agg: "count" })]);
    expect(r.body.dimensions).toBe(2);
    expect(r.body.warnings).toEqual([
      'Superset dataset "visits" (1): metric "half_made" has no SQL expression and is left out',
      'Superset dataset "visits" (1): column "visit_count" and a metric both come to the key "visit_count"; the metric keeps it, and the column is the dimension "visit_count_value"',
    ]);
    for (const w of r.body.warnings) expect(output).toContain(`lenspack-superset: warning: ${w}`);
  });

  it("shows an admin every setting, with no secrets", async () => {
    const r = await call("/_superset/settings", { as: ADMIN });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["audit", "budget", "cache", "chat", "dashboards", "datasets", "dimensions", "editPolicy", "features", "hostPolicy", "language", "llmFrom", "measures", "pack", "panel", "providers", "publicPath", "queue", "speech", "superset", "telemetry", "warnings"]);
    expect(r.body).toMatchObject({
      pack: "visits_pack",
      datasets: [{ id: 1, table: "visits", schema: "public", entity: expect.any(String) }],
      measures: [expect.objectContaining({ key: expect.any(String), agg: "count" })],
      providers: [],
      llmFrom: null,
      budget: { usdPerDay: 5 },
      superset: { url: supersetUrl, username: "lenspack", account: "env" },
      editPolicy: "superset",
      audit: { file: join(dir, "state", "audit.jsonl"), retentionDays: 90 },
      publicPath: "",
      panel: "float",
      chat: { model: null, effort: null, defaultModel: null, source: "default", writable: true, options: [] },
      speech: { enabled: false, keyFrom: null, provider: "openrouter", source: "default", holdMs: 2000, defaultHoldMs: 2000, holdMsRange: { min: 500, max: 3000 }, writable: true },
      language: { default: "auto", titles: "board", board: "en", defaults: { default: "auto", titles: "board", board: "en" }, source: "default", writable: true },
      features: { writable: true },
      cache: { enabled: true, ttlHours: 168, router: "on", maxEntries: 500, freshMinutes: 10, prewarm: { enabled: false, times: ["06:30", "16:30"], timeZone: null, topN: 10, maxUsd: 0.05 }, source: "default", writable: true },
      queue: { maxConcurrent: 8, maxWaiting: 50, maxWaitSeconds: 60, source: "default", writable: true },
    });
    expect(Object.keys(r.body.features).sort()).toEqual(["defaults", "options", "source", "values", "writable"]);
    expect(JSON.stringify(r.body)).not.toContain("service-password");
  });

  it("turns a feature off and back on for everyone", async () => {
    const off = await put("/_superset/settings/features", { voice: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ values: { voice: false }, defaults: { voice: true }, source: { voice: "settings" }, writable: true });
    expect((await call("/_superset/info", { as: VIEWER })).body.features.voice).toBe(false);
    expect((await put("/_superset/settings/features", { voice: null })).body).toMatchObject({ values: { voice: true }, source: { voice: "default" } });
    expect(await put("/_superset/settings/features", { voyce: false })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^unknown feature "voyce"/) } });
    expect(await put("/_superset/settings/features", { voice: "off" })).toMatchObject({ status: 400, body: { error: "voice must be true, false or null" } });
    expect((await put("/_superset/settings/features", "{not json")).status).toBe(400);
    expect(await put("/_superset/settings/features", "[1]")).toMatchObject({ status: 400, body: { error: "body must be a JSON object" } });
  });

  it("changes the saved-answer settings, and shows the saved answers to admins", async () => {
    const r = await put("/_superset/settings/cache", { router: "off", ttlHours: 24 });
    expect(r).toMatchObject({ status: 200, body: { router: "off", ttlHours: 24, source: "settings", defaults: { router: "on", ttlHours: 168 } } });
    expect(await put("/_superset/settings/cache", { ttlHours: 0 })).toMatchObject({ status: 400, body: { error: expect.stringContaining("ttlHours") } });
    expect((await put("/_superset/settings/cache", { router: null, ttlHours: null })).body).toMatchObject({ router: "on", ttlHours: 168, source: "default" });
    const list = await call("/_superset/cache", { as: ADMIN });
    expect(list).toMatchObject({ status: 200, body: { stats: { hits: { t1: 0, t2: 0, t3: 0, t4: 0 }, misses: expect.any(Number) }, entries: expect.any(Array) } });
    expect((await call("/_superset/cache/nothing/evict", { method: "POST", as: ADMIN })).status).toBe(404);
    expect((await call("/_superset/cache/suggestions", { as: ADMIN })).status).toBe(400);
    expect(list.body.queue).toMatchObject({ running: 0, waiting: 0 });
    // The refresh schedule merges: a change to one field keeps the others.
    expect((await put("/_superset/settings/cache", { prewarm: { enabled: true, times: ["07:00"] } })).body.prewarm).toMatchObject({ enabled: true, times: ["07:00"], topN: 10 });
    expect((await put("/_superset/settings/cache", { prewarm: { topN: 3 } })).body.prewarm).toMatchObject({ enabled: true, times: ["07:00"], topN: 3 });
    expect((await put("/_superset/settings/cache", { prewarm: { times: ["7am"] } })).status).toBe(400);
    expect((await put("/_superset/settings/cache", { prewarm: null })).body.prewarm).toMatchObject({ enabled: false, times: ["06:30", "16:30"] });
    expect((await call("/_superset/cache/prewarm", { method: "POST", as: ADMIN })).body).toMatchObject({ ok: true });
    expect((await call("/_superset/cache/data-changed", { method: "POST", as: ADMIN, body: "{}" })).status).toBe(202);
    // The queue's limits.
    expect((await put("/_superset/settings/queue", { maxConcurrent: 2 })).body).toMatchObject({ maxConcurrent: 2, maxWaiting: 50, source: "settings" });
    expect((await put("/_superset/settings/queue", { maxConcurrent: 0 })).status).toBe(400);
    expect((await put("/_superset/settings/queue", { maxConcurrent: null })).body).toMatchObject({ maxConcurrent: 8, source: "default" });
  });

  it("sets the speech model and the hold, and lists the models", async () => {
    const models = await call("/_superset/settings/speech/models", { as: VIEWER });
    expect(models).toMatchObject({ status: 200, body: [{ id: "vendor/listen-1", name: "Listen 1", usdPerMinute: 0.006 }] });
    expect(await put("/_superset/settings/speech", { holdMs: 100 })).toMatchObject({ status: 400, body: { error: "holdMs is a whole number of milliseconds from 500 to 3000" } });
    expect(await put("/_superset/settings/speech", { model: "nobody/nothing" })).toMatchObject({ status: 400, body: { error: "not a transcription model: nobody/nothing" } });
    const set = await put("/_superset/settings/speech", { model: "vendor/listen-1", holdMs: 1500 });
    expect(set).toMatchObject({ status: 200, body: { model: "vendor/listen-1", source: "settings", holdMs: 1500 } });
    expect((await put("/_superset/settings/speech", { model: null, holdMs: null })).body).toMatchObject({ source: "default", holdMs: 2000 });
  });

  it("sets the language defaults", async () => {
    const set = await put("/_superset/settings/language", { default: "fr", titles: "speaker" });
    expect(set).toMatchObject({ status: 200, body: { default: "fr", titles: "speaker", board: "en", source: "settings" } });
    expect((await call("/_superset/info", { as: VIEWER })).body.language.default).toBe("fr");
    expect(await put("/_superset/settings/language", { titles: "loud" })).toMatchObject({ status: 400, body: { error: "bad titles: loud" } });
    expect(await put("/_superset/settings/language", { board: "auto" })).toMatchObject({ status: 400, body: { error: "bad board: auto" } });
    expect((await put("/_superset/settings/language", { default: null, titles: null })).body).toMatchObject({ default: "auto", titles: "board", source: "default" });
  });

  it("checks a chat model against the providers, and resets it", async () => {
    expect(await put("/_superset/settings/chat", { model: "nope" })).toMatchObject({ status: 400, body: { error: 'unknown model "nope": one of ' } });
    expect(await put("/_superset/settings/chat", { model: null })).toMatchObject({ status: 200, body: { model: null, source: "default", options: [] } });
  });

  it("reads the audit log and the turns from it", async () => {
    const audit = await call("/_superset/audit?limit=500", { as: ADMIN });
    expect(audit).toMatchObject({ status: 200, body: { enabled: true, retentionDays: 90, months: ["current"] } });
    expect(audit.body.events).toContainEqual(expect.objectContaining({ user: "boss", action: "settings features", outcome: "ok", detail: '{"voice":false}' }));
    expect(audit.body.events).toContainEqual(expect.objectContaining({ user: "boss", action: "settings language" }));
    expect(audit.body.events).toContainEqual(expect.objectContaining({ user: "boss", action: "settings chat", detail: "reset" }));
    expect(await call("/_superset/audit?month=last", { as: ADMIN })).toMatchObject({ status: 400, body: { error: 'month must be YYYY-MM, not "last"' } });
    const turns = await call("/_superset/turns", { as: ADMIN });
    expect(turns.status).toBe(200);
    expect(turns.body).toMatchObject({ enabled: true, recent: [], today: { turns: 0 }, week: { turns: 0 } });
    expect(existsSync(join(dir, "state", "audit.jsonl"))).toBe(true);
  });

  it("lists Superset's dashboards and binds one on first use", async () => {
    expect(await call("/_superset/dashboards", { as: VIEWER })).toMatchObject({ status: 200, body: [{ id: 7, title: "Ops", changed: "a day ago" }] });
    // Only the dashboard Superset checked the user may view: the slug resolves to 7, and 7 is what was signed.
    expect(await call("/_superset/bind?dashboard=ops", { as: { ...VIEWER, d: 8, e: false, v: true } })).toMatchObject({ status: 403 });
    expect(await call("/_superset/bind?dashboard=ops", { as: VIEWER })).toMatchObject({ status: 403 });
    expect((await call("/_superset/settings", { as: ADMIN })).body.dashboards).toEqual([]);
    expect(await call("/_superset/bind?dashboard=ops", { as: { ...VIEWER, d: 7, e: false, v: true } })).toMatchObject({ status: 200, body: { board: "superset-7", dashboard: 7, title: "Ops", notes: [] } });
    expect((await call("/_superset/settings", { as: ADMIN })).body.dashboards).toEqual([7]);
    expect((await call("/api/visits_pack/superset-7", { as: { ...VIEWER, d: 7, b: "superset-7", p: "visits_pack", e: false, v: true } })).status).toBe(200);
    // Superset signs every request about a dashboard board; one it did not sign for is refused.
    expect((await call("/api/visits_pack/superset-7", { as: VIEWER })).status).toBe(403);
  });

  it("refuses a dot segment or an encoded slash in the path before reading it", async () => {
    // fetch() would resolve "..", so these go out byte for byte.
    const raw = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const { hostname, port } = new URL(base);
        const r = request({ hostname, port, path, headers: { [IDENTITY_HEADER]: signed({ ...VIEWER, d: 7, e: false, v: true }) } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on("error", reject);
        r.end();
      });
    for (const path of ["/x/../_superset/bind?dashboard=ops", "/x/%2e%2e/_superset/bind?dashboard=ops", "/_superset%2fbind?dashboard=ops", "/api/visits_pack/superset-1/../superset-7"]) expect(await raw(path)).toBe(400);
  });

  it("serves the pages with the panel's settings written in", async () => {
    const vars = (html: string) => JSON.parse(/window\.__lp=(.*?);<\/script>/.exec(html)![1]!);
    const index = await call("/", { as: VIEWER });
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(vars(index.body)).toMatchObject({ pack: "visits_pack", panel: "float", supersetPort: Number(new URL(supersetUrl).port), supersetUrl: null, base: "" });
    const embed = await call("/superset/7", { as: VIEWER, headers: { "x-forwarded-host": "bi.example.org", "x-forwarded-proto": "https" } });
    expect(vars(embed.body)).toMatchObject({ dashboard: 7, supersetUrl: "https://bi.example.org", examples: { en: ["Visits by region"] } });
    expect(embed.body).not.toContain("__BASE__");
  });

  it("records the Superset role names telemetry reads from the signed identity, and none when none are signed", async () => {
    const event = (as: Partial<Identity>) => call("/api/_telemetry", { method: "POST", body: JSON.stringify({ type: "chart-exported", choice: "png" }), as });
    expect((await event({ u: "field-1", a: false, r: ["Gamma", "Supervisor-A"] })).status).toBe(202);
    expect((await event({ u: "older-plugin", a: false })).status).toBe(202);
    expect((await call("/_superset/telemetry?type=event", { as: VIEWER })).status).toBe(403);
    const page = await call("/_superset/telemetry?type=event", { as: ADMIN });
    expect(page.status).toBe(200);
    const roles = Object.fromEntries(page.body.records.map((r: { user: string; roles: string[] }) => [r.user, r.roles]));
    expect(roles).toMatchObject({ "field-1": ["Gamma", "Supervisor-A"], "older-plugin": [] });
    expect(existsSync(join(dir, "state", "telemetry.jsonl"))).toBe(true);
  });

  it("reads exports and shares done in Superset on the dashboards Lenspack works on, for admins", async () => {
    expect((await call("/_superset/telemetry/superset-actions", { as: VIEWER })).status).toBe(403);
    const r = await call("/_superset/telemetry/superset-actions?from=2026-11-19&to=2026-11-21", { as: ADMIN });
    expect(r.status).toBe(200);
    // Dashboard 7 is bound (above); 99 is not Lenspack's, and a plain view is neither an export nor a share.
    expect(r.body).toMatchObject({ available: true, actions: [
      { dashboard: 7, chart: 3, event: "export_csv_dashboard_chart", user: "ana" },
      { dashboard: 7, chart: null, event: "copy_permalink", user: "ben" },
    ] });
    expect(r.body.actions).toHaveLength(2);
  });

  it("answers 404 for a signed request to nowhere", async () => {
    expect(await call("/nowhere", { as: VIEWER })).toMatchObject({ status: 404, body: { error: "not found" } });
  });
});
