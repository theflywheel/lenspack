import { describe, expect, it } from "vitest";

import { type SupersetDataset, packFromDatasets, packScope, supersetConnector } from "@lenspack/superset";

import { type Rig, freshBoard, serve, supersetHost } from "../harness";

// A made-up shop on Superset whose deployment pins every answer to one store (superset.yaml scope). The eval rig
// must send the same filter the server does, or an eval scores answers for every store.
const ORDERS: SupersetDataset = {
  id: 5,
  table_name: "orders",
  main_dttm_col: "ordered_at",
  columns: [
    { column_name: "ordered_at", is_dttm: true, type: "DATE" },
    { column_name: "store", groupby: true, type: "TEXT" },
    { column_name: "channel", groupby: true, type: "TEXT" },
  ],
  metrics: [{ metric_name: "orders", expression: "COUNT(*)" }],
};

type Sent = { queries: { filters: { col: string; op: string; val?: unknown }[] }[] };

describe("the Superset eval rig", () => {
  it("applies the pack's scope as the server does, so every query carries its filters", async () => {
    const { pack, packYaml, binding } = packFromDatasets([ORDERS], { pack: "shop" });
    const sent: Sent[] = [];
    const client = { post: async (_p: string, body: Sent) => (sent.push(body), { result: body.queries.map(() => ({ data: [{ channel: "web", __lenspack_n: 3 }] })) }) };
    const connector = supersetConnector(client as never, binding);
    const scope = packScope([{ dimension: "store", op: "eq", value: "north" }], pack);
    const host = supersetHost({ pack, packYaml, connector, scope, now: new Date("2026-05-01T00:00:00Z") });
    expect(host.ctx).toEqual({ scope: [{ dimension: "store", op: "eq", value: "north" }], now: new Date("2026-05-01T00:00:00Z") });

    // Through the same app the rig serves turns from: a question's query reaches Superset with the store pinned.
    const rig: Rig = { host, seed: null, close: async () => {} };
    const srv = await serve(rig, []);
    try {
      await freshBoard(rig, "b1");
      const res = await fetch(`${srv.base}/b1/options?field=channel`);
      expect(res.status).toBe(200);
      expect(sent.length).toBeGreaterThan(0);
      for (const body of sent) for (const q of body.queries) expect(q.filters).toContainEqual({ col: "store", op: "==", val: "north" });
    } finally {
      await srv.close();
    }
  });

  it("adds nothing for a pack with no scope", () => {
    const { pack, packYaml, binding } = packFromDatasets([ORDERS], { pack: "shop" });
    const host = supersetHost({ pack, packYaml, connector: supersetConnector({} as never, binding), scope: packScope(undefined, pack) });
    expect(host.ctx).toEqual({});
  });
});
