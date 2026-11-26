// Own dashboards and saved layouts against a real Superset (6.1 and 5.0), through its REST API as Lenspack's
// account does it. Skipped unless LENSPACK_TEST_SUPERSET_URL is set. To run it, for each version:
//
//   docker run -d --name lp-superset-test -p 127.0.0.1:18088:8088 -e SUPERSET_CONFIG_PATH=/cfg/superset_config.py \
//     -e PYTHONPATH=/plugin:/cfg -v "$PWD/packages/hosts/superset/plugin:/plugin:ro" -v "<folder>:/cfg:ro" \
//     apache/superset:6.1.0 sh -c 'superset db upgrade && superset fab create-admin --username admin --firstname A \
//       --lastname D --email a@example.invalid --password <admin password> && superset init && superset run -h 0.0.0.0 -p 8088 --with-threads'
//   docker exec lp-superset-test superset fab create-user --role Gamma --username lp_viewer --firstname V --lastname W --email v@example.invalid --password <any>
//   docker exec lp-superset-test superset fab create-user --role Gamma --username lp_other --firstname O --lastname T --email o@example.invalid --password <any>
//   docker exec lp-superset-test python -c "import sqlite3; c = sqlite3.connect('/tmp/lp-data.db'); \
//     c.execute('create table stock_moves (moved_at date, facility_level text, quantity integer)'); \
//     c.execute(\"insert into stock_moves values ('2026-01-01', 'level 1', 3)\"); c.commit()"
//   LENSPACK_TEST_SUPERSET_URL=http://127.0.0.1:18088 LENSPACK_TEST_SUPERSET_PASSWORD=<admin password> \
//     npx vitest run packages/hosts/superset/test/personal-live.test.ts
//   docker rm -f lp-superset-test
//
// (superset_config.py as for the plugin's tests, with PREVENT_UNSAFE_DB_CONNECTIONS = False for the SQLite data;
// apache/superset:5.0.0 the same way.) It makes its own database connection, dataset and dashboards.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type PersonalDashboard, type SavedLayout, memoryRecords, memoryStore } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/pack";
import { PERSONAL_DEFAULTS } from "@lenspack/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SupersetClient, rison, supersetClient } from "../src/client";
import { fetchDatasets, packFromDatasets } from "../src/catalogue";
import { personalDashboards } from "../src/personal";
import { supersetBoards } from "../src/store";

const URL_ = process.env.LENSPACK_TEST_SUPERSET_URL;

describe.skipIf(!URL_)("own dashboards in a real Superset", () => {
  let client: SupersetClient;
  let t: Awaited<ReturnType<typeof build>>;
  const made: number[] = [];
  const run = Date.now().toString(36);

  async function userId(name: string): Promise<number> {
    const r = await client.get<{ result: { value: number; extra?: { email?: string } }[] }>(`/api/v1/dashboard/related/owners?q=${rison({ filter: name, page_size: 20 })}`);
    const hit = r.result.find((u) => u.extra?.email?.startsWith(name === "lp_viewer" ? "v@" : name === "lp_other" ? "o@" : "a@"));
    if (!hit) throw new Error(`no Superset user ${name}: create it first (see the comment at the top)`);
    return hit.value;
  }

  async function build() {
    // A connection and a dataset of our own, with a saved metric.
    const db = await client.post<{ id: number }>("/api/v1/database/", { database_name: `lp personal ${run}`, sqlalchemy_uri: "sqlite:////tmp/lp-data.db", expose_in_sqllab: false });
    const ds = await client.post<{ id: number }>("/api/v1/dataset/", { database: db.id, table_name: "stock_moves" });
    const got = await client.get<{ result: { columns: { id: number; column_name: string }[] } }>(`/api/v1/dataset/${ds.id}`);
    await client.put(`/api/v1/dataset/${ds.id}`, {
      main_dttm_col: "moved_at",
      columns: got.result.columns.map((c) => ({ id: c.id, column_name: c.column_name, groupby: c.column_name === "facility_level", is_dttm: c.column_name === "moved_at" })),
      metrics: [{ metric_name: "quantity", expression: "SUM(quantity)" }],
    });
    const datasets = await fetchDatasets(client, [ds.id]);
    const { pack, binding } = packFromDatasets(datasets, { pack: "stock", entities: { [String(ds.id)]: "move" } });
    const dashboards: Record<string, number> = {};
    const links = memoryRecords<PersonalDashboard>();
    const store = supersetBoards({
      inner: memoryStore(),
      client,
      pack,
      binding,
      dashboards,
      stateFile: join(mkdtempSync(join(tmpdir(), "lp-live-")), "boards.json"),
      ownersOf: async (b) => {
        const l = dashboards[b] === undefined ? null : await links.get(String(dashboards[b]));
        return l ? [l.ownerId] : undefined;
      },
    });
    const bindBoard = async (id: number) => {
      const board = `superset-${id}`;
      if (dashboards[board] === undefined) {
        dashboards[board] = id;
        await store.pull(board, true);
      }
      return board;
    };
    const personal = personalDashboards({ client, store, pack, bindBoard, links, layouts: memoryRecords<SavedLayout>(), limits: () => PERSONAL_DEFAULTS });
    // The official dashboard: the admin's, one chart made through Lenspack.
    const official = await client.post<{ id: number }>("/api/v1/dashboard/", { dashboard_title: `Official ${run}`, owners: [await userId("admin")] });
    made.push(official.id);
    const board = await bindBoard(official.id);
    const added = await store.patch({ id: board, ops: [{ op: "add_widget", id: "moved", widget: { kind: "kpi", title: "Stock moved", query: { kind: "value", measure: pack.measures[0]!.key } } as never }], catalogue: catalogueFrom(pack) });
    if (!added.ok) throw new Error(added.error);
    const viewer = { user: "lp_viewer", userId: await userId("lp_viewer"), admin: false };
    const other = { user: "lp_other", userId: await userId("lp_other"), admin: false };
    const admin = { user: "admin", userId: await userId("admin"), admin: true };
    return { pack, store, personal, official: official.id, board, viewer, other, admin, ds: ds.id, db: db.id };
  }

  beforeAll(async () => {
    client = supersetClient({ url: URL_!, username: process.env.LENSPACK_TEST_SUPERSET_ADMIN ?? "admin", password: process.env.LENSPACK_TEST_SUPERSET_PASSWORD ?? "" });
    t = await build();
  });

  afterAll(async () => {
    if (!client || !t) return;
    for (const d of made) await client.delete(`/api/v1/dashboard/${d}`).catch(() => {});
    const charts = await client.get<{ result: { id: number }[] }>(`/api/v1/chart/?q=${rison({ filters: [{ col: "datasource_id", opr: "eq", value: t.ds }], page_size: 100 })}`).catch(() => ({ result: [] }));
    for (const c of charts.result) await client.delete(`/api/v1/chart/${c.id}`).catch(() => {});
    await client.delete(`/api/v1/dataset/${t.ds}`).catch(() => {});
    await client.delete(`/api/v1/database/${t.db}`).catch(() => {});
  });

  const chartsOn = async (d: number) => (await client.get<{ result: { id: number }[] }>(`/api/v1/dashboard/${d}/charts`)).result.map((c) => c.id);
  const ownersOf = async (kind: "dashboard" | "chart", id: number) => (await client.get<{ result: { owners: { id: number }[] } }>(`/api/v1/${kind}/${id}`)).result.owners.map((o) => o.id);

  it("copies a dashboard with Superset's copy API: the person owns the copy and its charts, which are new", async () => {
    const original = await chartsOn(t.official);
    expect(original).toHaveLength(1);
    const r = await t.personal.copy(t.viewer, { dashboard: t.official, view: true, edit: false });
    if (!r.ok) throw new Error(r.error);
    made.push(r.dashboard);
    expect(await ownersOf("dashboard", r.dashboard)).toEqual([t.viewer.userId]);
    const copies = await chartsOn(r.dashboard);
    expect(copies).toHaveLength(1);
    expect(copies[0]).not.toBe(original[0]);
    expect(await ownersOf("chart", copies[0]!)).toEqual([t.viewer.userId]);
    expect(await chartsOn(t.official)).toEqual(original);
    // Bound: the copy's board has the chart as a widget Lenspack can edit.
    const board = (await t.store.get(r.board))!;
    expect(Object.values(board.config.widgets).map((w) => w.title)).toEqual(["Stock moved"]);
    // Someone else can't delete it; its owner can, and its copied chart goes with it.
    expect(await t.personal.remove(t.other, r.dashboard)).toMatchObject({ ok: false, code: "not-yours" });
    expect(await t.personal.remove(t.viewer, r.dashboard)).toMatchObject({ ok: true });
    await expect(client.get(`/api/v1/dashboard/${r.dashboard}`)).rejects.toThrow(/404/);
    await expect(client.get(`/api/v1/chart/${copies[0]}`)).rejects.toThrow(/404/);
    expect(await chartsOn(t.official)).toEqual(original);
  });

  it("makes a blank one, applies a saved layout to it with new charts the person owns, and an admin may delete it", async () => {
    const blank = await t.personal.create(t.viewer, `Mine ${run}`);
    if (!blank.ok) throw new Error(blank.error);
    made.push(blank.dashboard);
    expect(await ownersOf("dashboard", blank.dashboard)).toEqual([t.viewer.userId]);
    const config = (await t.store.get(t.board))!.config;
    expect((await t.personal.saveLayout(t.viewer, { dashboard: t.official, view: true, edit: false, board: t.board }, "Morning", config)).ok).toBe(true);
    // Not on the official dashboard, which they can only view.
    expect(await t.personal.applyLayout(t.viewer, "Morning", { board: t.board, edit: false, ctx: {} })).toMatchObject({ ok: false, code: "no-edit" });
    const r = await t.personal.applyLayout(t.viewer, "Morning", { board: blank.board, edit: true, ctx: {} });
    if (!r.ok) throw new Error(r.error);
    const charts = await chartsOn(blank.dashboard);
    expect(charts).toHaveLength(1);
    expect(await ownersOf("chart", charts[0]!)).toEqual([t.viewer.userId]);
    expect(charts).not.toEqual(await chartsOn(t.official));
    expect(await t.personal.remove(t.admin, blank.dashboard)).toMatchObject({ ok: true });
  });
});
