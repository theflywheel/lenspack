// Changing the pack while the server runs (docs/hosts/superset/pack-runtime.md): bin/serve.ts started as its own process
// against a stand-in Superset, then its pack changed over HTTP, by a signed-in admin and with an admin API key on the
// admin passthrough. Each change is checked as at start-up and refused with nothing changed when it adds a problem;
// one that passes is a version the chat reads at once, kept after a restart. Made-up data only.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";

import { IDENTITY_HEADER, type Identity, signIdentity } from "../src/identity";
import { buildPack, shapeProblems } from "../src/pack-runtime";
import type { SupersetDataset } from "../src/catalogue";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const KEY = "k".repeat(64);
// A made-up key for this test only.
const CI = "test-only-ci-key-0123456789abcdefghij";
const now = () => Math.floor(Date.now() / 1000);
const signed = (id: Partial<Identity>) => signIdentity({ u: "someone", a: false, t: now(), ...id }, KEY);
const ADMIN = { u: "ana", r: ["Admin"] };
const VIEWER = { u: "bo", r: ["Gamma"] };

const orders = (): SupersetDataset => ({
  id: 11,
  table_name: "orders",
  schema: "public",
  main_dttm_col: "ordered_at",
  columns: [
    { column_name: "ordered_at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "region", groupby: true, type: "VARCHAR" },
    { column_name: "status", groupby: true, type: "VARCHAR" },
    { column_name: "customer_name", groupby: true, type: "VARCHAR" },
    { column_name: "quantity", groupby: true, type: "BIGINT" },
    { column_name: "basket_value", groupby: true, type: "NUMERIC(10,2)" },
  ],
  metrics: [{ metric_name: "count", expression: "COUNT(*)" }],
});

const CONFIG = (port: number, dir: string) =>
  [
    "superset: { url: env:TEST_SUPERSET_URL }",
    "datasets: [11]",
    "scope: [{ dimension: region, op: in, value: [North, South] }]",
    "overlay:",
    "  pack: shop",
    "  description: Orders for the shop.",
    "  timeZone: UTC",
    "  exclude: { columns: [customer_name] }",
    "  notDimensions: [quantity, basket_value]",
    "  measures: [{ dataset: orders, name: items_sold, agg: sum, column: quantity }]",
    "  labels: { region: Region }",
    "  examples:",
    "    - question: { en: Items sold by region, fr: Articles vendus par région }",
    "      query: { kind: breakdown, dimension: region, measure: items_sold }",
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

describe("building and checking a pack as at start-up", () => {
  const base = { pack: "shop", exclude: { columns: ["customer_name"] }, notDimensions: ["quantity", "basket_value"], measures: [{ dataset: "orders", name: "items_sold", agg: "sum" as const, column: "quantity" }] };

  it("finds what a change may not add: overlay mistakes, dropped hierarchies, scope without its dimension, refused examples", () => {
    const ok = buildPack([orders()], base, { scope: [{ dimension: "region", op: "in", value: ["North"] }] });
    expect(ok.findings).toEqual([]);
    const bad = buildPack([orders()], { ...base, notDimensions: ["quantity", "basket_value", "region"], measures: [...base.measures, { dataset: "orders", name: "names", agg: "max", column: "customer_name" }], hierarchies: { place: ["region", "status"] } }, { scope: [{ dimension: "region", op: "in", value: ["North"] }] });
    expect(bad.findings).toEqual([
      'overlay.measures[1] (names): column "customer_name" is excluded (overlay.exclude), so no measure may read it',
      'hierarchies.place: "region" is not a dimension of the pack, so the hierarchy is left out',
      expect.stringMatching(/^the deploy config's scope\[0\] filters on "region", which is not a dimension of the pack/),
    ]);
  });

  it("checks the runtime parts' shapes before building", () => {
    expect(shapeProblems({ labels: { region: 3 }, notDimensions: "quantity", hierarchies: { place: ["region"] }, examples: [{ question: "Q" }], description: 4 })).toEqual([
      "description is text",
      "labels.region is text, or text per language ({ en: …, fr: … })",
      "notDimensions is a list of column names",
      "hierarchies.place is a list of two or more dimension keys, coarse to fine",
      "examples[0] is { question, query }: the question as text (or text per language) and the query that answers it",
    ]);
    expect(shapeProblems({ labels: { region: { en: "Region", fr: "Région" } }, examples: [], description: null })).toEqual([]);
  });
});

describe("changing the pack on a running Superset-mode server", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-pack-runtime-"));
  let dataset = orders();
  const superset = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/api/v1/security/login") return send({ access_token: "token" });
    if (path === "/api/v1/security/csrf_token/") return send({ result: "csrf" });
    if (path === "/api/v1/dataset/11") return send({ result: dataset });
    if (path === "/api/v1/lenspack/identity-key") return send({ result: { key: KEY } });
    if (path === "/api/v1/lenspack/access") {
      const q = new URL(req.url ?? "", "http://x").searchParams;
      return send({ result: { datasets: Object.fromEntries((q.get("datasets") ?? "").split(",").filter(Boolean).map((d) => [d, { access: true, rls: [] }])), dashboards: {} } });
    }
    if (path === "/api/v1/dashboard/") return send({ result: [] });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not here" }));
  }) as Server;
  let child: ChildProcess | undefined;
  let base = "";
  let output = "";
  let config = "";

  const start = async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    config = join(dir, "superset.yaml");
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

  const call = async (path: string, o: { method?: string; key?: string; as?: Partial<Identity>; body?: unknown } = {}) => {
    const headers: Record<string, string> = {
      ...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
      ...(o.as ? { [IDENTITY_HEADER]: signed(o.as) } : {}),
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
    };
    const r = await fetch(`${base}${path}`, { method: o.method ?? "GET", headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* YAML or a page */
    }
    return { status: r.status, headers: r.headers, body };
  };
  const admin = (path: string, o: { method?: string; body?: unknown } = {}) => call(`/_superset/settings/pack${path}`, { ...o, as: ADMIN });
  const keyed = (path: string, o: { method?: string; body?: unknown } = {}) => call(`/_admin/settings/pack${path}`, { ...o, key: CI });
  const audit = async () => (await call("/_admin/audit?limit=500", { key: CI })).body.events as { user: string; action: string; outcome: string; detail?: string }[];
  const packYaml = async () => YAML.parse((await call("/api/shop/pack", { as: ADMIN })).body.yaml);

  beforeAll(async () => {
    await new Promise<void>((r) => superset.listen(0, "127.0.0.1", r));
    await start();
  });
  afterAll(async () => {
    await stop();
    superset.close();
  });

  it("shows the pack as the deploy config gives it, with what may change and what may not", async () => {
    const r = await admin("");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 0, layer: {}, pack: { name: "shop", datasets: 1 }, versions: 0 });
    expect(YAML.parse(r.body.yaml)).toMatchObject({ description: "Orders for the shop.", labels: { region: "Region" }, exclude: { columns: ["customer_name"] } });
    expect(r.body.sources).toMatchObject({ description: "config", labels: "config", hints: "none", exclude: "config" });
    expect(r.body.configOnly.map((c: { field: string }) => c.field)).toEqual(["pack", "entities", "timeZone", "geo", "mapStyle", "panel"]);
    expect(r.body.configOnly[0]).toMatchObject({ field: "pack", value: "shop" });
    expect(r.body.dataBoundary).toEqual(["datasets", "scope", "dashboards", "dashboardScope", "auth", "budget", "models"]);
    expect((await call("/_superset/settings", { as: ADMIN })).body.packLayer).toEqual({ version: 0, fields: [] });
  });

  it("is for admins only", async () => {
    const r = await call("/_superset/settings/pack", { as: VIEWER });
    expect([r.status, r.body.error]).toEqual([403, "only Superset admins can do this"]);
    expect((await call("/_superset/settings/pack", { method: "PUT", as: VIEWER, body: { fields: { description: "x" } } })).status).toBe(403);
    expect((await call("/_superset/settings/pack")).status).toBe(401);
    expect((await audit()).some((e) => e.user === "bo" && e.action === "PUT /_superset/settings/pack" && e.outcome === "denied")).toBe(true);
  });

  it("checks a change without making it, example questions included", async () => {
    const yaml = [
      "description: Orders for the shop, after refunds.",
      "labels: { region: { en: Sales region, fr: Région de vente } }",
      "exclude: { columns: [customer_name] }",
      "notDimensions: [quantity, basket_value]",
      "measures:",
      "  - { dataset: orders, name: items_sold, agg: sum, column: quantity }",
      "  - { dataset: orders, name: largest_basket, agg: max, column: basket_value, format: currency }",
      "examples:",
      "  - { question: Items sold by region, query: { kind: breakdown, dimension: region, measure: items_sold } }",
      "  - { question: Largest basket by region, query: { kind: breakdown, dimension: region, measure: largest_basket } }",
    ].join("\n");
    const r = await admin("/validate", { method: "POST", body: { yaml } });
    expect(r.body).toMatchObject({ ok: true, problems: [], changed: ["description", "labels", "measures", "examples"], pack: { examples: 2 } });
    // Nothing changed.
    expect((await admin("")).body.version).toBe(0);
    expect((await packYaml()).measures.map((m: { key: string }) => m.key)).not.toContain("largest_basket");
  });

  it("refuses a change that adds a problem, saying why, with nothing changed", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ measures: [{ dataset: "orders", name: "weight", agg: "sum", column: "weight_kg" }] }, /overlay.measures\[0\] \(weight\): column "weight_kg" is not a column of Superset dataset "orders"/],
      [{ examples: [{ question: "Weight by region", query: { kind: "breakdown", dimension: "region", measure: "weight" } }] }, /^examples\[0\] \("Weight by region"\): no verified measure "weight"$/],
      [{ examples: [{ question: "Orders by customer", query: { kind: "breakdown", dimension: "customer_name", measure: "orders_count" } }] }, /customer_name/],
      [{ notDimensions: ["quantity", "basket_value", "region"] }, /scope\[0\] filters on "region", which is not a dimension of the pack/],
      [{ hierarchies: { place: ["region", "nowhere"] } }, /hierarchies.place: "nowhere" is not a dimension of the pack/],
      [{ exclude: { columns: ["basket_value"] } }, /exclude.columns: "customer_name" is excluded by the deploy config, and a change here can only add exclusions, never remove one/],
      [{ timeZone: "Europe/Lisbon" }, /^timeZone is set in the deploy config only/],
      [{ entities: { 11: "sales" } }, /^entities is set in the deploy config only/],
      [{ datasets: [11, 12] }, /^datasets is part of the deployment's data boundary/],
      [{ scope: [] }, /^scope is part of the deployment's data boundary/],
      [{ labels: ["Region"] }, /^labels is a map/],
    ];
    for (const [fields, why] of cases) {
      const v = await admin("/validate", { method: "POST", body: { fields } });
      expect([JSON.stringify(fields), v.body.ok]).toEqual([JSON.stringify(fields), false]);
      expect(v.body.problems.join("\n")).toMatch(why);
      const p = await admin("", { method: "PUT", body: { fields } });
      expect(p.status).toBe(400);
      expect(p.body.problems.join("\n")).toMatch(why);
    }
    expect((await admin("")).body.version).toBe(0);
    expect((await audit()).filter((e) => e.action === "pack edit" && e.outcome === "refused").length).toBe(cases.length);
    expect((await admin("/validate", { method: "POST", body: { yaml: "labels: [unclosed" } })).body.problems[0]).toMatch(/^the YAML can't be read/);
  });

  it("makes a change: a new version the chat, the suggested questions and the settings read at once", async () => {
    const r = await admin("", {
      method: "PUT",
      body: {
        why: "the stock team asks about baskets",
        fields: {
          measures: [
            { dataset: "orders", name: "items_sold", agg: "sum", column: "quantity" },
            { dataset: "orders", name: "largest_basket", agg: "max", column: "basket_value", format: "currency", label: "Largest basket" },
          ],
          examples: [
            { question: { en: "Items sold by region", fr: "Articles vendus par région" }, query: { kind: "breakdown", dimension: "region", measure: "items_sold" } },
            { question: { en: "Largest basket by region", fr: "Plus gros panier par région" }, query: { kind: "breakdown", dimension: "region", measure: "largest_basket" } },
          ],
        },
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.version).toMatchObject({ version: 1, by: "ana", action: "edit", summary: "measures, examples", changed: ["measures", "examples"], why: "the stock team asks about baskets" });
    const pack = await packYaml();
    expect(pack.measures.find((m: { key: string }) => m.key === "largest_basket")).toMatchObject({ agg: "max", label: "Largest basket" });
    expect(pack.examples.map((e: { question: string }) => e.question)).toEqual(["Items sold by region", "Largest basket by region"]);
    expect(pack.examples[1].wordings).toEqual(["Plus gros panier par région"]);
    const info = await call("/_superset/info?lang=fr", { as: VIEWER });
    expect(info.body.examples).toEqual(["Articles vendus par région", "Plus gros panier par région"]);
    const settings = (await call("/_superset/settings", { as: ADMIN })).body;
    expect(settings.measures.map((m: { key: string }) => m.key)).toContain("largest_basket");
    expect(settings.packLayer).toEqual({ version: 1, fields: ["measures", "examples"] });
    expect((await audit()).find((e) => e.action === "pack edit" && e.outcome === "ok")).toMatchObject({ user: "ana", detail: "version 1: measures, examples (the stock team asks about baskets)" });
    expect(output).toMatch(/pack: version 1 by ana: measures, examples; 1 dataset, \d+ dimensions, \d+ measures/);
    // Owner-only on disk.
    expect(statSync(join(dir, "state", "pack-layer.json")).mode & 0o777).toBe(0o600);
    // The same change again changes nothing.
    expect((await admin("", { method: "PUT", body: { yaml: (await admin("")).body.yaml } })).status).toBe(409);
  });

  it("takes an admin API key through the admin passthrough, audited as the key", async () => {
    const v = await keyed("/validate", { method: "POST", body: { fields: { hints: { region: "Where the order was delivered" } } } });
    expect(v.body).toMatchObject({ ok: true, changed: ["hints"] });
    const r = await keyed("", { method: "PUT", body: { fields: { hints: { region: "Where the order was delivered" }, labels: { region: "Sales region" } } } });
    expect(r.body.version).toMatchObject({ version: 2, by: "api:ci", summary: "labels, hints" });
    expect((await packYaml()).dimensions.find((d: { key: string }) => d.key === "region")).toMatchObject({ label: "Sales region", hint: "Where the order was delivered" });
    expect((await audit()).find((e) => e.action === "pack edit" && e.user === "api:ci")).toMatchObject({ outcome: "ok", detail: "version 2: labels, hints" });
    // A key reaches these routes on Lenspack's own address too.
    expect((await call("/_superset/settings/pack", { key: CI })).body.version).toBe(2);
  });

  it("changes the query limits with an admin API key through the admin passthrough, audited as the key", async () => {
    const r = await call("/_admin/settings/query-safety", { method: "PUT", key: CI, body: { maxQueriesPerTurn: 30 } });
    expect(r).toMatchObject({ status: 200, body: { ok: true, querySafety: { server: { maxQueriesPerTurn: 30 }, source: "settings" } } });
    expect((await call("/_admin/settings", { key: CI })).body.querySafety.server.maxQueriesPerTurn).toBe(30);
    // Looser than the deployment's own needs confirm, with a key as with a person.
    expect((await call("/_admin/settings/query-safety", { method: "PUT", key: CI, body: { maxQueriesPerTurn: 500 } })).status).toBe(409);
    expect((await audit()).find((e) => e.action === "settings query-safety" && e.user === "api:ci" && e.outcome === "ok")).toMatchObject({ detail: '{"maxQueriesPerTurn":30}' });
    expect((await call("/_admin/settings/query-safety", { method: "PUT", key: CI, body: { maxQueriesPerTurn: null } })).body.querySafety.source).toBe("deployment");
  });

  it("adds exclusions, takes back its own, never the deploy config's", async () => {
    const add = await admin("", { method: "PUT", body: { fields: { exclude: { columns: ["customer_name", "status"] } } } });
    expect(add.body.version).toMatchObject({ version: 3, changed: ["exclude"] });
    let pack = await packYaml();
    expect(pack.dimensions.map((d: { key: string }) => d.key)).not.toContain("status");
    expect((await admin("")).body.sources.exclude).toBe("config and settings");
    // The config's exclusion stays, whatever is sent.
    const remove = await admin("", { method: "PUT", body: { fields: { exclude: { columns: ["status"] } } } });
    expect(remove.status).toBe(400);
    expect(remove.body.error).toMatch(/"customer_name" is excluded by the deploy config/);
    // null hands exclusions back to the config's alone: status comes back, customer_name stays out.
    const back = await admin("", { method: "PUT", body: { fields: { exclude: null } } });
    expect(back.body.version).toMatchObject({ version: 4, changed: ["exclude"] });
    pack = await packYaml();
    expect(pack.dimensions.map((d: { key: string }) => d.key)).toContain("status");
    expect(pack.dimensions.map((d: { key: string }) => d.key)).not.toContain("customer_name");
  });

  it("lists versions, shows one, compares two and exports the overlay as YAML", async () => {
    const list = (await admin("/versions")).body;
    expect(list.current).toBe(4);
    expect(list.versions.map((v: { version: number; by: string }) => [v.version, v.by])).toEqual([[4, "ana"], [3, "ana"], [2, "api:ci"], [1, "ana"]]);
    const one = (await admin("/versions/2")).body;
    expect(one).toMatchObject({ version: 2, by: "api:ci", current: false, layer: { labels: { region: "Sales region" }, hints: { region: "Where the order was delivered" } } });
    expect(YAML.parse(one.yaml).labels).toEqual({ region: "Sales region" });
    expect((await admin("/versions/99")).status).toBe(404);
    const diff = (await admin("/diff?from=1&to=2")).body;
    expect(diff.fields).toEqual([
      { field: "labels", from: { region: "Region" }, to: { region: "Sales region" } },
      { field: "hints", from: null, to: { region: "Where the order was delivered" } },
    ]);
    const exported = await admin("/export");
    expect(exported.headers.get("content-type")).toBe("text/yaml; charset=utf-8");
    expect(exported.body).toMatch(/^# The pack's overlay as it runs now \(version 4, by ana at /);
    const overlay = YAML.parse(exported.body).overlay;
    expect(overlay).toMatchObject({ pack: "shop", timeZone: "UTC", labels: { region: "Sales region" }, exclude: { columns: ["customer_name"] } });
    expect(overlay.measures).toHaveLength(2);
    // An export pasted back as the YAML changes nothing (config-only parts written as the config has them pass).
    expect((await admin("/validate", { method: "POST", body: { yaml: exported.body } })).body).toMatchObject({ ok: true, changed: [] });
    expect(YAML.parse((await admin("/export?version=0")).body).overlay.labels).toEqual({ region: "Region" });
  });

  it("goes back to a version, resets parts or everything, and refuses a change made on an old copy", async () => {
    const stale = await admin("", { method: "PUT", body: { version: 2, fields: { description: "Old copy" } } });
    expect([stale.status, stale.body.error]).toEqual([409, expect.stringMatching(/^the pack was changed since this page read it \(now version 4, by ana\)/)]);
    const rev = await admin("/revert", { method: "POST", body: { version: 1, why: "the new labels confused people" } });
    expect(rev.body.version).toMatchObject({ version: 5, action: "revert", reverts: 1, summary: "back to version 1 (labels, hints)" });
    expect((await packYaml()).dimensions.find((d: { key: string }) => d.key === "region").label).toBe("Region");
    const reset = await keyed("/reset", { method: "POST", body: { fields: ["examples"] } });
    expect(reset.body.version).toMatchObject({ version: 6, action: "reset", by: "api:ci", summary: "examples back to the deploy config" });
    // An example that names largest_basket is gone, the measure stays.
    expect((await packYaml()).examples).toHaveLength(1);
    expect((await admin("/reset", { method: "POST", body: { fields: ["timeZone"] } })).body.error).toMatch(/^timeZone is set in the deploy config only/);
    const events = await audit();
    expect(events.find((e) => e.action === "pack revert")).toMatchObject({ user: "ana", detail: "version 5: back to version 1 (labels, hints) (the new labels confused people)" });
    expect(events.find((e) => e.action === "pack reset" && e.outcome === "ok")).toMatchObject({ user: "api:ci", detail: "version 6: examples back to the deploy config" });
  });

  it("keeps the changes after a restart, and sets aside ones Superset's datasets no longer allow", async () => {
    // Back to the measures and examples of version 1, then a restart: the same pack.
    expect((await admin("/revert", { method: "POST", body: { version: 1 } })).body.version.version).toBe(7);
    await stop();
    await start();
    expect(output).toMatch(/pack: runtime changes in force, version 7 \(measures, examples; by ana at /);
    expect((await admin("")).body.version).toBe(7);
    expect((await packYaml()).measures.map((m: { key: string }) => m.key)).toContain("largest_basket");

    // Superset drops basket_value: the saved example naming largest_basket can't be built, so the config alone runs.
    dataset = { ...orders(), columns: orders().columns.filter((c) => c.column_name !== "basket_value") };
    await stop();
    await start();
    expect(output).toMatch(/warning: the pack's runtime changes \(version 7\) no longer build against Superset's datasets/);
    const r = (await admin("")).body;
    expect(r).toMatchObject({ version: 0, notApplied: { version: 7 } });
    expect((await packYaml()).measures.map((m: { key: string }) => m.key)).not.toContain("largest_basket");
    // Going back to them is refused, with why; resetting everything puts the record straight.
    const again = await admin("/revert", { method: "POST", body: { version: 7 } });
    expect(again.status).toBe(400);
    expect(again.body.problems.join("\n")).toMatch(/largest_basket/);
    expect((await admin("/reset", { method: "POST", body: {} })).body.version).toMatchObject({ version: 8, summary: "everything back to the deploy config" });
    expect((await admin("")).body).toMatchObject({ version: 8, layer: {} });
    expect((await admin("")).body.notApplied).toBeUndefined();
  });
});
