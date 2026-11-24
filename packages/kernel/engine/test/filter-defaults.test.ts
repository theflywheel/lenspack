import { type BoardConfig, type Widget, emptyBoard } from "@lenspack/core";
import { describe, expect, it } from "vitest";

import { pack } from "../../../sources/sql/test/fixture-pack";
import { drilledQuery } from "../src";

// A select filter's default values narrow the widgets it covers until someone picks a value.

describe("a select filter's default", () => {
  const widget: Widget = { kind: "kpi", title: "Things", query: { kind: "value", measure: "things" } } as Widget;
  const config: BoardConfig = {
    ...emptyBoard(pack, "B"),
    widgets: { k: widget },
    filters: [
      { id: "c", type: "select", label: "Colour", field: "colour", applies: ["*"], default: { values: ["red", "blue"] } },
      { id: "h", type: "host", label: "Kept", field: "colour", applies: ["*"], note: "kept" },
    ],
  };

  it("narrows to the default values, a pick replaces them, and a host's filter never narrows", () => {
    expect(drilledQuery(config, "k", widget, {}, pack)?.filters).toEqual([{ dimension: "colour", op: "in", value: ["red", "blue"] }]);
    expect(drilledQuery(config, "k", widget, { colour: "green" }, pack)?.filters).toEqual([{ dimension: "colour", op: "eq", value: "green" }]);
    expect(drilledQuery({ ...config, filters: [config.filters[1]!] }, "k", widget, { colour: "green" }, pack)?.filters).toBeUndefined();
  });
});
