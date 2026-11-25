import { describe, expect, it } from "vitest";

import { type SupersetClient, type SupersetDataset, fetchDatasets, incompleteDataset, packFromDatasets } from "../src/index";

const task: SupersetDataset = {
  id: 12,
  table_name: "child_visits",
  schema: "analytics",
  main_dttm_col: "visit_date",
  columns: [
    { column_name: "visit_date", is_dttm: true, type: "DATE" },
    { column_name: "lga", groupby: true, type: "TEXT" },
    { column_name: "team", groupby: true, type: "TEXT" },
    { column_name: "outcome", groupby: true, type: "TEXT" },
  ],
  metrics: [{ metric_name: "visits", expression: "count()" }],
};
const stock: SupersetDataset = {
  id: 13,
  table_name: "team_stock",
  schema: "analytics",
  columns: [
    { column_name: "lga", groupby: true, type: "TEXT" },
    { column_name: "team", groupby: true, type: "TEXT" },
    { column_name: "reason", groupby: true, type: "TEXT" },
  ],
  metrics: [{ metric_name: "vials_issued", expression: "sum(vials_issued)" }],
};
const byId: Record<number, SupersetDataset> = { 12: task, 13: stock };
const idByName: Record<string, number> = { child_visits: 12, team_stock: 13 };

/** A Superset that answers badly the first `bad` times for each path, then properly. */
function flaky(bad: Record<string, (path: string) => unknown> = {}, times = 1): SupersetClient & { calls: string[] } {
  const seen = new Map<string, number>();
  const calls: string[] = [];
  return {
    url: "http://superset",
    calls,
    async get(path: string) {
      calls.push(path);
      const n = (seen.get(path) ?? 0) + 1;
      seen.set(path, n);
      const list = /^\/api\/v1\/dataset\/\?q=/.test(path);
      const key = list ? "list" : "detail";
      if (n <= times && bad[key]) return bad[key]!(path) as any;
      if (list) {
        const name = /value:([A-Za-z_]+)\)/.exec(decodeURIComponent(path))?.[1] ?? "";
        const d = byId[idByName[name]!];
        return { result: d ? [{ id: d.id, table_name: d.table_name, schema: d.schema }] : [] } as any;
      }
      const id = Number(/\/api\/v1\/dataset\/(\d+)/.exec(path)?.[1]);
      return { result: structuredClone(byId[id]) } as any;
    },
    post: async () => ({}) as any,
    put: async () => ({}) as any,
    delete: async () => ({}) as any,
  };
}
const fast = { sleep: async () => {} };

describe("fetching datasets from a busy Superset", () => {
  it("retries a name lookup that comes back empty", async () => {
    const client = flaky({ list: () => ({ result: [] }) });
    const got = await fetchDatasets(client, ["analytics.child_visits"], fast);
    expect(got.map((d) => d.id)).toEqual([12]);
  });

  it("retries a dataset that comes back with no columns, or with a column twice", async () => {
    const noColumns = flaky({ detail: (p) => ({ result: { ...byId[Number(/(\d+)$/.exec(p)![1])], columns: [] } }) });
    expect((await fetchDatasets(noColumns, [12], fast))[0]!.columns).toHaveLength(4);
    const doubled = flaky({ detail: (p) => { const d = byId[Number(/(\d+)$/.exec(p)![1])]!; return { result: { ...d, columns: [...d.columns, d.columns[1]!] } }; } });
    expect((await fetchDatasets(doubled, [12], fast))[0]!.columns).toHaveLength(4);
  });

  it("retries a name lookup answered with another dataset (Superset 5 and 6.1 list filters race between threads)", async () => {
    const swapped = flaky({ list: () => ({ result: [{ id: 13, table_name: "team_stock", schema: "analytics" }] }) }, 2);
    const got = await fetchDatasets(swapped, ["analytics.child_visits", "analytics.team_stock"], fast);
    expect(got.map((d) => d.table_name)).toEqual(["child_visits", "team_stock"]);
  });

  it("never builds from a swapped lookup, even when every answer is swapped", async () => {
    const always = flaky({ list: () => ({ result: [{ id: 13, table_name: "team_stock", schema: "analytics" }] }) }, 99);
    await expect(fetchDatasets(always, ["analytics.child_visits"], { ...fast, attempts: 3 })).rejects.toThrow(/"analytics.child_visits": the lookup answered with "analytics.team_stock"/);
    expect(always.calls.some((c) => c === "/api/v1/dataset/13")).toBe(false);
  });

  it("gives up with a clear error naming the dataset", async () => {
    const never = flaky({ list: () => ({ result: [] }) }, 99);
    await expect(fetchDatasets(never, ["analytics.child_visits"], { ...fast, attempts: 3 })).rejects.toThrow(/"analytics.child_visits": not found/);
    const broken = flaky({ detail: () => ({ result: { ...task, columns: [] } }) }, 99);
    await expect(fetchDatasets(broken, ["analytics.child_visits"], { ...fast, attempts: 2 })).rejects.toThrow(/dataset 12 \("child_visits"\) came back incomplete: no columns/);
  });

  it("checks the answer is the dataset asked for", () => {
    expect(incompleteDataset(task, 12, "child_visits")).toBeNull();
    expect(incompleteDataset(stock, 12)).toMatch(/got 13/);
    expect(incompleteDataset({ ...task, table_name: "other" }, 12, "child_visits")).toMatch(/asked for "child_visits"/);
    expect(incompleteDataset(undefined, 12)).toBe("empty response");
  });
});

describe("building a pack", () => {
  const overlay = { pack: "t", entities: { child_visits: "child_visit", team_stock: "stock" } };

  it("never lists a dimension's own entity in its also", () => {
    // Two columns of one dataset that slug to the same key (team, Team).
    const dup: SupersetDataset = { ...stock, columns: [...stock.columns, { column_name: "Team", groupby: true, type: "TEXT" }] };
    const { pack } = packFromDatasets([task, dup], overlay);
    for (const d of pack.dimensions as any[]) expect(Object.keys(d.also ?? {})).not.toContain(d.entity);
    expect((pack.dimensions as any[]).find((d) => d.key === "team")).toMatchObject({ entity: "child_visit", also: { stock: { field: "team" } } });
  });

  it("refuses two datasets mapped to one entity, instead of mixing them", () => {
    expect(() => packFromDatasets([task, stock], { pack: "t", entities: { child_visits: "x", team_stock: "x" } })).toThrow(/both map to entity "x"/);
  });

  it("is the same pack whatever order Superset answers in, for the same configured order", async () => {
    // fetchDatasets returns datasets in the configured order even if the answers arrive out of order.
    let n = 0;
    const slow: SupersetClient = {
      ...flaky(),
      async get(path: string) {
        const r = await flaky().get(path);
        await new Promise((res) => setTimeout(res, n++ % 2 ? 0 : 5));
        return r;
      },
    };
    const a = packFromDatasets(await fetchDatasets(slow, ["analytics.child_visits", "analytics.team_stock"], fast), overlay).packYaml;
    const b = packFromDatasets(await fetchDatasets(flaky(), ["analytics.child_visits", "analytics.team_stock"], fast), overlay).packYaml;
    expect(a).toBe(b);
  });
});
