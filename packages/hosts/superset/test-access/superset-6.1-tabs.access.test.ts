// Tabs on Superset 6.1 (docs/features/tabs.md): a protected tab the chat and the board API never change, a tab made
// through the chat (made, filled, deleted), the tab limit, and the playground for a viewer (off, then on), all set
// through the admin settings routes and checked against the layout Superset keeps (position_json, read back through
// Superset's own API). Run with `pnpm test:access tabs`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Position, layoutProblems, reachable } from "../src/layout";
import { type ChatResult, PACK, type Session, type Stack, readChat, startStack } from "./stack";

describe.sequential("Superset 6.1.0: tabs", () => {
  let stack: Stack;
  const s: Record<string, Session> = {};
  let T = "";
  let dash = 0;

  const layout = async () => JSON.parse((await s.lp_admin!.send("GET", `/api/v1/dashboard/${dash}`)).json.result.position_json) as Position;
  /** The tabs above each chart Superset draws, by chart title. */
  const placed = (pos: Position) => {
    const drawn = reachable(pos);
    return Object.fromEntries(Object.values(pos).filter((c: any) => c?.type === "CHART" && drawn.has(c.id)).map((c: any) => [c.meta.sliceName, (c.parents as string[]).filter((p) => p.startsWith("TAB-")).join(">")]));
  };
  const topTabs = (pos: Position) => (pos["TABS-top"] as { children: string[] }).children;
  const chat = async (who: string, tool: string, args: object): Promise<ChatResult> =>
    readChat(await s[who]!.lp("POST", `api/${PACK}/${T}/chat?review=off`, { messages: [{ id: `m${Date.now()}${Math.random()}`, role: "user", parts: [{ type: "text", text: `TOOL ${tool} ${JSON.stringify(args)}` }] }], view: { tabs: ["TAB-overview"] } }));
  const out = (r: ChatResult) => {
    expect(r.status, r.error).toBe(200);
    expect(r.tools, JSON.stringify({ text: r.text, error: r.error })).toHaveLength(1);
    return r.tools[0]!.output;
  };
  const settings = (body: object) => s.lp_admin!.lp("PUT", "_superset/settings/tabs", body);
  const features = (body: object) => s.lp_admin!.lp("PUT", "_superset/settings/features", body);
  const kpi = (id: string, title: string, tab?: string) => ({ op: "add_widget", id, widget: { title, kind: "kpi", query: { kind: "value", measure: "stock_total" } }, placement: { place: "bottom", width: "quarter", ...(tab ? { tab } : {}) } });

  beforeAll(async () => {
    stack = await startStack("6.1.0");
    dash = stack.fixtures.dashboards.t;
    // The viewer opens T through its dashboard role, and may not edit it (not an owner).
    stack.giveRole("lp_viewer", "lp_board_t");
    for (const u of ["lp_admin", "lp_viewer"]) s[u] = await stack.as(u);
    const bound = await s.lp_admin!.lp("GET", `_superset/bind?dashboard=${dash}`);
    expect(bound.status, bound.text).toBe(200);
    T = bound.json.board;
    // A chart on Stock and one on Overview, put there through the board API before any tab rule is set.
    const r = await s.lp_admin!.lp("POST", `api/${PACK}/${T}/ops`, { ops: [kpi("stock_kpi", "Stock total", "TAB-stock"), kpi("overview_kpi", "Overview total", "TAB-overview")] });
    expect(r.json, r.text).toMatchObject({ ok: true });
    expect(placed(await layout())).toEqual({ "Stock total": "TAB-stock", "Overview total": "TAB-overview" });
  }, 900_000);
  afterAll(async () => {
    await stack?.stop();
  });

  it("everything is off by default, and the settings API says so", async () => {
    expect(stack.log()).toMatch(/tabs: chat changes any tab not protected; protected none; chat tabs off; playground off; at most 3 per person and 20 per dashboard; widgets per tab auto/);
    const got = (await s.lp_admin!.lp("GET", "_superset/settings")).json.tabs;
    expect(got).toMatchObject({ editable: "all", protected: {}, maxPerDashboard: 20, maxPerUser: 3, maxWidgetsPerTab: "auto", create: false, playground: false });
    // Only admins read and change them.
    expect((await s.lp_viewer!.lp("GET", "_superset/settings/tabs")).status).toBe(403);
    expect((await s.lp_viewer!.lp("PUT", "_superset/settings/tabs", { editable: "own" })).status).toBe(403);
  });

  describe("a protected tab", () => {
    beforeAll(async () => {
      const r = await settings({ protected: { [String(dash)]: ["TAB-stock"] } });
      expect(r.status, r.text).toBe(200);
      expect(stack.log()).toMatch(new RegExp(`protected dashboard ${dash}: TAB-stock`));
    });

    it("the chat leaves it as it is, for an admin too, and says why", async () => {
      const before = await layout();
      const removed = out(await chat("lp_admin", "remove_widget", { id: "stock_kpi" }));
      expect(removed).toMatchObject({ applied: false, error: expect.stringMatching(/“Stock” is protected/) });
      const added = out(await chat("lp_admin", "add_widget", { id: "more_stock", title: "More stock", kind: "kpi", query_kind: "value", measure: "stock_total", tab: "Stock" }));
      expect(added).toMatchObject({ applied: false });
      expect(await layout()).toEqual(before);
    });

    it("the board API and a restore can't change it either", async () => {
      const before = await layout();
      const r = await s.lp_admin!.lp("POST", `api/${PACK}/${T}/ops`, { ops: [{ op: "resize_widget", id: "stock_kpi", width: "half" }] });
      expect(r.json).toMatchObject({ ok: false, error: expect.stringMatching(/protected/) });
      const versions = (await s.lp_admin!.lp("GET", `api/${PACK}/${T}/versions`)).json as { version: number }[];
      const back = await s.lp_admin!.lp("POST", `api/${PACK}/${T}/revert`, { version: versions.at(-1)!.version });
      expect(back.status).toBe(403);
      expect(await layout()).toEqual(before);
    });

    it("another tab still changes", async () => {
      expect(out(await chat("lp_admin", "add_widget", { id: "ov2", title: "Overview two", kind: "kpi", query_kind: "value", measure: "stock_total", tab: "Overview" }))).toMatchObject({ applied: true });
      expect(placed(await layout())["Overview two"]).toBe("TAB-overview");
    });
  });

  describe("tabs made through the chat", () => {
    beforeAll(async () => {
      expect((await features({ chatTabs: true })).status).toBe(200);
    });

    it("an admin makes a tab, puts a chart on it and deletes it", async () => {
      const made = out(await chat("lp_admin", "add_tab", { title: "Scratch" }));
      expect(made).toMatchObject({ applied: true, tab: { title: "Scratch" } });
      const id = made.tab.id as string;
      expect(topTabs(await layout())).toEqual(["TAB-overview", "TAB-stock", id]);
      expect(out(await chat("lp_admin", "add_widget", { id: "scratch_kpi", title: "Scratch total", kind: "kpi", query_kind: "value", measure: "visit_total", tab: "Scratch" }))).toMatchObject({ applied: true });
      expect(placed(await layout())["Scratch total"]).toBe(id);
      const listed = (await s.lp_admin!.lp("GET", "_superset/tabs")).json.tabs;
      expect(listed).toEqual([expect.objectContaining({ dashboard: dash, tab: id, title: "Scratch", user: "lp_admin", widgets: 1 })]);
      expect(out(await chat("lp_admin", "remove_tab", { tab: "Scratch" }))).toMatchObject({ applied: true, removedWidgets: ["Scratch total"] });
      const pos = await layout();
      expect(topTabs(pos)).toEqual(["TAB-overview", "TAB-stock"]);
      expect(placed(pos)["Scratch total"]).toBeUndefined();
      expect(layoutProblems(pos)).toEqual([]);
    });

    it("over the limit: refused, with the limit and how to free one", async () => {
      expect((await settings({ maxPerUser: 1 })).status).toBe(200);
      expect(out(await chat("lp_admin", "add_tab", { title: "One" }))).toMatchObject({ applied: true });
      const r = out(await chat("lp_admin", "add_tab", { title: "Two" }));
      expect(r.applied).toBe(false);
      expect(r.error).toMatch(/the most one person may have here \(1\)\. Delete one of them first/);
      // An admin deletes it through the admin API.
      const one = (await s.lp_admin!.lp("GET", "_superset/tabs")).json.tabs[0];
      expect((await s.lp_admin!.lp("DELETE", `_superset/tabs/${dash}/${one.tab}`)).status).toBe(200);
      expect(topTabs(await layout())).toEqual(["TAB-overview", "TAB-stock"]);
      expect((await settings({ maxPerUser: null })).status).toBe(200);
    });
  });

  describe("the playground", () => {
    it("off: a viewer changes nothing", async () => {
      const r = out(await chat("lp_viewer", "add_widget", { id: "v1", title: "Mine", kind: "kpi", query_kind: "value", measure: "stock_total" }));
      expect(r).toMatchObject({ applied: false });
      expect(placed(await layout()).Mine).toBeUndefined();
    });

    it("on: a viewer gets a tab named after them, widgets only there, and deletes it; the audit names them", async () => {
      expect((await features({ playground: true })).status).toBe(200);
      const made = out(await chat("lp_viewer", "add_tab", { title: "" }));
      expect(made).toMatchObject({ applied: true, tab: { title: "lp_viewer" } });
      const id = made.tab.id as string;
      expect(out(await chat("lp_viewer", "add_widget", { id: "v1", title: "Mine", kind: "kpi", query_kind: "value", measure: "stock_total", tab: "lp_viewer" }))).toMatchObject({ applied: true });
      expect(placed(await layout()).Mine).toBe(id);
      // Nowhere else: not a shared tab, not the title.
      expect(out(await chat("lp_viewer", "add_widget", { id: "v2", title: "Theirs", kind: "kpi", query_kind: "value", measure: "stock_total", tab: "Overview" }))).toMatchObject({ applied: false, error: expect.stringMatching(/view this dashboard but not edit it/) });
      expect(out(await chat("lp_viewer", "rename_board", { title: "Mine now" }))).toMatchObject({ applied: false });
      // Saved by Lenspack's account; the audit log names the person.
      const events = (await s.lp_admin!.lp("GET", "_superset/audit?limit=200")).json.events as { user: string; action: string; outcome: string; detail?: string }[];
      expect(events.some((e) => e.user === "lp_viewer" && e.action === "chat-edit" && e.outcome === "ok" && /add_tab/.test(e.detail ?? ""))).toBe(true);
      expect(out(await chat("lp_viewer", "remove_tab", { tab: "lp_viewer" }))).toMatchObject({ applied: true });
      const pos = await layout();
      expect(topTabs(pos)).toEqual(["TAB-overview", "TAB-stock"]);
      expect(placed(pos)).toMatchObject({ "Stock total": "TAB-stock" });
      expect(layoutProblems(pos)).toEqual([]);
    });
  });
});
