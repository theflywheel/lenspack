// The chat's tab tools and the tab check before every edit: a refusal is the tool's answer (so the reply and the
// reviewer see it), nothing is queued past it, and a viewer on the playground changes only tabs of their own.
import { type BoardConfig, boardConfigSchema, memoryStore } from "@lenspack/core";
import { TAB_DEFAULTS, type TabActor, type TabRules, checkTabChange, keepsName, mayAddTab, mayMakeTabs, namedTabs, playgroundTitle } from "@lenspack/policy";
import { sqlConnector } from "@lenspack/sql";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pack, seedFixture } from "../../../sources/sql/test/fixture-pack";
import type { TabPort } from "../src/tabs";
import { type Tool, boardTools } from "../src/tools";

let db: Awaited<ReturnType<typeof openDuckdb>>;
beforeAll(async () => {
  db = await openDuckdb();
  await seedFixture(db.writer, "duckdb");
});
afterAll(async () => db.close());

const note = (title: string) => ({ kind: "text" as const, title, body: "n" });
const tabbed = (): BoardConfig =>
  boardConfigSchema.parse({
    version: 2,
    pack: pack.pack,
    packVersion: pack.version,
    title: "Tabs",
    tabs: [
      { id: "TAB-kpi", title: "KPIs" },
      { id: "TAB-trend", title: "Trends" },
    ],
    widgets: { a: note("A"), b: note("B") },
    layout: [
      { i: "a", x: 0, y: 0, w: 6, h: 3, tab: "TAB-kpi" },
      { i: "b", x: 0, y: 3, w: 6, h: 3, tab: "TAB-trend" },
    ],
  });

/** A TabPort as a host builds it: policy decides, a record of who made which tab. */
function port(who: TabActor, rules: TabRules, made: Record<string, { user: string }> = {}, reports: string[] | null = []): TabPort & { made: typeof made } {
  let n = 0;
  return {
    made,
    canMake: mayMakeTabs(who, rules),
    named: namedTabs(who, rules),
    playground: !who.edits && rules.playground,
    async check(before, after) {
      const v = checkTabChange(who, before, after, "b", { made }, rules);
      if (!v.ok) return v.why;
      for (const t of v.made) made[t] = { user: who.user };
      return null;
    },
    async mayAdd(config) {
      const v = mayAddTab(who, config, { made }, rules);
      return v.ok ? null : v.why;
    },
    newTabId: () => `TAB-lp-${++n}`,
    titleFor: (words, taken, current) => (!namedTabs(who, rules) ? words.trim() : current !== undefined && keepsName(who.user, words) ? words.trim() : playgroundTitle(who.user, words, taken)),
    reportsOn: async () => reports,
    describe: async () => "",
  };
}

async function setup(who: TabActor, rules: Partial<TabRules>, o: { readOnly?: string; reports?: string[] | null; made?: Record<string, { user: string }> } = {}) {
  const store = memoryStore();
  await store.create({ id: "b", pack, title: "Tabs", config: tabbed() });
  const p = port(who, { ...TAB_DEFAULTS, ...rules }, o.made ?? {}, o.reports === undefined ? [] : o.reports);
  const tools: Record<string, Tool> = Object.fromEntries(boardTools({ pack, connector: sqlConnector(db.executor), store, boardId: "b", ctx: { tenant: "t1" }, tabs: p, ...(o.readOnly ? { readOnly: o.readOnly } : {}), view: { tabs: ["TAB-trend"] } }).map((t) => [t.name, t]));
  const call = (name: string, args: Record<string, unknown> = {}) => tools[name]!.execute(tools[name]!.inputSchema.parse(args) as never) as Promise<any>;
  const config = async () => (await store.get("b"))!.config;
  return { tools, call, config, port: p };
}

const editor: TabActor = { user: "ben", admin: false, edits: true };
const viewer: TabActor = { user: "vic", admin: false, edits: false };

describe("tab tools", () => {
  it("are offered only when the host gives a TabPort; add_tab only to someone who may make tabs", async () => {
    expect(Object.keys((await setup(editor, { editable: "own" })).tools)).not.toContain("add_tab");
    expect(Object.keys((await setup(editor, { create: true })).tools)).toEqual(expect.arrayContaining(["add_tab", "rename_tab", "remove_tab"]));
  });

  it("an editor makes, fills, renames and deletes a tab; the widget goes on the tab asked for, else the viewer's", async () => {
    const t = await setup(editor, { create: true });
    const made = await t.call("add_tab", { title: "Stock" });
    expect(made).toMatchObject({ applied: true, tab: { id: "TAB-lp-1", title: "Stock" } });
    expect(await t.call("add_widget", { id: "n1", kind: "text", title: "N1", body: "x", query_kind: "value", measure: "things", tab: "Stock" })).toMatchObject({ applied: true });
    expect(await t.call("add_widget", { id: "n2", kind: "text", title: "N2", body: "x", query_kind: "value", measure: "things" })).toMatchObject({ applied: true });
    const c = await t.config();
    expect(c.layout.find((l) => l.i === "n1")!.tab).toBe("TAB-lp-1");
    expect(c.layout.find((l) => l.i === "n2")!.tab).toBe("TAB-trend");
    expect(await t.call("rename_tab", { tab: "Stock", title: "Stock levels" })).toMatchObject({ applied: true });
    expect(await t.call("remove_tab", { tab: "Stock levels" })).toMatchObject({ applied: true, removedWidgets: ["N1"] });
    expect((await t.config()).tabs!.map((t) => t.id)).toEqual(["TAB-kpi", "TAB-trend"]);
  });

  it("a protected tab: the edit is refused before it is queued, in words the reply can use", async () => {
    const t = await setup(editor, { protected: { b: ["TAB-trend"] } });
    const r = await t.call("add_widget", { id: "n", kind: "text", title: "N", body: "x", query_kind: "value", measure: "things", tab: "Trends" });
    expect(r).toMatchObject({ applied: false, tabRule: true, error: expect.stringContaining("protected") });
    expect(await t.call("remove_widget", { id: "b" })).toMatchObject({ applied: false, tabRule: true });
    expect((await t.config()).widgets.b).toBeDefined();
    // A restore that would change it is refused too.
    expect(await t.call("add_widget", { id: "k", kind: "text", title: "K", body: "x", query_kind: "value", measure: "things", tab: "KPIs" })).toMatchObject({ applied: true });
  });

  it("the tab limit: refused with the limit and how to free one", async () => {
    const t = await setup(editor, { create: true, maxPerUser: 1 });
    expect(await t.call("add_tab", { title: "One" })).toMatchObject({ applied: true });
    const r = await t.call("add_tab", { title: "Two" });
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/the most one person may have here \(1\).*Delete one of them first/);
  });

  it("deleting a tab email reports are sent from asks first", async () => {
    const t = await setup(editor, { create: true }, { reports: ["Weekly KPIs"] });
    await t.call("add_tab", { title: "Mine" });
    expect(await t.call("remove_tab", { tab: "Mine" })).toMatchObject({ applied: false, needsConfirmation: true, reports: ["Weekly KPIs"] });
    expect(await t.call("remove_tab", { tab: "Mine", confirmed: true })).toMatchObject({ applied: true });
  });

  it("the playground: a viewer gets a tab named after them, widgets only there, and nothing else", async () => {
    const t = await setup(viewer, { playground: true }, { readOnly: "You can view this dashboard but not edit it." });
    const made = await t.call("add_tab", { title: "stock" });
    expect(made).toMatchObject({ applied: true, tab: { title: "vic: stock" } });
    expect(await t.call("add_widget", { id: "n", kind: "text", title: "N", body: "x", query_kind: "value", measure: "things", tab: "vic: stock" })).toMatchObject({ applied: true });
    expect(await t.call("add_widget", { id: "m", kind: "text", title: "M", body: "x", query_kind: "value", measure: "things", tab: "KPIs" })).toMatchObject({ applied: false, error: expect.stringContaining("view") });
    expect(await t.call("rename_board", { title: "Mine now" })).toMatchObject({ applied: false });
    expect(await t.call("remove_tab", { tab: "Trends" })).toMatchObject({ applied: false });
    expect(await t.call("remove_tab", { tab: "vic: stock" })).toMatchObject({ applied: true });
  });

  it("with the playground off, a viewer's edits are refused outright, as before", async () => {
    const t = await setup(viewer, { editable: "own" }, { readOnly: "View only." });
    expect(await t.call("add_widget", { id: "n", kind: "text", title: "N", body: "x", query_kind: "value", measure: "things" })).toEqual({ applied: false, error: "View only.", readOnly: true });
  });
});
