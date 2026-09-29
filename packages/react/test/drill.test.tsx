import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { type BoardConfig, type Catalogue, applyOps, emptyBoard } from "@lenspack/core";

import "./setup";
import { FilterBar } from "../src/filter-bar";
import { Board } from "../src/grid";
import { BoardProvider } from "../src/provider";
import type { BoardHost, WidgetData } from "../src/types";

// A click on a bar or a row of a widget grouped by a hierarchy level drills:
// the host is asked for the board under the new selection, the breadcrumb
// shows where the board stands, and a step in it goes back up.

const catalogue: Catalogue = {
  pack: "fx",
  version: 1,
  hierarchies: { area: ["region", "town"] },
  entities: [{ key: "items", hasTime: false, hasTenant: false }],
  dimensions: [
    { key: "region", label: "Region", entity: "items", type: "string", verified: true },
    { key: "town", label: "Town", entity: "items", type: "string", verified: true },
  ],
  measures: [
    { key: "count", label: "Count", entity: "items", format: "number", verified: true },
    { key: "total", label: "Total", entity: "items", format: "number", verified: true },
  ],
};

function config(): BoardConfig {
  const r = applyOps(
    emptyBoard({ pack: "fx", version: 1 }, "Drill"),
    [
      { op: "add_widget", id: "c", widget: { kind: "chart", chart: "bar", title: "By region", query: { kind: "breakdown", dimension: "region", measure: "count", limit: 5, sort: "desc" }, options: { legend: true, colorScheme: "default" } } },
      { op: "add_widget", id: "t", widget: { kind: "table", title: "Table", query: { kind: "breakdown", dimension: "region", measure: "count", measures: ["total"], limit: 5, sort: "desc" }, pageSize: 10 } },
    ],
    catalogue,
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

const byRegion: Record<string, WidgetData> = {
  c: { rows: [{ group: "north", value: 3, count: 3 }, { group: "south", value: 2, count: 2 }], total: 5, format: "number" },
  t: { rows: [{ group: "north", value: 3, count: 3, values: { total: 30 } }], total: 3, format: "number", measures: [{ key: "count", format: "number" }, { key: "total", format: "number" }] },
};
const byTown: Record<string, WidgetData> = {
  c: { rows: [{ group: "harbour", value: 2, count: 2 }], total: 2, format: "number" },
  t: { rows: [{ group: "harbour", value: 2, count: 2, values: { total: 20 } }], total: 2, format: "number", measures: [{ key: "count", format: "number" }, { key: "total", format: "number" }] },
};

describe("drilling down", () => {
  it("drills on a click, shows the path, and goes back up", async () => {
    const loadBoardData = vi.fn(async (_c: BoardConfig, s: Record<string, string>) => (s.region ? byTown : byRegion));
    const host: BoardHost = { loadBoardData };
    const board = { id: "b", pack: "fx", title: "Drill", config: config(), version: 1, updatedAt: new Date() };
    render(
      <BoardProvider board={board} catalogue={catalogue} host={host}>
        <FilterBar />
        <Board />
      </BoardProvider>,
    );
    await waitFor(() => expect(document.querySelector('[data-drill="north"]')).not.toBeNull());
    // The table has a column per measure, labelled from the catalogue.
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Region", "Count", "Total"]);

    fireEvent.click(document.querySelector('[data-drill="north"]')!);
    await waitFor(() => expect(loadBoardData).toHaveBeenLastCalledWith(expect.anything(), { region: "north" }));
    await waitFor(() => expect(screen.getByTestId("drill-area").textContent).toContain("north"));
    // Rows are towns now; the header says so, and a town is the finest level: no further drill.
    await waitFor(() => expect(screen.getAllByRole("columnheader")[0]!.textContent).toBe("Town"));
    fireEvent.click(document.querySelector('[data-drill="harbour"]')!);
    await waitFor(() => expect(loadBoardData).toHaveBeenLastCalledWith(expect.anything(), { region: "north", town: "harbour" }));

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(loadBoardData).toHaveBeenLastCalledWith(expect.anything(), {}));
    await waitFor(() => expect(screen.queryByTestId("drill-area")).toBeNull());
  });
});
