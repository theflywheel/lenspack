// Tabs: which tabs the chat may change for whom, how many tabs and widgets it may make. One pure check of the board
// before and after a write, for every path that writes.
import { describe, expect, it } from "vitest";

import { type BoardConfig, boardConfigSchema } from "@lenspack/core";
import { MIN_AUTO_WIDGETS, TAB_DEFAULTS, type TabActor, type TabFacts, type TabRules, checkTabChange, keepsName, mayAddTab, playgroundTitle, protectedFrom, protectedTabIds, tabRights, tabRulesFrom, tabRulesInForce, widgetLimit } from "../src";

const B = "superset-12";
const text = (title: string) => ({ kind: "text" as const, title, body: "note" });

/** A board with two tabs (KPIs with an inner tab, and Trends) and a tab made through the chat by olu. */
function board(): BoardConfig {
  return boardConfigSchema.parse({
    version: 2,
    pack: "p",
    packVersion: 1,
    title: "Board",
    tabs: [
      { id: "TAB-kpi", title: "KPIs" },
      { id: "TAB-kpi-in", title: "Inner", parent: "TAB-kpi" },
      { id: "TAB-trend", title: "Trends" },
      { id: "TAB-lp-olu", title: "olu" },
    ],
    widgets: { a: text("A"), b: text("B"), c: text("C"), d: text("D"), e: text("E"), x: text("X") },
    layout: [
      { i: "a", x: 0, y: 0, w: 6, h: 4, tab: "TAB-kpi" },
      { i: "b", x: 6, y: 0, w: 6, h: 4, tab: "TAB-kpi" },
      { i: "c", x: 0, y: 4, w: 6, h: 4, tab: "TAB-kpi-in" },
      { i: "d", x: 0, y: 8, w: 6, h: 4, tab: "TAB-trend" },
      { i: "e", x: 6, y: 8, w: 6, h: 4, tab: "TAB-trend" },
      { i: "x", x: 0, y: 12, w: 6, h: 4, tab: "TAB-lp-olu" },
    ],
    filters: [
      { id: "f_all", type: "select", label: "Region", field: "region", applies: ["*"] },
      { id: "f_trend", type: "select", label: "Ward", field: "ward", applies: ["d", "e"] },
    ],
  });
}

const facts: TabFacts = { made: { "TAB-lp-olu": { user: "olu", userId: 5 } } };
const editor: TabActor = { user: "ben", userId: 7, admin: false, edits: true };
const admin: TabActor = { user: "ada", userId: 1, admin: true, edits: true };
const olu: TabActor = { user: "olu", userId: 5, admin: false, edits: false };
const viewer: TabActor = { user: "vic", userId: 9, admin: false, edits: false };
const rules = (r: Partial<TabRules> = {}): TabRules => ({ ...TAB_DEFAULTS, ...r });

/** The board after changing it in place. */
const after = (f: (c: BoardConfig) => void) => {
  const c = structuredClone(board());
  f(c);
  return c;
};
const addWidget = (id: string, tab: string) => (c: BoardConfig) => {
  c.widgets[id] = text(id.toUpperCase());
  c.layout.push({ i: id, x: 0, y: 20, w: 6, h: 4, tab });
};
const check = (who: TabActor, a: BoardConfig, r: TabRules, f: TabFacts = facts) => checkTabChange(who, board(), a, B, f, r);

describe("tab rules", () => {
  it("with none in force, every write passes, as before", () => {
    expect(tabRulesInForce(rules(), B)).toBe(false);
    expect(check(viewer, after((c) => void (c.title = "x")), rules())).toEqual({ ok: true, made: [] });
  });

  it("a protected tab: nobody changes it, admins included, nor the tabs inside it", () => {
    const r = rules({ protected: { [B]: ["TAB-kpi"] } });
    expect(protectedTabIds(board(), B, facts, r)).toEqual(["TAB-kpi", "TAB-kpi-in"]);
    for (const who of [editor, admin]) {
      expect(check(who, after((c) => void (c.tabs![0]!.title = "Renamed")), r)).toMatchObject({ ok: false, code: "protected-tab" });
      expect(check(who, after(addWidget("n", "TAB-kpi-in")), r)).toMatchObject({ ok: false, code: "protected-tab" });
      expect(check(who, after((c) => void (c.layout.find((l) => l.i === "a")!.w = 3)), r)).toMatchObject({ ok: false, code: "protected-tab" });
      expect(check(who, after((c) => void (c.widgets.b = text("Changed"))), r)).toMatchObject({ ok: false, code: "protected-tab" });
    }
    // Another tab is still the editor's to change.
    expect(check(editor, after(addWidget("n", "TAB-trend")), r)).toMatchObject({ ok: true });
  });

  it("a protected tab's place, existence and the filters that reach it", () => {
    const r = rules({ protected: { [B]: ["TAB-trend"] } });
    // Removing the tab before it doesn't move it; moving it does.
    expect(check(admin, after((c) => void (c.tabs = c.tabs!.filter((t) => t.id !== "TAB-lp-olu"))), r)).toMatchObject({ ok: true });
    expect(check(admin, after((c) => void c.tabs!.unshift(...c.tabs!.splice(2, 1))), r)).toMatchObject({ ok: false, code: "protected-tab" });
    // A filter on every widget reaches it; one on its widgets only too; one on others' widgets doesn't.
    expect(check(editor, after((c) => void (c.filters[0]!.label = "Area")), r)).toMatchObject({ ok: false, code: "protected-tab" });
    expect(check(editor, after((c) => void c.filters.splice(1, 1)), r)).toMatchObject({ ok: false, code: "protected-tab" });
    expect(check(editor, after((c) => void c.filters.push({ id: "f_new", type: "select", label: "New", field: "x", applies: ["a"] })), r)).toMatchObject({ ok: true });
    // Taking a widget into a filter reaches only that widget's tab.
    expect(check(editor, after((c) => void (c.filters[1]!.applies = ["d", "e", "a"])), r)).toMatchObject({ ok: true });
  });

  it("under own: only tabs made through the chat, and nothing of the whole dashboard", () => {
    const r = rules({ editable: "own" });
    expect(protectedTabIds(board(), B, facts, r)).toEqual(["TAB-kpi", "TAB-kpi-in", "TAB-trend"]);
    expect(check(editor, after(addWidget("n", "TAB-trend")), r)).toMatchObject({ ok: false, code: "protected-tab" });
    expect(check(admin, after(addWidget("n", "TAB-trend")), r)).toMatchObject({ ok: false, code: "protected-tab" });
    expect(check(admin, after((c) => void (c.title = "New")), r)).toMatchObject({ ok: false, code: "whole-board" });
    // olu's own tab is olu's (and an admin's), not another editor's.
    const onOwn = after(addWidget("n", "TAB-lp-olu"));
    expect(check({ ...olu, edits: true }, onOwn, r)).toMatchObject({ ok: true });
    expect(check(admin, onOwn, r)).toMatchObject({ ok: true });
    expect(check(editor, onOwn, r)).toMatchObject({ ok: false, code: "not-your-tab" });
  });

  it("deleting: makers their own tabs, admins any unprotected tab, editors no shared tab", () => {
    const r = rules({ create: true });
    const dropTrend = after((c) => {
      c.tabs = c.tabs!.filter((t) => t.id !== "TAB-trend");
      c.layout = c.layout.filter((l) => l.tab !== "TAB-trend");
      delete c.widgets.d;
      delete c.widgets.e;
      c.filters = c.filters.filter((f) => f.id !== "f_trend");
    });
    expect(check(editor, dropTrend, r)).toMatchObject({ ok: false, code: "not-your-tab" });
    expect(check(admin, dropTrend, r)).toMatchObject({ ok: true });
    const dropOwn = after((c) => {
      c.tabs = c.tabs!.filter((t) => t.id !== "TAB-lp-olu");
      c.layout = c.layout.filter((l) => l.i !== "x");
      delete c.widgets.x;
    });
    expect(check({ ...olu, edits: true }, dropOwn, r)).toMatchObject({ ok: true });
    expect(check(editor, dropOwn, r)).toMatchObject({ ok: false, code: "not-your-tab" });
  });

  it("making tabs: the switch, the person's limit and the dashboard's, refused in words that say how to free one", () => {
    const newTab = (id: string, title: string) => after((c) => void c.tabs!.push({ id, title }));
    expect(check(editor, newTab("TAB-lp-new", "Mine"), rules({ editable: "own" }))).toMatchObject({ ok: false, code: "no-tabs-right" });
    expect(check(editor, newTab("TAB-lp-new", "Mine"), rules({ create: true }))).toEqual({ ok: true, made: ["TAB-lp-new"] });
    // A host's tab id brought back is a change to that tab, never a new tab of the person's own.
    expect(check(editor, newTab("TAB-zz", "Zed"), rules({ create: true, editable: "own" }))).toMatchObject({ ok: false, code: "protected-tab" });
    const oluTwo: TabFacts = { made: { ...facts.made, "TAB-lp-olu": { user: "olu", userId: 5 } } };
    const r = rules({ playground: true, maxPerUser: 1 });
    const v = check(olu, newTab("TAB-lp-two", "olu 2"), r, oluTwo);
    expect(v).toMatchObject({ ok: false, code: "tab-limit" });
    expect(!v.ok && v.why).toMatch(/most one person|more than one person may have here \(1\).*Delete one of yours first \(“olu”\)/);
    expect(mayAddTab(olu, board(), facts, r)).toMatchObject({ ok: false, code: "tab-limit" });
    expect(mayAddTab(olu, board(), facts, rules({ playground: true, maxPerDashboard: 1 }))).toMatchObject({ ok: false, code: "tab-limit" });
    expect(mayAddTab(viewer, board(), facts, rules({ playground: true }))).toEqual({ ok: true, made: [] });
    expect(mayAddTab(viewer, board(), facts, rules({ create: true }))).toMatchObject({ ok: false, code: "no-tabs-right" });
    expect(mayAddTab(editor, { ...board(), tabs: undefined }, facts, rules({ create: true }))).toMatchObject({ ok: false, code: "no-tabs-right" });
  });

  it("widgets per tab: by default 1.5 × the fullest tab not made through the chat, at least the floor; or a number", () => {
    expect(widgetLimit(board(), facts, rules())).toBe(MIN_AUTO_WIDGETS);
    const big = after((c) => {
      for (const id of ["k1", "k2", "k3", "k4"]) addWidget(id, "TAB-trend")(c);
    });
    // Trends now has 6: the limit is 9.
    expect(widgetLimit(big, facts, rules())).toBe(9);
    const r = rules({ create: true, maxWidgetsPerTab: 2 });
    expect(check(editor, after(addWidget("n", "TAB-trend")), r)).toMatchObject({ ok: false, code: "widget-limit" });
    expect(check({ ...olu, edits: true }, after(addWidget("n", "TAB-lp-olu")), r)).toMatchObject({ ok: true });
    // A tab already over the limit may still lose widgets or have one changed.
    expect(check(editor, after((c) => void (c.widgets.d = text("Changed"))), r)).toMatchObject({ ok: true });
  });

  it("the playground: a viewer changes their own tabs only, and nothing with it off", () => {
    const r = rules({ playground: true });
    const mine = after(addWidget("n", "TAB-lp-olu"));
    expect(check(olu, mine, r)).toMatchObject({ ok: true });
    expect(check(olu, mine, rules({ protected: { [B]: ["TAB-kpi"] } }))).toMatchObject({ ok: true }); // the guard passes; the host's edit right refuses viewers
    expect(check(viewer, mine, r)).toMatchObject({ ok: false, code: "not-your-tab" });
    expect(check(olu, after(addWidget("n", "TAB-trend")), r)).toMatchObject({ ok: false, code: "view-only" });
    expect(check(olu, after((c) => void (c.title = "x")), r)).toMatchObject({ ok: false, code: "view-only" });
    expect(check(olu, after((c) => void c.filters.push({ id: "f_mine", type: "select", label: "Mine", field: "y", applies: ["*"] })), r)).toMatchObject({ ok: false, code: "view-only" });
    expect(check(olu, after((c) => void c.filters.push({ id: "f_mine", type: "select", label: "Mine", field: "y", applies: ["x"] })), r)).toMatchObject({ ok: true });
    // A tab of their own is named after them.
    expect(check(viewer, after((c) => void c.tabs!.push({ id: "TAB-lp-v", title: "Sales" })), r)).toMatchObject({ ok: false, code: "no-tabs-right" });
    expect(check(viewer, after((c) => void c.tabs!.push({ id: "TAB-lp-v", title: "vic: sales" })), r)).toEqual({ ok: true, made: ["TAB-lp-v"] });
    // On a board without tabs a viewer changes nothing.
    const flat = { ...board(), tabs: undefined, layout: board().layout.map(({ tab: _t, ...l }) => l) };
    expect(checkTabChange(viewer, flat, { ...flat, title: "x" }, B, facts, r)).toMatchObject({ ok: false, code: "view-only" });
  });

  it("tabRights says who may change and remove one tab", () => {
    const tabs = board().tabs!;
    expect(tabRights(editor, "TAB-trend", tabs, B, facts, rules())).toMatchObject({ change: { ok: true }, remove: { ok: false } });
    expect(tabRights(admin, "TAB-trend", tabs, B, facts, rules())).toMatchObject({ change: { ok: true }, remove: { ok: true } });
    expect(tabRights(viewer, "TAB-trend", tabs, B, facts, rules())).toMatchObject({ change: { ok: false, code: "view-only" } });
    expect(tabRights(olu, "TAB-lp-olu", tabs, B, facts, rules())).toMatchObject({ change: { ok: true }, remove: { ok: true } });
  });

  it("playground titles keep the person's name", () => {
    expect(playgroundTitle("olu", "", [])).toBe("olu");
    expect(playgroundTitle("olu", "stock trend", [])).toBe("olu: stock trend");
    expect(playgroundTitle("olu", "olu: stock", [])).toBe("olu: stock");
    expect(playgroundTitle("olu", "", ["olu", "OLU 2"])).toBe("olu 3");
    expect(keepsName("olu", "olu: x")).toBe(true);
    expect(keepsName("olu", "olu 2")).toBe(true);
    expect(keepsName("olu", "sales")).toBe(false);
  });
});

describe("tab settings", () => {
  it("off by default; config, then environment, checked", () => {
    expect(tabRulesFrom(undefined)).toEqual({ editable: "all", protected: {}, maxPerDashboard: 20, maxPerUser: 3, maxWidgetsPerTab: "auto" });
    expect(tabRulesFrom({ editable: "own", protected: { "12": ["TAB-a", { id: "TAB-b", title: "KPIs" }] }, maxWidgetsPerTab: 8 })).toMatchObject({ editable: "own", protected: { "12": ["TAB-a", "TAB-b"] }, maxWidgetsPerTab: 8 });
    expect(tabRulesFrom({ editable: "own" }, { LENSPACK_TABS_EDITABLE: "all", LENSPACK_MAX_TABS_PER_USER: "5", LENSPACK_PROTECTED_TABS: "12=TAB-a|TAB-b;13=TAB-c" })).toMatchObject({ editable: "all", maxPerUser: 5, protected: { "12": ["TAB-a", "TAB-b"], "13": ["TAB-c"] } });
    expect(() => tabRulesFrom({ editable: "mine" })).toThrow(/"all" or "own"/);
    expect(() => tabRulesFrom({ maxPerUser: -1 })).toThrow(/whole number/);
    expect(() => tabRulesFrom({ wat: 1 })).toThrow(/not a setting/);
    expect(() => protectedFrom({ "12": ["Official KPIs"] })).toThrow(/not a tab id/);
    expect(protectedFrom('{"12":["TAB-x"]}')).toEqual({ "12": ["TAB-x"] });
  });
});
