// A Superset dashboard's own filter bar (its native filters, in json_metadata) as the board's filters:
// read into the board, written back with only what the board changed, and changed from the chat.
import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BoardOp, memoryStore, summarise } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/pack";
import { type Host, type Provider, buildProvider, createApp, registerLlmAdapter } from "@lenspack/serve";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";

import type { SupersetClient } from "../src/client";
import { supersetConnector } from "../src/connector";
import { type SupersetDataset, packFromDatasets } from "../src/index";
import { supersetBoards } from "../src/store";

// Made-up datasets: households and visits, both with an area column.
const DATASETS: SupersetDataset[] = [
  {
    id: 3,
    table_name: "households",
    main_dttm_col: "registered_at",
    columns: [
      { column_name: "registered_at", is_dttm: true, type: "DATE" },
      { column_name: "lga", groupby: true, type: "TEXT" },
      { column_name: "ward", groupby: true, type: "TEXT" },
      { column_name: "size", groupby: false, type: "NUMERIC" },
      { column_name: "facility_code", groupby: false, type: "TEXT" },
    ],
    metrics: [{ metric_name: "count", expression: "COUNT(*)" }],
  },
  { id: 4, table_name: "visits", main_dttm_col: "visited_at", columns: [{ column_name: "visited_at", is_dttm: true, type: "DATE" }, { column_name: "lga", groupby: true, type: "TEXT" }], metrics: [{ metric_name: "visits", expression: "COUNT(*)" }] },
];
const { pack, packYaml, binding } = packFromDatasets(DATASETS, { pack: "homes", entities: { "3": "household", "4": "visit" } });
const catalogue = catalogueFrom(pack);

const scope = (excluded: number[] = [], rootPath = ["ROOT_ID"]) => ({ rootPath, excluded });
const empty = { extraFormData: {}, filterState: {}, ownState: {} };
const select = (id: string, name: string, datasetId: number, column: string, more: Record<string, unknown> = {}) => ({
  id: `NATIVE_FILTER-${id}`,
  controlValues: { enableEmptyFilter: false, defaultToFirstItem: false, multiSelect: true, searchAllOptions: false, inverseSelection: false },
  name,
  filterType: "filter_select",
  targets: [{ datasetId, column: { name: column } }],
  defaultDataMask: empty,
  cascadeParentIds: [],
  scope: scope(),
  type: "NATIVE_FILTER",
  description: "",
  chartsInScope: [101, 102, 103],
  tabsInScope: ["TAB-b"],
  ...more,
});

// The filter bar as Superset 5 and 6.1 save it: every kind of filter, a section heading, and the keys around it.
const NATIVE = [
  select("lgaPick", "LGA", 3, "lga", {
    defaultDataMask: { extraFormData: { filters: [{ col: "lga", op: "IN", val: ["Alpha"] }] }, filterState: { validateStatus: false, label: "Alpha", value: ["Alpha"] }, ownState: {} },
    adhoc_filters: [],
    requiredFirst: false,
  }),
  select("wardPick", "Ward", 3, "ward", { scope: scope([103]), sortMetric: "count", controlValues: { enableEmptyFilter: false, defaultToFirstItem: false, multiSelect: false, searchAllOptions: true, inverseSelection: false } }),
  select("visitArea", "Visit area", 4, "lga", { scope: scope([], ["TAB-b"]) }),
  { id: "NATIVE_FILTER_DIVIDER-sec1", type: "DIVIDER", scope: scope(), title: "More", description: "" },
  select("facility", "Facility", 3, "facility_code"),
  select("notWard", "Not these wards", 3, "ward", { controlValues: { enableEmptyFilter: false, defaultToFirstItem: false, multiSelect: true, searchAllOptions: false, inverseSelection: true } }),
  { id: "NATIVE_FILTER-when", controlValues: { enableEmptyFilter: false }, name: "Registered", filterType: "filter_time", targets: [{}], defaultDataMask: { extraFormData: { time_range: "Last month" }, filterState: { value: "Last month" }, ownState: {} }, cascadeParentIds: [], scope: scope(), type: "NATIVE_FILTER", description: "" },
  { id: "NATIVE_FILTER-prevWeek", controlValues: {}, name: "Week", filterType: "filter_time", targets: [{}], defaultDataMask: { extraFormData: { time_range: "previous calendar week" }, filterState: { value: "previous calendar week" }, ownState: {} }, cascadeParentIds: [], scope: scope(), type: "NATIVE_FILTER", description: "" },
  { id: "NATIVE_FILTER-size", controlValues: { enableEmptyFilter: false }, name: "Household size", filterType: "filter_range", targets: [{ datasetId: 3, column: { name: "size" } }], defaultDataMask: { extraFormData: {}, filterState: { value: [2, 6] }, ownState: {} }, cascadeParentIds: [], scope: scope(), type: "NATIVE_FILTER", description: "" },
  { id: "NATIVE_FILTER-grain", controlValues: {}, name: "Grain", filterType: "filter_timegrain", targets: [{ datasetId: 3 }], defaultDataMask: { extraFormData: { time_grain_sqla: "P1W" }, filterState: { value: ["P1W"] }, ownState: {} }, cascadeParentIds: [], scope: scope(), type: "NATIVE_FILTER", description: "" },
];
const OTHER_KEYS = {
  color_scheme: "supersetColors",
  label_colors: { Alpha: "#1FA8C9" },
  shared_label_colors: [],
  map_label_colors: {},
  refresh_frequency: 0,
  timed_refresh_immune_slices: [],
  expanded_slices: {},
  cross_filters_enabled: true,
  filter_bar_orientation: "VERTICAL",
  chart_configuration: { "101": { id: 101, crossFilters: { scope: "global", chartsInScope: [102, 103] } } },
  global_chart_configuration: { scope: { rootPath: ["ROOT_ID"], excluded: [] }, chartsInScope: [101, 102, 103] },
  // Superset 6.1's: the filter bar's "chart customizations" (a group-by picker here) and a display switch.
  chart_customization_config: [
    { id: "CHART_CUSTOMIZATION-groupBy", type: "CHART_CUSTOMIZATION", name: "Group by", targets: [{ datasetId: 3, column: { name: "lga" } }], chartsInScope: [101], scope: { rootPath: ["ROOT_ID"], excluded: [] }, defaultDataMask: { extraFormData: {}, filterState: {}, ownState: {} } },
  ],
  show_chart_timestamps: false,
};

const CHART = (id: number, parents: string[]) => ({ id: `CHART-${id}`, type: "CHART", children: [], parents, meta: { chartId: id, width: 6, height: 50, sliceName: `Chart ${id}` } });
const POSITION = {
  DASHBOARD_VERSION_KEY: "v2",
  ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["GRID_ID"] },
  GRID_ID: { id: "GRID_ID", type: "GRID", children: ["ROW-1", "TABS-1"], parents: ["ROOT_ID"] },
  HEADER_ID: { id: "HEADER_ID", type: "HEADER", children: [], meta: { text: "Homes" } },
  "ROW-1": { id: "ROW-1", type: "ROW", children: ["CHART-101", "CHART-102"], parents: ["ROOT_ID", "GRID_ID"], meta: {} },
  "CHART-101": CHART(101, ["ROOT_ID", "GRID_ID", "ROW-1"]),
  "CHART-102": CHART(102, ["ROOT_ID", "GRID_ID", "ROW-1"]),
  "TABS-1": { id: "TABS-1", type: "TABS", children: ["TAB-b"], parents: ["ROOT_ID", "GRID_ID"] },
  "TAB-b": { id: "TAB-b", type: "TAB", children: ["ROW-2"], parents: ["ROOT_ID", "GRID_ID", "TABS-1"], meta: { text: "Visits" } },
  "ROW-2": { id: "ROW-2", type: "ROW", children: ["CHART-103"], parents: ["ROOT_ID", "GRID_ID", "TABS-1", "TAB-b"], meta: {} },
  "CHART-103": CHART(103, ["ROOT_ID", "GRID_ID", "TABS-1", "TAB-b", "ROW-2"]),
};

/** Just enough of Superset's dashboard API, keeping what is written to the dashboard. */
function fakeSuperset() {
  const puts: Record<string, any>[] = [];
  let changed = 0;
  let dash = { id: 7, dashboard_title: "Homes", position_json: JSON.stringify(POSITION), json_metadata: JSON.stringify({ ...OTHER_KEYS, native_filter_configuration: NATIVE, positions: POSITION }), changed_on: "t0" };
  const charts = [101, 102, 103].map((id) => ({ id, slice_name: `Chart ${id}`, form_data: { viz_type: "sunburst_v2", datasource: `${id === 103 ? 4 : 3}__table` } }));
  const client: SupersetClient = {
    url: "http://superset.test",
    async get(path): Promise<any> {
      if (path === "/api/v1/dashboard/7") return { result: dash };
      if (path === "/api/v1/dashboard/7/charts") return { result: charts };
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path): Promise<any> {
      throw new Error(`unexpected POST ${path}`);
    },
    async put(path, body): Promise<any> {
      if (path === "/api/v1/dashboard/7") {
        puts.push(body as Record<string, any>);
        dash = { ...dash, ...(body as object), changed_on: `t${++changed}` };
      }
      return {};
    },
    async delete(): Promise<any> {
      return {};
    },
  };
  return { client, puts, meta: () => JSON.parse(dash.json_metadata) };
}

async function board() {
  const superset = fakeSuperset();
  const store = supersetBoards({ inner: memoryStore(), client: superset.client, pack, binding, dashboards: { "superset-7": 7 }, stateFile: join(mkdtempSync(join(tmpdir(), "lp-filters-")), "boards.json") });
  await store.seed();
  const patch = async (ops: BoardOp[]) => {
    const r = await store.patch({ id: "superset-7", ops, catalogue });
    if (!r.ok) throw new Error(r.error);
    return superset.meta();
  };
  return { ...superset, store, patch, filters: async () => (await store.get("superset-7"))!.config.filters };
}

const without = (list: unknown[], ...ids: string[]) => list.filter((f) => !ids.includes((f as { id: string }).id));

describe("a Superset dashboard's filter bar", () => {
  it("reads as board filters: selects and a date range Lenspack can run, the rest kept as Superset's with what they do", async () => {
    const { filters, store } = await board();
    const f = await filters();
    expect(f.filter((x) => x.type !== "host")).toEqual([
      { id: "lgaPick", type: "select", label: "LGA", field: "lga", applies: ["*"], default: { values: ["Alpha"] } },
      { id: "wardPick", type: "select", label: "Ward", field: "ward", applies: ["c101", "c102"] },
      { id: "visitArea", type: "select", label: "Visit area", field: "lga", applies: ["c103"] },
      { id: "when", type: "daterange", label: "Registered", field: "time", applies: ["*"], default: { months: 1 } },
    ]);
    const kept = Object.fromEntries(f.filter((x) => x.type === "host").map((x) => [x.label, x.note]));
    expect(Object.keys(kept)).toEqual(["Facility", "Not these wards", "Week", "Household size", "Grain"]);
    expect(kept.Facility).toBe("Superset-only filter: “Facility”, a list of values of facility_code, which this data pack does not have. It stays as Superset has it: it can be removed here, but changed only in Superset.");
    expect(kept["Not these wards"]).toContain("which leaves out the values picked of ward");
    expect(kept.Week).toContain("a time range, set to “previous calendar week” by default");
    expect(kept["Household size"]).toContain("a range of values of size, set to 2 to 6 by default");
    expect(kept.Grain).toContain("time grain (day, week, month...) charts are grouped by, set to P1W by default");
    // What the model reads: each filter and what it is set to, and every Superset-only one by name.
    const text = summarise((await store.get("superset-7"))!.config);
    expect(text).toContain("Filters: LGA [lga], set to Alpha by default; Ward [ward], on c101, c102; Visit area [lga], on c103; Registered [time], last 1 month by default");
    expect(text).toContain("Superset-only filter: “Household size”");
  });

  it("is written back exactly as it was when the board's filters did not change", async () => {
    const { patch } = await board();
    const meta = await patch([{ op: "set_title", title: "Homes, renamed" }]);
    expect(JSON.stringify(meta.native_filter_configuration)).toBe(JSON.stringify(NATIVE));
    const { positions: _p, native_filter_configuration: _n, ...rest } = meta;
    expect(rest).toEqual(OTHER_KEYS);
  });

  it("loses only the filter removed; a Superset-only one can be removed too, the section heading stays", async () => {
    const { patch } = await board();
    expect((await patch([{ op: "remove_filter", id: "lgaPick" }])).native_filter_configuration).toEqual(without(NATIVE, "NATIVE_FILTER-lgaPick"));
    expect((await patch([{ op: "remove_filter", id: "size" }])).native_filter_configuration).toEqual(without(NATIVE, "NATIVE_FILTER-lgaPick", "NATIVE_FILTER-size"));
  });

  it("changes a filter in place: its name and default, nothing else of it or of the others", async () => {
    const { patch, filters } = await board();
    const ward = (await filters()).find((f) => f.id === "wardPick")!;
    const meta = await patch([{ op: "update_filter", id: "wardPick", filter: { ...ward, label: "Wards", default: { values: ["North", "South"] } } }]);
    const changed = meta.native_filter_configuration[1];
    expect(changed).toEqual({
      ...NATIVE[1],
      name: "Wards",
      controlValues: { ...(NATIVE[1] as { controlValues: object }).controlValues, multiSelect: true },
      defaultDataMask: { ownState: {}, extraFormData: { filters: [{ col: "ward", op: "IN", val: ["North", "South"] }] }, filterState: { value: ["North", "South"] } },
    });
    expect(without(meta.native_filter_configuration, "NATIVE_FILTER-wardPick")).toEqual(without(NATIVE, "NATIVE_FILTER-wardPick"));
    // A date range's default is written in Superset's own words.
    const when = (await filters()).find((f) => f.id === "when")!;
    const later = await patch([{ op: "update_filter", id: "when", filter: { ...when, default: { months: 3 } } }]);
    expect(later.native_filter_configuration[6].defaultDataMask).toEqual({ ownState: {}, extraFormData: { time_range: "Last quarter" }, filterState: { value: "Last quarter" } });
  });

  it("refuses to change a Superset-only filter, and to add one", async () => {
    const { store, filters } = await board();
    const size = (await filters()).find((f) => f.id === "size")!;
    expect(await store.patch({ id: "superset-7", ops: [{ op: "update_filter", id: "size", filter: { ...size, label: "Size" } }], catalogue })).toMatchObject({ ok: false, error: expect.stringContaining("changed only there") });
    expect(await store.patch({ id: "superset-7", ops: [{ op: "add_filter", filter: { ...size, id: "size2" } }], catalogue })).toMatchObject({ ok: false });
  });

  it("adds a filter Superset draws, scoped to the charts it applies to, and reads it back as the same board filter", async () => {
    const { patch, store, filters } = await board();
    const meta = await patch([{ op: "add_filter", filter: { id: "filter_lga", type: "select", label: "Area", field: "lga", applies: ["c101"], default: { values: ["Beta"] } } }]);
    expect(meta.native_filter_configuration.slice(0, NATIVE.length)).toEqual(NATIVE);
    expect(meta.native_filter_configuration.at(-1)).toEqual({
      id: "NATIVE_FILTER-filter_lga",
      type: "NATIVE_FILTER",
      name: "Area",
      filterType: "filter_select",
      targets: [{ datasetId: 3, column: { name: "lga" } }],
      controlValues: { enableEmptyFilter: false, defaultToFirstItem: false, multiSelect: true, searchAllOptions: false, inverseSelection: false },
      defaultDataMask: { ownState: {}, extraFormData: { filters: [{ col: "lga", op: "IN", val: ["Beta"] }] }, filterState: { value: ["Beta"] } },
      cascadeParentIds: [],
      scope: { rootPath: ["ROOT_ID"], excluded: [102, 103] },
      chartsInScope: [101],
      tabsInScope: [],
      description: "",
    });
    const versions = (await store.versions("superset-7")).length;
    await store.pull("superset-7", true);
    expect((await filters()).at(-1)).toEqual({ id: "filter_lga", type: "select", label: "Area", field: "lga", applies: ["c101"], default: { values: ["Beta"] } });
    // Reading back what was just written is not a change made in Superset.
    expect((await store.versions("superset-7")).length).toBe(versions);
  });

  it("follows the charts: a scope that still covers the right charts is left alone, a changed one is rewritten", async () => {
    const { patch, filters } = await board();
    // Ward covered c101 and c102; with c102 gone its scope still covers exactly what it applies to.
    expect((await patch([{ op: "remove_widget", id: "c102" }])).native_filter_configuration).toEqual(NATIVE);
    // Applied to every chart instead: the scope says so, in Superset's own form.
    const ward = (await filters()).find((f) => f.id === "wardPick")!;
    const meta = await patch([{ op: "update_filter", id: "wardPick", filter: { ...ward, applies: ["*"] } }]);
    expect(meta.native_filter_configuration[1]).toEqual({ ...NATIVE[1], scope: { rootPath: ["ROOT_ID"], excluded: [] }, chartsInScope: [101, 103], tabsInScope: [] });
    // Its last chart removed, a filter goes with it (as on any board), and the board says so.
    await patch([{ op: "update_filter", id: "wardPick", filter: { ...ward, applies: ["c101"] } }]);
    expect((await patch([{ op: "remove_widget", id: "c101" }])).native_filter_configuration.some((f: { id: string }) => f.id === "NATIVE_FILTER-wardPick")).toBe(false);
  });
});

// The chat on the same stub: asked to remove the LGA filter, the model can see it and remove it.
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stream = (parts: unknown[]) => ({
  stream: new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  }),
});
const tool = (toolName: string, input: unknown) => [
  { type: "tool-call", toolCallId: `c${Math.random().toString(36).slice(2)}`, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const say = (text: string) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];

describe("the chat and a dashboard's filter bar", () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
  });

  it("“remove the LGA filter”: the model is shown the filter, removes it, and Superset loses only that filter when the turn ends", async () => {
    const b = await board();
    const prompts: string[] = [];
    const steps = [tool("remove_filter", { filter: "LGA" }), say("I removed the LGA filter.")];
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async (call) => {
        prompts.push(JSON.stringify(call.prompt));
        // Edits are held until the turn ends: nothing reaches Superset while the model is still working.
        if (step === 1) expect(b.puts).toEqual([]);
        return stream(steps[step++] ?? say("Done."));
      },
      doGenerate: async () => ({ content: [{ type: "text", text: JSON.stringify({ findings: [] }) }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }),
    });
    const host: Host = { name: "homes", pack, packYaml, connector: supersetConnector(b.client, binding), store: b.store, ctx: {}, boards: [] };
    registerLlmAdapter({ kind: "superset-filters", defaultBaseUrl: "mock:", build: () => model });
    const providers: Provider[] = [{ ...buildProvider({ name: "m", kind: "superset-filters", model: "m" }), available: true }];
    const server = createServer(createApp([host], { providers }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/homes/superset-7/chat?model=m`;
    const body = await (await fetch(url, { method: "POST", body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "remove the LGA filter" }] }] }) })).text();
    expect(prompts[0]).toContain("Filters: LGA [lga], set to Alpha by default");
    expect(body).toContain("I removed the LGA filter.");
    expect(b.puts).toHaveLength(1);
    expect(b.meta().native_filter_configuration).toEqual(without(NATIVE, "NATIVE_FILTER-lgaPick"));
    expect((await b.filters()).some((f) => f.label === "LGA")).toBe(false);
  });
});
