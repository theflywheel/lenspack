import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { type BoardConfig, type Catalogue, applyOps, emptyBoard } from "@lenspack/core";

import "./setup";
import { Board } from "../src/grid";
import { Markdown } from "../src/markdown";
import { BoardProvider } from "../src/provider";
import type { BoardHost, WidgetData, WidgetPage } from "../src/types";

const catalogue: Catalogue = {
  pack: "fx",
  version: 1,
  entities: [{ key: "items", hasTime: true, hasTenant: false }],
  dimensions: [
    { key: "region", label: "Region", entity: "items", type: "string", verified: true },
    { key: "size", label: "Size", entity: "items", type: "number", verified: true },
  ],
  measures: [
    { key: "count", label: "Count", entity: "items", format: "number", verified: true },
    { key: "rate", label: "Rate", entity: "items", format: "percent", verified: true },
  ],
};

function config(widgets: Parameters<typeof applyOps>[1]): BoardConfig {
  const r = applyOps(emptyBoard({ pack: "fx", version: 1 }, "Fixture"), widgets, catalogue);
  if (!r.ok) throw new Error(r.error);
  return r.config;
}

const mount = (c: BoardConfig, host: BoardHost) =>
  render(
    <BoardProvider board={{ id: "b", pack: "fx", config: c, version: 1, updatedAt: new Date() }} catalogue={catalogue} host={host}>
      <Board />
    </BoardProvider>,
  );

const rec = (n: number) => ({ region: `r${n}`, size: 1000 + n });

describe("a table of rows", () => {
  const c = () =>
    config([{ op: "add_widget", id: "t", widget: { kind: "table", title: "Rows", query: { kind: "rows", entity: "items", columns: ["region", "size"], limit: 6, orderBy: { key: "size", dir: "asc" } }, pageSize: 5 } }]);

  it("labels its columns, shows rows X-Y, and asks the host for the next page only", async () => {
    const first: WidgetData = { rows: [], records: [1, 2, 3, 4, 5, 6].map(rec), columns: ["region", "size"], total: 6, format: "number" };
    const page1: WidgetPage = { rows: [], records: [6, 7, 8].map(rec), columns: ["region", "size"], total: 3, format: "number", page: 1, pageSize: 5, offset: 5, hasNext: false };
    const loadBoardData = vi.fn(async () => ({ t: first }));
    const loadWidgetPage = vi.fn(async () => page1);
    mount(c(), { loadBoardData, loadWidgetPage });
    await waitFor(() => expect(screen.getByText("rows 1-5")).toBeTruthy());
    expect(screen.getByText("Region")).toBeTruthy();
    expect(screen.getByText("1,001")).toBeTruthy();
    expect(screen.queryByText("r6")).toBeNull();
    fireEvent.click(screen.getByText("Next"));
    await waitFor(() => expect(screen.getByText("rows 6-8")).toBeTruthy());
    expect(loadWidgetPage).toHaveBeenCalledWith("t", 1, {});
    expect(loadBoardData).toHaveBeenCalledTimes(1);
    expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(true);
    // Back to page 0 of an ordered table: the board's own rows, no request.
    fireEvent.click(screen.getByText("Prev"));
    await waitFor(() => expect(screen.getByText("rows 1-5")).toBeTruthy());
    expect(loadWidgetPage).toHaveBeenCalledTimes(1);
  });
});

describe("an aggregate table", () => {
  it("sorts the fetched groups by a header on click", async () => {
    const c = config([
      { op: "add_widget", id: "a", widget: { kind: "table", title: "Agg", query: { kind: "breakdown", dimension: "region", measure: "count", measures: ["rate"], limit: 5, sort: "desc" }, pageSize: 10 } },
    ]);
    const data: WidgetData = {
      rows: [
        { group: "north", value: 9, count: 9, values: { rate: 0.1 } },
        { group: "south", value: 5, count: 5, values: { rate: 0.7 } },
      ],
      total: 14,
      format: "number",
      measures: [{ key: "count", format: "number" }, { key: "rate", format: "percent" }],
    };
    mount(c, { loadBoardData: async () => ({ a: data }) });
    await waitFor(() => expect(screen.getByText("north")).toBeTruthy());
    const groups = () => {
      const out: (string | null)[] = [];
      document.querySelectorAll("tbody tr td:first-child").forEach((td) => out.push(td.textContent));
      return out;
    };
    expect(groups()).toEqual(["north", "south"]);
    fireEvent.click(screen.getByText("Rate"));
    expect(groups()).toEqual(["south", "north"]);
    fireEvent.click(screen.getByText(/Rate/));
    expect(groups()).toEqual(["north", "south"]);
  });
});

describe("a computed answer", () => {
  it("is labelled with what was computed, in a table and on a KPI", async () => {
    const c = config([
      { op: "add_widget", id: "t", widget: { kind: "table", title: "Per region", query: { kind: "breakdown", dimension: "region", measure: "count", limit: 12, sort: "desc", compute: { grain: "day", steps: [{ op: "over_time", fn: "mean" }] } }, pageSize: 10 } },
      { op: "add_widget", id: "k", widget: { kind: "kpi", title: "Daily", query: { kind: "value", measure: "count", compute: { grain: "day", steps: [{ op: "change", percent: true }, { op: "over_time", fn: "mean" }] } } } },
    ]);
    const computed = "average daily count: a day with no records counts as 0";
    const t: WidgetData = { rows: [{ group: "north", value: 2.5, count: 10 }], total: 10, format: "number", label: "average daily count", computed };
    const k: WidgetData = { rows: [{ group: "count", value: 0.125, count: 10 }], total: 10, format: "percent", label: "average day-on-day % change in count" };
    mount(c, { loadBoardData: async () => ({ t, k }) });
    await waitFor(() => expect(screen.getByText("average daily count")).toBeTruthy());
    expect(screen.getByText("average daily count").getAttribute("title")).toBe(computed);
    expect(screen.getByText("2.5")).toBeTruthy();
    expect(screen.getByText("average day-on-day % change in count")).toBeTruthy();
    expect(screen.getByTestId("kpi-value").textContent).toBe("12.5%");
  });
});

describe("a text widget", () => {
  it("renders markdown as elements, never markup from the text, and never a link", async () => {
    const body =
      "A **bold** note\n\n- one\n- two\n\n<script>alert(1)</script> [docs](https://example.org) [x](javascript:void) [write](mailto:a@example.org)\n\nSee https://example.org/page or mailto:b@example.org or www.example.org";
    const c = config([{ op: "add_widget", id: "n", widget: { kind: "text", title: "Note", body } }]);
    mount(c, { loadBoardData: async () => ({}) });
    const md = await screen.findByTestId("markdown");
    expect(md.querySelector("strong")?.textContent).toBe("bold");
    expect(md.querySelectorAll("li").length).toBe(2);
    expect(md.querySelector("script")).toBeNull();
    expect(md.textContent).toContain("<script>alert(1)</script>");
    // A board holds no URLs: a link shows its text only, and a bare address stays text.
    expect(md.querySelectorAll("a").length).toBe(0);
    expect(md.querySelector("[href]")).toBeNull();
    expect(md.textContent).toContain("docs x write");
    expect(md.textContent).not.toContain("javascript:");
    expect(md.textContent).toContain("See https://example.org/page or mailto:b@example.org or www.example.org");
  });

  it("keeps links in a chat reply, where only http(s) and mailto are links", () => {
    render(<Markdown text="[docs](https://example.org) [x](javascript:alert(1)) [write](mailto:a@example.org)" />);
    const links = Array.from(screen.getByTestId("markdown").querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.org", "mailto:a@example.org"]);
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows a plain note as the same text it always did", async () => {
    const c = config([{ op: "add_widget", id: "n", widget: { kind: "text", title: "Note", body: "Counts are per day.\nSource: the telemetry store." } }]);
    mount(c, { loadBoardData: async () => ({}) });
    const md = await screen.findByTestId("markdown");
    expect(md.className).toBe("lp-text lp-md");
    expect(md.innerHTML).toBe("<p>Counts are per day.<br>Source: the telemetry store.</p>");
  });
});
