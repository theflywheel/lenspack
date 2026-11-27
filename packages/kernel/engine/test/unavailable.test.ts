import type { BoardConfig, Query } from "@lenspack/core";
import { parsePack } from "@lenspack/pack";
import { describe, expect, it } from "vitest";

import { type Connector, type Notice, ResolveError, SQL_CAPABILITIES, resolve, resolveBoard } from "../src";

// Keys the source can't answer right now (ctx.unavailable): what they read is not collected or not set up. A query
// naming one is refused with the host's notice, by any path, so a board says why in place of a wrong figure.

const pack = parsePack({
  pack: "stub",
  version: 1,
  entities: { visits: { source: "visits", time: "at" } },
  dimensions: [
    { key: "region", entity: "visits", field: "region" },
    { key: "device", entity: "visits", field: "device" },
  ],
  measures: [
    { key: "visits", entity: "visits", agg: "count" },
    { key: "people", entity: "visits", agg: "count_distinct", field: "person" },
  ],
});
const notice = { text: "Needs the device field, which is switched off.", action: { label: "Show the field", href: "#fields/device" } };
const unavailable = new Map<string, Notice>([["device", notice], ["people", { text: "Needs the person field." }]]);

describe("unavailable keys", () => {
  it("refuse a query that names one, as a measure, a dimension or a ratio's other measure, with the host's notice", () => {
    const refused = (q: Query) => {
      try {
        resolve(q, pack, { unavailable }, SQL_CAPABILITIES);
      } catch (e) {
        return e instanceof ResolveError ? { code: e.code, message: e.message, notice: e.notice } : String(e);
      }
      return null;
    };
    expect(refused({ kind: "breakdown", dimension: "device", measure: "visits", limit: 10, sort: "desc" })).toEqual({ code: "UNAVAILABLE", message: `"device" can't be answered right now: ${notice.text}`, notice });
    expect(refused({ kind: "value", measure: "people" })).toMatchObject({ code: "UNAVAILABLE", notice: { text: "Needs the person field." } });
    expect(refused({ kind: "value", measure: "visits", compute: { steps: [{ op: "ratio", to: "people" }] } })).toMatchObject({ code: "UNAVAILABLE" });
    expect(refused({ kind: "breakdown", dimension: "region", measure: "visits", limit: 10, sort: "desc" })).toBeNull();
  });

  it("come back on a board as the widget's notice, and the other widgets still load", async () => {
    const connector: Connector = {
      kind: "stub",
      capabilities: SQL_CAPABILITIES,
      compile: async () => ({}) as never,
      execute: async () => [{ value: 7, n: 7 }] as never,
    };
    const config = {
      title: "t",
      widgets: {
        a: { kind: "kpi", title: "Visits", query: { kind: "value", measure: "visits" } },
        b: { kind: "chart", chart: "bar", title: "By device", query: { kind: "breakdown", dimension: "device", measure: "visits", limit: 10, sort: "desc" }, options: { legend: true, colorScheme: "default" } },
      },
      layout: [],
      filters: [],
    } as unknown as BoardConfig;
    const data = await resolveBoard(config, { pack, connector, ctx: { unavailable } });
    expect(data.b).toMatchObject({ rows: [], notice });
    expect(data.a!.notice).toBeUndefined();
  });
});
