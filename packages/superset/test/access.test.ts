// hostPolicy: superset. Each user's Superset dataset access and row-level security become their policy
// identity, so what Lenspack shows them follows their own Superset roles, not the service account's.
// The clause translator on its own, then the board API end to end against a stand-in Superset that
// records the chart-data requests Lenspack makes for each user.
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { memoryStore } from "@lenspack/core";
import { createApp } from "@lenspack/serve";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type DatasetAccess, parseClause, rlsScope, stockAccess, supersetPolicy } from "../src/access";
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

  it("reads LENSPACK_HOST_POLICY", () => {
    expect(hostPolicyFrom(undefined)).toBe("off");
    expect(hostPolicyFrom(" Superset ")).toBe("superset");
    expect(() => hostPolicyFrom("yes")).toThrow(/superset/);
  });
});

/** Just enough Superset: sign-in, the plugin's access endpoint (or not), the RLS rule list, and chart data. */
function fakeSuperset() {
  const state = {
    plugin: true,
    fail: false,
    access: {} as Record<string, Record<string, DatasetAccess>>,
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
      expect(url.searchParams.get("datasets")).toBe("1,2");
      return send({ result: { datasets: state.access[url.searchParams.get("user")!] ?? {} } });
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
    expect(rows).toMatchObject({ ok: false, code: "NOT_PERMITTED" });
    // A shared dimension's menu is counted on a dataset they may read.
    expect((await bob.options("region")).charts.map((c) => c.dataset)).toEqual([2]);
  });

  it("fails an unsupported clause closed: the dataset is kept, and the log says why", async () => {
    const carol = as(on, { u: "carol", r: ["Sales"] });
    expect(await carol.keys()).not.toContain("visit_count");
    expect(logs.some((l) => l.includes("visits is kept from carol") && l.includes("LIKE"))).toBe(true);
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
    expect(await policy("dan", ["Sales"])).toEqual({ hiddenEntities: ["visits", "targets"] });
    expect(logs.at(-1)).toMatch(/could not ask Superset about dan/);
    superset.state.fail = false;
    superset.state.access.dan = { 1: { access: true, rls: [] }, 2: { access: true, rls: [] } };
    expect(await policy("dan", ["Sales"])).toEqual({});
    superset.state.access.dan = { 1: { access: false, rls: [] }, 2: { access: true, rls: [] } };
    t = 59_000;
    expect(await policy("dan", ["Sales"])).toEqual({});
    t = 61_000;
    expect(await policy("dan", ["Sales"])).toEqual({ hiddenEntities: ["visits"] });
  });

  it("without the plugin's endpoint, reads Superset's RLS rules by role, and fails a template or missing roles closed", async () => {
    superset.state.plugin = false;
    superset.state.rules = [
      { filter_type: "Regular", tables: [{ id: 1 }], roles: [{ name: "Sales" }], group_key: "r", clause: "region = 'south'" },
      { filter_type: "Regular", tables: [{ id: 1 }], roles: [{ name: "Sales" }], group_key: "r", clause: "region = 'east'" },
      { filter_type: "Base", tables: [{ id: 2 }], roles: [{ name: "Admin" }], group_key: null, clause: "region IN ('a', 'b')" },
      { filter_type: "Regular", tables: [{ id: 2 }], roles: [{ name: "Ops" }], group_key: null, clause: "region = '{{ current_username() }}'" },
    ];
    const logs: string[] = [];
    const policy = supersetPolicy({ client, binding, log: (s) => logs.push(s) });
    expect(await policy("erin", ["Sales"])).toEqual({
      scope: [
        { entity: "visits", dimension: "region", op: "in", value: ["south", "east"] },
        { entity: "targets", dimension: "region", op: "in", value: ["a", "b"] },
      ],
    });
    expect(await policy("root", ["Admin"])).toEqual({});
    expect(await policy("olu", ["Ops"])).toEqual({ hiddenEntities: ["targets"] });
    expect(logs.some((l) => /RLS rules from Superset's REST API/.test(l))).toBe(true);
    expect(await policy("old", undefined)).toEqual({ hiddenEntities: ["visits", "targets"] });
    expect(await stockAccess(client, [1], [])).toEqual({ 1: { access: true, rls: [] } });
  });
});
