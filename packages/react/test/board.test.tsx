import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { type Board as BoardT, type BoardConfig, applyOps, emptyBoard, memoryStore, type Catalogue } from "@lenspack/core";

import "./setup";
import { formatDelta, formatValue } from "../src/format";
import { Board } from "../src/grid";
import { FilterBar } from "../src/filter-bar";
import { BoardProvider, useBoardOps } from "../src/provider";
import type { BoardHost, WidgetData } from "../src/types";
import { VersionHistory } from "../src/versions";

const catalogue: Catalogue = {
  pack: "fx",
  version: 1,
  entities: [{ key: "items", hasTime: true, hasTenant: false }],
  dimensions: [{ key: "region", label: "Region", entity: "items", type: "string", verified: true }],
  measures: [
    { key: "count", label: "Count", entity: "items", format: "number", verified: true },
    { key: "rate", label: "Rate", entity: "items", format: "percent", verified: true },
  ],
};

function config(): BoardConfig {
  const r = applyOps(
    emptyBoard({ pack: "fx", version: 1 }, "Fixture board"),
    [
      { op: "add_widget", id: "k", widget: { kind: "kpi", title: "Total", query: { kind: "value", measure: "count", compare: "previous_period", time: { last: "7d" } }, aggregate: "last" }, placement: { place: "top", width: "third" } },
      { op: "add_widget", id: "c", widget: { kind: "chart", chart: "bar", title: "By region", query: { kind: "breakdown", dimension: "region", measure: "count", limit: 5, sort: "desc" }, options: { legend: true, colorScheme: "default" } } },
      { op: "add_widget", id: "t", widget: { kind: "table", title: "Rates", query: { kind: "breakdown", dimension: "region", measure: "rate", limit: 5, sort: "desc" }, pageSize: 10 } },
      { op: "add_widget", id: "n", widget: { kind: "text", title: "Note", body: "<b>not markup</b>" } },
      { op: "add_filter", filter: { id: "f", type: "select", label: "Region", field: "region", applies: ["*"] } },
    ],
    catalogue,
  );
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

const data: Record<string, WidgetData> = {
  k: { rows: [{ group: "count", value: 1234, count: 1234 }], total: 1234, format: "number", compare: { previous: 1000, delta: 0.234 } },
  c: { rows: [{ group: "north", value: 3, count: 3 }, { group: "south", value: 2, count: 2 }], total: 5, format: "number" },
  t: { rows: [{ group: "north", value: 0.25, count: 4 }], total: 4, format: "percent" },
};

function host(over: Partial<BoardHost> = {}): BoardHost {
  return {
    loadBoardData: vi.fn(async () => data),
    loadFilterOptions: vi.fn(async () => [{ value: "north", count: 3 }, { value: "south", count: 2 }]),
    ...over,
  };
}

const board = (c = config()): BoardT => ({ id: "b", pack: "fx", config: c, version: 1, updatedAt: new Date() });

describe("<Board>", () => {
  it("renders every widget from the config and formats values", async () => {
    render(
      <BoardProvider board={board()} catalogue={catalogue} host={host()}>
        <Board />
      </BoardProvider>,
    );
    expect(screen.getByTestId("lp-board").dataset.widgets).toBe("4");
    expect(screen.getByText("By region")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("kpi-value").textContent).toBe("1,234"));
    expect(screen.getByText("+23.4% vs previous")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    // Text bodies are text nodes, never markup.
    expect(screen.getByText("<b>not markup</b>").querySelector("b")).toBeNull();
  });

  it("shows an inline error for one widget without taking the board down", async () => {
    const h = host({ loadBoardData: async () => ({ ...data, c: { rows: [], total: 0, format: "number", error: "boom", hint: "region" } }) });
    render(
      <BoardProvider board={board()} catalogue={catalogue} host={h}>
        <Board />
      </BoardProvider>,
    );
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
    expect(screen.getByTestId("kpi-value").textContent).toBe("1,234");
  });

  it("lets any UI drive edits through useBoardOps", async () => {
    const store = memoryStore();
    await store.create({ id: "b", pack: { pack: "fx", version: 1 }, config: config(), title: "x" });
    const h = host({ applyOps: (ops) => store.patch({ id: "b", ops, catalogue }) });
    function Rename() {
      const { apply, version } = useBoardOps();
      return (
        <button onClick={() => void apply([{ op: "set_title", title: "Renamed" }])} data-testid="rename">
          v{version}
        </button>
      );
    }
    render(
      <BoardProvider board={await store.get("b").then((b) => b!)} catalogue={catalogue} host={h}>
        <Rename />
        <Board />
      </BoardProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("rename"));
    });
    await waitFor(() => expect(screen.getByTestId("rename").textContent).toBe("v2"));
    expect((await store.get("b"))?.config.title).toBe("Renamed");
  });
});

describe("<FilterBar>", () => {
  it("loads options and reloads data with the selection", async () => {
    const h = host();
    const onChange = vi.fn();
    render(
      <BoardProvider board={board()} catalogue={catalogue} host={h} onSelectionsChange={onChange}>
        <FilterBar />
        <Board />
      </BoardProvider>,
    );
    await waitFor(() => expect(screen.getByText("north (3)")).toBeTruthy());
    fireEvent.change(screen.getByTestId("filter-region"), { target: { value: "north" } });
    expect(onChange).toHaveBeenCalledWith({ region: "north" });
    await waitFor(() => expect(h.loadBoardData).toHaveBeenLastCalledWith(expect.anything(), { region: "north" }));
    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(h.loadBoardData).toHaveBeenLastCalledWith(expect.anything(), {}));
  });
});

describe("<VersionHistory>", () => {
  it("lists versions and restores one", async () => {
    const revertTo = vi.fn(async () => null);
    const h = host({
      loadVersions: async () => [
        { version: 2, source: "chat", summary: "added k", createdAt: new Date(), config: config() },
        { version: 1, source: "create", summary: "created", createdAt: new Date(), config: config() },
      ],
      revertTo,
    });
    render(
      <BoardProvider board={{ ...board(), version: 2 }} catalogue={catalogue} host={h}>
        <VersionHistory />
      </BoardProvider>,
    );
    fireEvent.click(screen.getByTestId("history-toggle"));
    await waitFor(() => expect(screen.getByText("added k")).toBeTruthy());
    expect(screen.queryByTestId("restore-2")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("restore-1"));
    });
    expect(revertTo).toHaveBeenCalledWith(1);
  });
});

describe("formatting", () => {
  it("formats by kind", () => {
    expect(formatValue(0.256, "percent")).toBe("25.6%");
    expect(formatValue(1234.5, "currency", { currency: "USD" })).toBe("$1,235");
    expect(formatValue(12345678, "compact")).toBe("12.3M");
    expect(formatValue(null, "number")).toBe("—");
    expect(formatDelta(-0.1234)).toBe("-12.3%");
  });
});
