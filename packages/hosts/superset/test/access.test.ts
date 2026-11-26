// hostPolicy: superset. Each user's Superset dataset access and row-level security become their policy
// identity, so what Lenspack shows them follows their own Superset roles, not the service account's.
// The clause translator on its own, then the board API end to end against a stand-in Superset that
// records the chart-data requests Lenspack makes for each user.
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { memoryStore } from "@lenspack/core";
import { createApp } from "@lenspack/serve";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type DatasetAccess, SUPERSET_HIDDEN_REASON as HIDDEN, SUPERSET_UNREACHABLE_REASON as UNREACHABLE, accessFallbackFrom, parseClause, rlsScope, stockAccess, supersetPolicy, viewableDashboards } from "../src/access";
import { type SupersetDataset, packFromDatasets } from "../src/catalogue";
import { supersetClient } from "../src/client";
import { supersetConnector } from "../src/connector";
import { IDENTITY_HEADER, type Identity, hostPolicyFrom, signIdentity, supersetAuth } from "../src/identity";

const KEY = "k".repeat(64);
const VISITS: SupersetDataset = {
  id: 1,
  table_name: "visits",
  main_dttm_col: "created_at",
  columns: [
    { column_name: "created_at", is_dttm: true, type: "TIMESTAMP" },
    { column_name: "region", type: "TEXT" },
    { column_name: "team", type: "TEXT" },
    { column_name: "notes", groupby: false, type: "TEXT" },
  ],
  metrics: [{ metric_name: "visit_count", expression: "COUNT(*)" }],
};
const TARGETS: SupersetDataset = { id: 2, table_name: "targets", columns: [{ column_name: "region", type: "TEXT" }], metrics: [{ metric_name: "target_sum", expression: "SUM(n)" }] };
const { pack, packYaml, binding } = packFromDatasets([VISITS, TARGETS], { pack: "lp" });

describe("RLS clauses as filters", () => {
  it("reads =, IN, AND, brackets, quoting and OR over one column", () => {
    expect(parseClause("region = 'north'")).toEqual([{ column: "region", values: ["north"] }]);
    expect(parseClause("region IN ('a', 'b') AND team = 7")).toEqual([
      { column: "region", values: ["a", "b"] },
      { column: "team", values: [7] },
    ]);
    expect(parseClause(`("Region" = 'it''s') and (team in (1))`)).toEqual([
      { column: "Region", values: ["it's"] },
      { column: "team", values: [1] },
    ]);
    // Superset ORs the clauses of one group key: on one column that is an IN.
    expect(parseClause("(region = 'a') OR (region IN ('b', 'a'))")).toEqual([{ column: "region", values: ["a", "b"] }]);
  });

  it("refuses anything else, saying why", () => {
    for (const sql of ["region LIKE 'n%'", "region != 'a'", "region = 'a' OR team = 'b'", "region = upper('a')", "region IN (SELECT r FROM t)", "1 = 1", "region = 'a' AND", "NOT region = 'a'", "region IS NULL", ""])
      expect(parseClause(sql)).toHaveProperty("reason");
  });

  it("binds columns to the entity's dimensions, and fails a template or a column the pack does not have", () => {
    expect(rlsScope(["region = 'north'", "team IN ('x', 'y')"], "visits", binding)).toEqual([
      { entity: "visits", dimension: "region", op: "eq", value: "north" },
      { entity: "visits", dimension: "team", op: "in", value: ["x", "y"] },
    ]);
    expect(rlsScope(["team = '{{ current_username() }}'"], "visits", binding)).toMatchObject({ reason: expect.stringMatching(/template/) });
    expect(rlsScope(["notes = 'x'"], "visits", binding)).toMatchObject({ reason: expect.stringMatching(/"notes", which is not a dimension/) });
  });

  it("reads LENSPACK_HOST_POLICY: Superset's access unless off is chosen", () => {
    expect(hostPolicyFrom(undefined)).toBe("superset");
    expect(hostPolicyFrom("")).toBe("superset");
    expect(hostPolicyFrom(" Superset ")).toBe("superset");
    expect(hostPolicyFrom("off")).toBe("off");
    expect(hostPolicyFrom(" OFF ")).toBe("off");
    expect(() => hostPolicyFrom("yes")).toThrow(/superset/);
  });

  it("reads LENSPACK_ACCESS_FALLBACK: none unless rls-only is chosen", () => {
    expect(accessFallbackFrom(undefined)).toBe("none");
    expect(accessFallbackFrom("")).toBe("none");
    expect(accessFallbackFrom(" None ")).toBe("none");
    expect(accessFallbackFrom(" RLS-only ")).toBe("rls-only");
    expect(() => accessFallbackFrom("yes")).toThrow(/rls-only/);
  });
});

/** Just enough Superset: sign-in, the plugin's access endpoint (or not), the RLS rule list, and chart data. */
function fakeSuperset() {
  const state = {
    plugin: true,
    fail: false,
    access: {} as Record<string, Record<string, DatasetAccess>>,
    dashboards: {} as Record<string, Record<string, boolean>>,
    // Dashboard roles: undefined answers as a plugin from before them (neither field).
    rbac: undefined as boolean | undefined,
    onDashboards: {} as Record<string, Record<string, number[]>>,
    rules: [] as unknown[],
    asked: [] as string[],
    charts: [] as { dataset: number; filters: unknown[] }[],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v1/security/login") return send({ access_token: "token" });
    if (url.pathname === "/api/v1/security/csrf_token/") return send({ result: "csrf" });
    if (url.pathname === "/api/v1/lenspack/access" && state.plugin) {
      state.asked.push(url.searchParams.get("user")!);
      if (state.fail) return send({ message: "boom" }, 500);
      const user = url.searchParams.get("user")!;
      const datasets = (url.searchParams.get("datasets") ?? "").split(",").filter(Boolean);
      const dashboards = (url.searchParams.get("dashboards") ?? "").split(",").filter(Boolean);
      expect(datasets.length === 0 || datasets.join(",") === "1,2").toBe(true);
      const rbac = state.rbac === undefined ? {} : { dashboardRbac: state.rbac, dashboardDatasets: Object.fromEntries(dashboards.map((d) => [d, state.rbac ? (state.onDashboards[user]?.[d] ?? []) : []])) };
      return send({ result: { datasets: datasets.length ? (state.access[user] ?? {}) : {}, dashboards: Object.fromEntries(dashboards.map((d) => [d, state.dashboards[user]?.[d] === true])), ...rbac } });
    }
    if (url.pathname === "/api/v1/rowlevelsecurity/") return send({ result: state.rules, count: state.rules.length });
    if (url.pathname === "/api/v1/chart/data") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const b = JSON.parse(body);
        state.charts.push({ dataset: b.datasource.id, filters: b.queries[0].filters });
        send({ result: [{ data: [] }] });
      });
      return;
    }
    send({ message: "Not found" }, 404);
  });
  return { server, state };
}

describe("hostPolicy: superset, end to end", () => {
  const superset = fakeSuperset();
  const logs: string[] = [];
  const servers: Server[] = [];
  let on: string;
  let off: string;

  const start = async (host: boolean) => {
    const url = `http://127.0.0.1:${(superset.server.address() as AddressInfo).port}`;
    const client = supersetClient({ url, username: "lenspack", password: "service-password" });
    const policy = host ? supersetPolicy({ client, binding, log: (s) => logs.push(s) }) : undefined;
    const hosts = [{ name: "lp", pack, packYaml, connector: supersetConnector(client, binding), store: memoryStore(), ctx: {}, boards: [] }];
    const server = createServer(createApp(hosts, { auth: supersetAuth(() => KEY, "signed-in", () => true, policy) }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lp`;
  };
  const as = (api: string, who: Partial<Identity> & { u: string }) => {
    const headers = { [IDENTITY_HEADER]: signIdentity({ a: false, t: Math.floor(Date.now() / 1000), ...who }, KEY), "content-type": "application/json" };
    const get = async (path: string) => (await fetch(`${api}${path}`, { headers })).json() as Promise<any>;
    return {
      get,
      /** The chart-data requests one filter menu makes, on a fresh board of theirs. */
      options: async (field: string) => {
        const board = (await (await fetch(`${api}/boards`, { method: "POST", headers, body: JSON.stringify({ title: "t", temporary: true }) })).json()) as { id: string };
        superset.state.charts.length = 0;
        const values = await get(`/${board.id}/options?field=${field}`);
        return { values, charts: [...superset.state.charts] };
      },
      keys: async () => {
        const c = (await get("")).catalogue;
        return [...c.dimensions, ...c.measures].map((k: { key: string }) => k.key).sort();
      },
    };
  };
  const ALL = [...pack.dimensions, ...pack.measures].map((k) => k.key).sort();

  beforeAll(async () => {
    await new Promise<void>((r) => superset.server.listen(0, "127.0.0.1", r));
    superset.state.access = {
      alice: { 1: { access: true, rls: ["region = 'north'"] }, 2: { access: true, rls: [] } },
      bob: { 1: { access: false, rls: [] }, 2: { access: true, rls: [] } },
      carol: { 1: { access: true, rls: ["region LIKE 'n%'"] }, 2: { access: true, rls: [] } },
    };
    on = await start(true);
    off = await start(false);
  });
  afterAll(() => {
    for (const s of [...servers, superset.server]) s.close();
  });

  it("off: everyone sees what the service account sees, and Superset is not asked", async () => {
    const bob = as(off, { u: "bob", r: ["Gamma"] });
    expect(await bob.keys()).toEqual(ALL);
    const { charts } = await bob.options("team");
    expect(charts).toEqual([{ dataset: 1, filters: [] }]);
    expect(superset.state.asked).toEqual([]);
  });

  it("narrows every query on a dataset by the user's simple RLS, and no other dataset", async () => {
    const alice = as(on, { u: "alice", r: ["Sales"] });
    expect(await alice.keys()).toEqual(ALL);
    expect((await alice.options("team")).charts).toEqual([{ dataset: 1, filters: [{ col: "region", op: "==", val: "north" }] }]);
    const explained = await alice.get(`/explain?q=${encodeURIComponent(JSON.stringify({ kind: "value", measure: "target_sum" }))}`);
    expect(JSON.parse(explained.sql).queries[0].filters).toEqual([]);
  });

  it("keeps a dataset the user may not read: its keys hidden, any query on it refused", async () => {
    const bob = as(on, { u: "bob", r: ["Gamma"] });
    const keys = await bob.keys();
    expect(keys).not.toContain("team");
    expect(keys).not.toContain("visit_count");
    expect(keys).toContain("region");
    expect(keys).toContain("target_sum");
    const rows = await bob.get(`/explain?q=${encodeURIComponent(JSON.stringify({ kind: "rows", entity: "visits", columns: ["region"], limit: 5 }))}`);
    expect(rows).toMatchObject({ ok: false, code: "ACCESS_HIDDEN", error: `"visits" is not available to you: ${HIDDEN}` });
    // A shared dimension's menu is counted on a dataset they may read.
    expect((await bob.options("region")).charts.map((c) => c.dataset)).toEqual([2]);
  });

  it("fails an unsupported clause closed: the dataset is kept, and the log says why", async () => {
    const carol = as(on, { u: "carol", r: ["Sales"] });
    expect(await carol.keys()).not.toContain("visit_count");
    expect(logs.some((l) => l.includes("visits is kept from carol") && l.includes("LIKE"))).toBe(true);
  });

  it("tells a user up front when every dataset is kept from them, and asks no model; a measure not in the pack keeps its own message", async () => {
    superset.state.access.nobody = { 1: { access: false, rls: [] }, 2: { access: false, rls: [] } };
    const nobody = as(on, { u: "nobody", r: [] });
    const notice = `None of this assistant's data is available to you: ${HIDDEN}`;
    expect((await nobody.get("")).accessNotice).toBe(notice);
    expect(await nobody.keys()).toEqual([]);
    const headers = { [IDENTITY_HEADER]: signIdentity({ u: "nobody", a: false, r: [], t: Math.floor(Date.now() / 1000) }, KEY), "content-type": "application/json" };
    const board = (await (await fetch(`${on}/boards`, { method: "POST", headers, body: JSON.stringify({ title: "t", temporary: true }) })).json()) as { id: string };
    // This server has no model at all: a 503 would mean the chat got as far as looking for one.
    const chat = await fetch(`${on}/${board.id}/chat`, { method: "POST", headers, body: JSON.stringify({ messages: [] }) });
    expect([chat.status, ((await chat.json()) as { error: string }).error]).toEqual([403, notice]);
    // Some data open: no notice.
    expect((await as(on, { u: "bob", r: ["Gamma"] }).get("")).accessNotice).toBeUndefined();
    const missing = await as(on, { u: "bob", r: ["Gamma"] }).get(`/explain?q=${encodeURIComponent(JSON.stringify({ kind: "value", measure: "doses" }))}`);
    expect(missing).toMatchObject({ ok: false, code: "UNKNOWN_MEASURE", error: `"doses" is not a measure in pack "lp"` });
  });

  it("opens the dashboard a request is signed for, even when the answer it was given earlier kept it", async () => {
    const auth = supersetAuth(() => KEY, "superset", () => true, async () => ({ hiddenBoards: ["superset-7", "superset-8"], hiddenReason: HIDDEN }));
    const req = (path: string, d?: number) =>
      ({ url: path, headers: { [IDENTITY_HEADER]: signIdentity({ u: "x", a: false, r: [], t: Math.floor(Date.now() / 1000), ...(d ? { d, b: `superset-${d}`, p: "lp", e: false, v: true } : {}) }, KEY) } }) as never;
    expect((await auth.identify(req("/api/lp/superset-7", 7)))?.hiddenBoards).toEqual(["superset-8"]);
    expect((await auth.identify(req("/api/lp")))?.hiddenBoards).toEqual(["superset-7", "superset-8"]);
  });

  it("asks Superset once a minute per user", async () => {
    const asked = superset.state.asked.filter((u) => u === "alice").length;
    await as(on, { u: "alice", r: ["Sales"] }).keys();
    expect(superset.state.asked.filter((u) => u === "alice").length).toBe(asked);
  });
});

describe("supersetPolicy on its own", () => {
  const superset = fakeSuperset();
  let client: ReturnType<typeof supersetClient>;
  beforeAll(async () => {
    await new Promise<void>((r) => superset.server.listen(0, "127.0.0.1", r));
    client = supersetClient({ url: `http://127.0.0.1:${(superset.server.address() as AddressInfo).port}`, username: "lenspack", password: "service-password" });
  });
  afterAll(() => void superset.server.close());

  it("keeps every dataset from a user Superset could not be asked about, and asks again after the minute", async () => {
    let t = 0;
    const logs: string[] = [];
    const policy = supersetPolicy({ client, binding, log: (s) => logs.push(s), now: () => t });
    superset.state.fail = true;
    expect(await policy("dan", ["Sales"])).toEqual({ hiddenEntities: ["visits", "targets"], hiddenReason: UNREACHABLE });
    expect(logs.at(-1)).toMatch(/could not ask Superset about dan/);
    superset.state.fail = false;
    superset.state.access.dan = { 1: { access: true, rls: [] }, 2: { access: true, rls: [] } };
    expect(await policy("dan", ["Sales"])).toEqual({ hiddenReason: HIDDEN });
    superset.state.access.dan = { 1: { access: false, rls: [] }, 2: { access: true, rls: [] } };
    t = 59_000;
    expect(await policy("dan", ["Sales"])).toEqual({ hiddenReason: HIDDEN });
    t = 61_000;
    expect(await policy("dan", ["Sales"])).toEqual({ hiddenEntities: ["visits"], hiddenReason: HIDDEN });
  });

  it("keeps the bound dashboards Superset says a user may not open, and all of them when it can't be asked", async () => {
    const bound = [7, 8];
    const policy = supersetPolicy({ client, binding, log: () => {}, dashboards: () => bound });
    superset.state.access.fay = { 1: { access: true, rls: [] }, 2: { access: true, rls: [] } };
    superset.state.dashboards.fay = { 7: true, 8: false };
    expect(await policy("fay", ["Sales"])).toEqual({ hiddenBoards: ["superset-8"], hiddenReason: HIDDEN });
    superset.state.fail = true;
    expect(await policy("gus", ["Sales"])).toMatchObject({ hiddenBoards: ["superset-7", "superset-8"], hiddenReason: UNREACHABLE });
    expect(await viewableDashboards(client, "fay", [7, 8])).toEqual(new Set());
    superset.state.fail = false;
    expect(await viewableDashboards(client, "fay", [7, 8, 9])).toEqual(new Set([7]));
  });

  it("passes on the datasets Superset opens on a dashboard through its dashboard roles, by board, with their RLS", async () => {
    const logs: string[] = [];
    const policy = supersetPolicy({ client, binding, log: (s) => logs.push(s), dashboards: () => [7, 8], ttlMs: 0 });
    // hal reads targets everywhere; visits only on dashboard 7, through its dashboard role, under an RLS rule.
    superset.state.access.hal = { 1: { access: false, rls: ["region = 'north'"] }, 2: { access: true, rls: [] } };
    superset.state.dashboards.hal = { 7: true, 8: true };
    superset.state.onDashboards.hal = { 7: [1] };
    superset.state.rbac = true;
    try {
      expect(await policy("hal", ["Gamma"])).toEqual({
        hiddenEntities: ["visits"],
        boardEntities: { "superset-7": { entities: ["visits"], scope: [{ entity: "visits", dimension: "region", op: "eq", value: "north" }] } },
        hiddenReason: HIDDEN,
      });
      expect(logs.at(-1)).toMatch(/dashboard roles \(DASHBOARD_RBAC\) are on/);
      // A clause Lenspack can't read as a filter keeps the dataset from them on the dashboard too, and says why.
      superset.state.access.hal[1] = { access: false, rls: ["region LIKE 'n%'"] };
      expect((await policy("hal", ["Gamma"])).boardEntities).toBeUndefined();
      expect(logs.at(-1)).toMatch(/visits is kept from hal on dashboard 7 too/);
      superset.state.access.hal[1] = { access: false, rls: [] };
      // Dashboard roles off: nothing opens through a dashboard.
      superset.state.rbac = false;
      expect(await policy("hal", ["Gamma"])).toEqual({ hiddenEntities: ["visits"], hiddenReason: HIDDEN });
      expect(logs.at(-1)).toMatch(/dashboard roles \(DASHBOARD_RBAC\) are off/);
      // A plugin from before dashboard roles: nothing opens, and the log says to update it.
      superset.state.rbac = undefined;
      expect(await policy("hal", ["Gamma"])).toEqual({ hiddenEntities: ["visits"], hiddenReason: HIDDEN });
      expect(logs.at(-1)).toMatch(/update it for dashboard roles/);
      // Superset can't be asked: nothing opens anywhere.
      superset.state.rbac = true;
      superset.state.fail = true;
      expect((await policy("hal", ["Gamma"])).boardEntities).toBeUndefined();
    } finally {
      superset.state.fail = false;
      superset.state.rbac = undefined;
    }
  });

  it("refuses everything while Superset answers 404 for the access route, and never remembers it", async () => {
    const logs: string[] = [];
    const policy = supersetPolicy({ client, binding, log: (s) => logs.push(s), dashboards: () => [7] });
    superset.state.access.ivy = { 1: { access: true, rls: ["region = 'north'"] }, 2: { access: false, rls: [] } };
    superset.state.dashboards.ivy = { 7: true };
    // A Superset 404 (a pod without the plugin, a misrouted path prefix), even with RLS rules readable.
    superset.state.plugin = false;
    superset.state.rules = [{ filter_type: "Regular", tables: [{ id: 1 }], roles: [{ name: "Sales" }], group_key: null, clause: "region = 'south'" }];
    try {
      for (let i = 0; i < 3; i++) expect(await policy("ivy", ["Sales"])).toEqual({ hiddenEntities: ["visits", "targets"], hiddenBoards: ["superset-7"], hiddenReason: UNREACHABLE });
      expect(logs.at(-1)).toMatch(/could not ask Superset about ivy \(Superset answered 404 for \/api\/v1\/lenspack\/access/);
      // Another user is refused too: nothing in the process switched to the RLS rules.
      expect(await policy("jon", ["Sales"])).toMatchObject({ hiddenEntities: ["visits", "targets"], hiddenReason: UNREACHABLE });
      // The route is back: the very next request is answered from it, with the dataset access it says.
      superset.state.plugin = true;
      expect(await policy("ivy", ["Sales"])).toEqual({ hiddenEntities: ["targets"], scope: [{ entity: "visits", dimension: "region", op: "eq", value: "north" }], hiddenReason: HIDDEN });
      // And a 404 later still refuses: there is no switch to flip.
      superset.state.plugin = false;
      expect(await supersetPolicy({ client, binding, log: () => {} })("ivy", ["Sales"])).toMatchObject({ hiddenEntities: ["visits", "targets"], hiddenReason: UNREACHABLE });
    } finally {
      superset.state.plugin = true;
      superset.state.rules = [];
    }
  });

  it("with accessFallback: rls-only, reads Superset's RLS rules by role on a 404, and fails a template or missing roles closed", async () => {
    superset.state.plugin = false;
    superset.state.rules = [
      { filter_type: "Regular", tables: [{ id: 1 }], roles: [{ name: "Sales" }], group_key: "r", clause: "region = 'south'" },
      { filter_type: "Regular", tables: [{ id: 1 }], roles: [{ name: "Sales" }], group_key: "r", clause: "region = 'east'" },
      { filter_type: "Base", tables: [{ id: 2 }], roles: [{ name: "Admin" }], group_key: null, clause: "region IN ('a', 'b')" },
      { filter_type: "Regular", tables: [{ id: 2 }], roles: [{ name: "Ops" }], group_key: null, clause: "region = '{{ current_username() }}'" },
    ];
    const logs: string[] = [];
    const policy = supersetPolicy({ client, binding, log: (s) => logs.push(s), fallback: "rls-only", ttlMs: 0 });
    expect(await policy("erin", ["Sales"])).toEqual({
      scope: [
        { entity: "visits", dimension: "region", op: "in", value: ["south", "east"] },
        { entity: "targets", dimension: "region", op: "in", value: ["a", "b"] },
      ],
      hiddenReason: HIDDEN,
    });
    expect(await policy("root", ["Admin"])).toEqual({ hiddenReason: HIDDEN });
    expect(await policy("olu", ["Ops"])).toEqual({ hiddenEntities: ["targets"], hiddenReason: HIDDEN });
    expect(logs.some((l) => /RLS rules from Superset's REST API/.test(l))).toBe(true);
    expect(await policy("old", undefined)).toEqual({ hiddenEntities: ["visits", "targets"], hiddenReason: UNREACHABLE });
    expect(await stockAccess(client, [1], [])).toEqual({ 1: { access: true, rls: [] } });
    // Not remembered either: with the route back, its answer (dataset access included) applies again.
    superset.state.plugin = true;
    superset.state.access.erin = { 1: { access: false, rls: [] }, 2: { access: true, rls: [] } };
    expect(await policy("erin", ["Sales"])).toEqual({ hiddenEntities: ["visits"], hiddenReason: HIDDEN });
  });
});
