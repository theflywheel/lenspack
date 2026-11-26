// The layout check refuses a save: a layout writer that went wrong (here, one made to put rows with
// the wrong parents) never reaches Superset, and the chart made for the edit is deleted again.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BoardOp, memoryStore } from "@lenspack/core";
import { catalogueFrom } from "@lenspack/pack";
import { describe, expect, it, vi } from "vitest";

import type { SupersetClient } from "../src/client";
import { type SupersetDataset, packFromDatasets } from "../src/index";
import type { Position } from "../src/layout";
import { supersetBoards } from "../src/store";

vi.mock("../src/layout", async (original) => {
  const real = await original<typeof import("../src/layout")>();
  return {
    ...real,
    insertRow: (pos: Position, container: string, items: never[], at?: number) => {
      const id = real.insertRow(pos, container, items, at);
      (pos[id] as { parents: string[] }).parents = ["ROOT_ID"];
      return id;
    },
  };
});

const DATASETS: SupersetDataset[] = [{ id: 3, table_name: "households", main_dttm_col: "registered_at", columns: [{ column_name: "registered_at", is_dttm: true, type: "DATE" }], metrics: [{ metric_name: "count", expression: "COUNT(*)" }] }];
const { pack, binding } = packFromDatasets(DATASETS, { pack: "homes", entities: { "3": "household" } });

describe("the layout check before a save", () => {
  it("refuses a layout that is not valid, says so, and leaves Superset as it was", async () => {
    const position: Position = {
      ROOT_ID: { id: "ROOT_ID", type: "ROOT", children: ["TABS-1"] },
      GRID_ID: { id: "GRID_ID", type: "GRID", children: [], parents: ["ROOT_ID"] },
      "TABS-1": { id: "TABS-1", type: "TABS", children: ["TAB-a"], parents: ["ROOT_ID"] },
      "TAB-a": { id: "TAB-a", type: "TAB", children: [], parents: ["ROOT_ID", "TABS-1"], meta: { text: "Stock" } },
    };
    const puts: string[] = [];
    const deleted: string[] = [];
    const dash = { id: 7, dashboard_title: "Tabs", position_json: JSON.stringify(position), json_metadata: "{}", changed_on: "t0" };
    const client = {
      url: "http://superset.test",
      get: async (path: string) => (path.endsWith("/charts") ? { result: [] } : { result: dash }),
      post: async () => ({ id: 901 }),
      put: async (path: string) => void puts.push(path),
      delete: async (path: string) => void deleted.push(path),
    } as unknown as SupersetClient;
    const store = supersetBoards({ inner: memoryStore(), client, pack, binding, dashboards: { b: 7 }, stateFile: join(mkdtempSync(join(tmpdir(), "lp-check-")), "s.json") });
    await store.seed();
    const add = { op: "add_widget", id: "k1", widget: { kind: "kpi", title: "Homes", query: { kind: "value", entity: "household", measure: "household_count" } }, placement: { place: "bottom", width: "quarter" } } as BoardOp;
    const r = await store.patch({ id: "b", ops: [add], catalogue: catalogueFrom(pack) });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/layout this change would save is not valid \(ROW-lp-1's parents are \["ROOT_ID"\]/);
    expect(puts).toEqual([]);
    expect(deleted).toEqual(["/api/v1/chart/901"]);
    expect(Object.keys((await store.get("b"))!.config.widgets)).toEqual([]);
  });
});
