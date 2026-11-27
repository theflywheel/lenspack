// Tabs on a host's dashboards: which tabs the chat may change, who may have the chat make a tab, how many tabs and
// how many widgets on one tab. Pure functions of the board before and after a write (BoardConfig.tabs, each widget's
// tab), who is asking, who made which tab through the chat (a durable record the host keeps) and the deployment's
// rules. Every write asks checkTabChange: the chat's edit tools before an edit is queued, and the host's store on
// every write (the chat, the board API, a restore, an applied layout). Hosts render and write; they don't decide.
//
// Superset has no per-tab permissions: these rules bind the chat (and Lenspack's own routes) only. Someone editing
// the dashboard in Superset itself can still change any tab.

import { type BoardConfig, type TabDef, tabAndAbove, tabAndInside, tabPath, widgetsByTab } from "@lenspack/core";

/** Which tabs the chat may change: "all" (the default: any tab not protected) or "own" (only tabs made through the chat). */
export const TAB_MODES = ["all", "own"] as const;
export type TabMode = (typeof TAB_MODES)[number];

/**
 * The deployment's tab rules. `protected`: per board, the tab ids the chat never changes (for admins too). `create`:
 * people who may edit a dashboard may have the chat make, rename and delete tabs there (the chatTabs switch).
 * `playground`: anyone who may open a dashboard, viewers too, may have the chat make tabs of their own there, named
 * after them, and change only those. The limits count tabs made through the chat that are on the dashboard now.
 */
export type TabRules = {
  editable: TabMode;
  protected: Readonly<Record<string, readonly string[]>>;
  maxPerDashboard: number;
  maxPerUser: number;
  /** "auto": 1.5 times the most widgets on any one tab not made through the chat, at least MIN_AUTO_WIDGETS. */
  maxWidgetsPerTab: "auto" | number;
  create: boolean;
  playground: boolean;
};

export const TAB_DEFAULTS: TabRules = { editable: "all", protected: {}, maxPerDashboard: 20, maxPerUser: 3, maxWidgetsPerTab: "auto", create: false, playground: false };
/** The fewest widgets the "auto" widget limit allows on a tab, so a dashboard of small tabs still leaves room. */
export const MIN_AUTO_WIDGETS = 4;

/** Who made a tab through the chat, as the host records it. */
export type TabMaker = { user: string; userId?: string | number | null; playground?: boolean };

/**
 * Who is asking, as the host and policy settled it: their name and host id, whether they hold Lenspack's admin role,
 * and whether they may edit this dashboard at all (boardRights' edit: the host's edit right, the edit policy, the
 * edit switch and scope). Someone who may only view it changes nothing but tabs of their own, and only with the
 * playground on.
 */
export type TabActor = { user: string; userId?: string | number | null; admin: boolean; edits: boolean };

/** What the host knows about one board's tabs: who made which through the chat (by tab id, kept after a tab is deleted, so Undo brings its maker back). */
export type TabFacts = { made: Readonly<Record<string, TabMaker>> };

export type TabRefusal = "protected-tab" | "not-your-tab" | "view-only" | "whole-board" | "no-tabs-right" | "tab-limit" | "widget-limit";
export type TabVerdict = { ok: true; made: string[] } | { ok: false; code: TabRefusal; why: string };

const no = (code: TabRefusal, why: string): TabVerdict => ({ ok: false, code, why });

/** A tab id Lenspack makes: only these are taken as new tabs the chat made, so a restore can't claim a host's tab. */
export const CHAT_TAB_PREFIX = "TAB-lp-";

/** Whether this tab was made through the chat by this person: the host id when both have one, else the name. */
export function madeBy(maker: TabMaker | undefined, who: Pick<TabActor, "user" | "userId">): boolean {
  if (!maker) return false;
  if (maker.userId !== undefined && maker.userId !== null && who.userId !== undefined && who.userId !== null) return String(maker.userId) === String(who.userId);
  return maker.user === who.user;
}

/** Whether any tab rule is in force on this board. With none, the chat works on tabs as before and nothing is checked. */
export const tabRulesInForce = (rules: TabRules, board: string): boolean => rules.editable === "own" || rules.create || rules.playground || !!rules.protected[board]?.length;

/** Whether this person may have the chat make tabs: an editor with the chatTabs switch on, or anyone with the playground on. */
export const mayMakeTabs = (who: TabActor, rules: TabRules): boolean => (rules.create && who.edits) || rules.playground;

/** Whether the tabs this person makes must carry their name (the playground's rule): all but editors with the chatTabs switch on. */
export const namedTabs = (who: TabActor, rules: TabRules): boolean => !(rules.create && who.edits);

/**
 * The title of a tab of one's own on the playground: the person's name, then their words after a colon when they gave
 * some ("asha: stock trend"), cut to 80 characters, and numbered when that title is taken.
 */
export function playgroundTitle(user: string, words: string, taken: readonly string[]): string {
  const name = user.trim() || "my tab";
  const rest = words.trim().replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:?\\s*`, "i"), "");
  const base = (rest ? `${name}: ${rest}` : name).slice(0, 76).trim();
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!lower.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** Whether a title keeps the playground's rule: the person's name, alone or before a colon. */
export const keepsName = (user: string, title: string) => {
  const t = title.trim().toLowerCase();
  const n = user.trim().toLowerCase();
  return t === n || t.startsWith(`${n}:`) || new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+$`).test(t);
};

/** The tab ids protected for everyone on this board: those listed (and the tabs inside them), and under "own" every tab not made through the chat. */
export function protectedTabIds(config: Pick<BoardConfig, "tabs">, board: string, facts: TabFacts, rules: TabRules): string[] {
  const tabs = config.tabs ?? [];
  const listed = new Set((rules.protected[board] ?? []).flatMap((id) => tabAndInside(tabs, id)));
  return tabs.filter((t) => listed.has(t.id) || (rules.editable === "own" && !facts.made[t.id])).map((t) => t.id);
}

/** The most widgets the chat may leave on one tab of this board. */
export function widgetLimit(config: BoardConfig, facts: TabFacts, rules: TabRules): number {
  if (rules.maxWidgetsPerTab !== "auto") return rules.maxWidgetsPerTab;
  let most = 0;
  for (const [tab, widgets] of widgetsByTab(config)) if (!facts.made[tab]) most = Math.max(most, widgets.length);
  return Math.max(MIN_AUTO_WIDGETS, Math.ceil(1.5 * most));
}

/** The tabs made through the chat that are on this board, and those of them this person made. */
export function chatTabs(config: Pick<BoardConfig, "tabs">, facts: TabFacts, who?: Pick<TabActor, "user" | "userId">): { all: TabDef[]; mine: TabDef[] } {
  const all = (config.tabs ?? []).filter((t) => facts.made[t.id]);
  return { all, mine: who ? all.filter((t) => madeBy(facts.made[t.id], who)) : [] };
}

const quote = (s: string) => `“${s}”`;

/**
 * Whether this person may make one more tab on this board through the chat: the switches, then the limits. The
 * refusal says the limit and how to free one.
 */
export function mayAddTab(who: TabActor, config: BoardConfig, facts: TabFacts, rules: TabRules): TabVerdict {
  if (!mayMakeTabs(who, rules)) return no("no-tabs-right", who.edits ? "Making tabs through the chat is turned off on this deployment, so no tab was made. An admin can turn it on (the chat tabs switch)." : "You can view this dashboard but not edit it, so the chat can't make a tab on it for you.");
  if (!config.tabs?.length) return no("no-tabs-right", "This dashboard has no tabs, and making the first one would move everything on it into that tab, so the assistant doesn't add tabs here.");
  const { all, mine } = chatTabs(config, facts, who);
  if (mine.length >= rules.maxPerUser)
    return no("tab-limit", `You already have ${mine.length} tab${mine.length === 1 ? "" : "s"} made through the chat on this dashboard (${mine.map((t) => quote(t.title)).join(", ")}), the most one person may have here (${rules.maxPerUser}). Delete one of them first (say “delete the tab …”), then ask again.`);
  if (all.length >= rules.maxPerDashboard)
    return no("tab-limit", `This dashboard already has ${all.length} tabs made through the chat, the most it may have (${rules.maxPerDashboard}). One has to be deleted first: its maker can delete it through the chat, and an admin can delete any of them.`);
  return { ok: true, made: [] };
}

type Right = { ok: true } | { ok: false; code: TabRefusal; why: string };
const YES: Right = { ok: true };

/**
 * What this person may do to one tab through the chat: change it (its title, place and contents) and remove it. A
 * protected tab (listed, inside a listed one, or under "own" any tab not made through the chat) nobody changes,
 * admins included. A tab made through the chat is its maker's, and an admin's. Any other tab: whoever may edit the
 * dashboard changes it; only admins remove it.
 */
export function tabRights(who: TabActor, tabId: string, tabs: readonly TabDef[], board: string, facts: TabFacts, rules: TabRules): { change: Right; remove: Right } {
  const title = quote(tabPath(tabs, tabId));
  const listed = new Set(rules.protected[board] ?? []);
  if (tabAndAbove(tabs, tabId).some((t) => listed.has(t))) {
    const r: Right = { ok: false, code: "protected-tab", why: `The tab ${title} is protected on this deployment, so the chat doesn't change it.` };
    return { change: r, remove: r };
  }
  const maker = facts.made[tabId];
  if (maker) {
    if (madeBy(maker, who) || who.admin) return { change: YES, remove: YES };
    const r: Right = { ok: false, code: "not-your-tab", why: `The tab ${title} was made through the chat by ${maker.user}, so only they and admins change it through the chat.` };
    return { change: r, remove: r };
  }
  if (rules.editable === "own") {
    const r: Right = { ok: false, code: "protected-tab", why: `On this deployment the chat changes only tabs made through it, so the tab ${title} stays as it is.` };
    return { change: r, remove: r };
  }
  if (!who.edits) {
    const r: Right = { ok: false, code: "view-only", why: `You can view this dashboard but not edit it, so the chat changes only tabs of your own here, not ${title}.` };
    return { change: r, remove: r };
  }
  return { change: YES, remove: who.admin ? YES : { ok: false, code: "not-your-tab", why: `Only admins delete a tab that wasn't made through the chat, so ${title} stays.` } };
}

const canon = (v: unknown) => JSON.stringify(v ?? null);
const ownWidth = (l: { w: number; fw?: number }) => (l.fw !== undefined && l.fw < l.w ? l.fw : l.w);

/**
 * Whether the write from `before` to `after` keeps to the deployment's tab rules for this person, or why not. With no
 * rule in force on the board (tabRulesInForce), every write passes. `made` in a pass lists the tabs this write makes
 * through the chat (new ids with CHAT_TAB_PREFIX): the host records this person as their maker.
 *
 * What a write changes, tab by tab: a tab added, removed, renamed or moved among its set; a widget added, removed,
 * changed, resized or moved between tabs (both tabs); a filter added or removed (every tab it reaches), changed (the
 * tabs it reaches; for a change to which widgets it applies to, only the widgets that join or leave it). The board's
 * title, its grid and widgets on no tab change the whole board: only people who may edit it, and only under "all".
 */
export function checkTabChange(who: TabActor, before: BoardConfig, after: BoardConfig, board: string, facts: TabFacts, rules: TabRules): TabVerdict {
  if (!tabRulesInForce(rules, board)) return { ok: true, made: [] };
  const tabsBefore = before.tabs ?? [];
  const tabsAfter = after.tabs ?? [];
  // Every tab either side knows, for titles and nesting.
  const tabs = [...tabsBefore, ...tabsAfter.filter((t) => !tabsBefore.some((b) => b.id === t.id))];
  const had = new Set(tabsBefore.map((t) => t.id));
  const has = new Set(tabsAfter.map((t) => t.id));
  // Tabs this write makes through the chat: this person's from here on.
  const made = tabsAfter.filter((t) => !had.has(t.id) && !facts.made[t.id] && t.id.startsWith(CHAT_TAB_PREFIX)).map((t) => t.id);
  const madeFacts: TabFacts = made.length ? { made: { ...facts.made, ...Object.fromEntries(made.map((id) => [id, { user: who.user, ...(who.userId !== undefined ? { userId: who.userId } : {}) }])) } } : facts;

  const changed = new Set<string>();
  const removed = new Set<string>();
  let whole: string | null = null;
  const wholeBoard = (what: string) => void (whole ??= what);

  // The tabs themselves.
  for (const id of had) if (!has.has(id)) for (const t of tabAndInside(tabsBefore, id)) removed.add(t);
  for (const t of tabsAfter) {
    const b = tabsBefore.find((x) => x.id === t.id);
    if (!b) {
      if (!made.includes(t.id)) changed.add(t.id); // brought back (a restore), or a host's tab: a change to it
      continue;
    }
    // Its place among the tabs of its set that are there before and after: a tab made or removed beside it doesn't move it.
    const at = (list: readonly TabDef[], x: TabDef) => list.filter((y) => y.parent === x.parent && had.has(y.id) && has.has(y.id)).findIndex((y) => y.id === x.id);
    if (b.title !== t.title || b.parent !== t.parent || at(tabsBefore, b) !== at(tabsAfter, t)) changed.add(t.id);
  }

  // Widgets.
  const itemsBefore = new Map(before.layout.filter((l) => before.widgets[l.i]).map((l) => [l.i, l]));
  const itemsAfter = new Map(after.layout.filter((l) => after.widgets[l.i]).map((l) => [l.i, l]));
  const tabOf = (id: string) => itemsAfter.get(id)?.tab ?? itemsBefore.get(id)?.tab;
  const touch = (tab: string | undefined, what: string) => {
    if (tab === undefined) wholeBoard(what);
    else if (!removed.has(tab)) changed.add(tab);
  };
  for (const id of new Set([...Object.keys(before.widgets), ...Object.keys(after.widgets)])) {
    const a = itemsBefore.get(id);
    const b = itemsAfter.get(id);
    const differs = !a || !b || canon(before.widgets[id]) !== canon(after.widgets[id]) || ownWidth(a) !== ownWidth(b) || a.h !== b.h || a.tab !== b.tab;
    if (!differs) continue;
    const name = `“${(after.widgets[id] ?? before.widgets[id])?.title ?? id}”`;
    if (a) touch(a.tab, `${name} is on no tab`);
    if (b && b.tab !== a?.tab) touch(b.tab, `${name} would be on no tab`);
  }

  // Filters, by what they reach.
  const targets = (config: BoardConfig, applies: readonly string[]) => (applies.includes("*") ? Object.keys(config.widgets) : applies.filter((w) => config.widgets[w]));
  const fb = new Map(before.filters.map((f) => [f.id, f]));
  const fa = new Map(after.filters.map((f) => [f.id, f]));
  for (const id of new Set([...fb.keys(), ...fa.keys()])) {
    const x = fb.get(id);
    const y = fa.get(id);
    if (canon(x) === canon(y)) continue;
    const reachBefore = x ? targets(before, x.applies) : [];
    const reachAfter = y ? targets(after, y.applies) : [];
    const rest = (f: typeof x) => (f ? canon({ ...f, applies: undefined }) : "");
    // Only which widgets it applies to changed: the widgets that joined or left it. Else everything it reaches.
    const reach = x && y && rest(x) === rest(y) ? [...reachBefore.filter((w) => !reachAfter.includes(w)), ...reachAfter.filter((w) => !reachBefore.includes(w))] : [...new Set([...reachBefore, ...reachAfter])];
    // A widget removed with this write takes itself out of the filters on it: that changes only its own tab.
    const label = (y ?? x)!.label || (y ?? x)!.field;
    if (!reach.length && (x?.applies.includes("*") || y?.applies.includes("*"))) wholeBoard(`the filter “${label}” is on the whole dashboard`);
    for (const w of reach) touch(tabOf(w), `the filter “${label}” reaches widgets on no tab`);
  }

  if (before.title !== after.title) wholeBoard("the dashboard's title");
  if (canon(before.grid) !== canon(after.grid)) wholeBoard("how the whole dashboard is laid out");

  // A write that changes nothing about tabs, on a board without tabs: nothing more to say, unless the person may only view it.
  if (!tabs.length) return who.edits ? { ok: true, made: [] } : no("view-only", "You can view this dashboard but not edit it, and it has no tabs to have one of your own on, so nothing was changed.");

  // Whole-board changes: editors, under "all", with no tab protected from them on it.
  if (whole) {
    if (!who.edits) return no("view-only", `You can view this dashboard but not edit it, so the chat changes only tabs of your own here, and that would change the whole dashboard (${whole}).`);
    if (rules.editable === "own") return no("whole-board", `On this deployment the chat changes only tabs made through it, and that would change the whole dashboard (${whole}), so nothing was changed.`);
  }

  // New tabs: the right to make them, and the limits.
  if (made.length) {
    if (!mayMakeTabs(who, rules)) return no("no-tabs-right", who.edits ? "Making tabs through the chat is turned off on this deployment, so no tab was made." : "You can view this dashboard but not edit it, so the chat can't make a tab on it for you.");
    if (namedTabs(who, rules)) for (const id of made) if (!keepsName(who.user, tabsAfter.find((t) => t.id === id)!.title)) return no("no-tabs-right", `A tab you make here is named after you, so it starts with “${who.user}”.`);
  }
  const countsBefore = chatTabs(before, facts, who);
  const countsAfter = chatTabs(after, madeFacts, who);
  if (countsAfter.mine.length > countsBefore.mine.length && countsAfter.mine.length > rules.maxPerUser)
    return no("tab-limit", `That would give you ${countsAfter.mine.length} tabs made through the chat on this dashboard, more than one person may have here (${rules.maxPerUser}). Delete one of yours first (${countsBefore.mine.map((t) => quote(t.title)).join(", ") || "none yet"}), then ask again.`);
  if (countsAfter.all.length > countsBefore.all.length && countsAfter.all.length > rules.maxPerDashboard)
    return no("tab-limit", `That would give this dashboard ${countsAfter.all.length} tabs made through the chat, more than it may have (${rules.maxPerDashboard}). One has to be deleted first: its maker can delete it through the chat, and an admin can delete any of them.`);

  // Each tab the write changes or removes.
  for (const id of removed) {
    const r = tabRights(who, id, tabs, board, madeFacts, rules).remove;
    if (!r.ok) return no(r.code, r.why);
  }
  for (const id of changed) {
    if (made.includes(id)) continue;
    const r = tabRights(who, id, tabs, board, madeFacts, rules).change;
    if (!r.ok) return no(r.code, r.why);
  }

  // Widgets per tab: a tab that gains widgets may not end over the limit.
  const limit = widgetLimit(before, facts, rules);
  const nowOn = widgetsByTab(after);
  const wasOn = widgetsByTab(before);
  for (const id of new Set([...changed, ...made])) {
    const n = nowOn.get(id)?.length ?? 0;
    if (n > (wasOn.get(id)?.length ?? 0) && n > limit) return no("widget-limit", `The tab ${quote(tabPath(tabs, id))} would have ${n} widgets, more than the chat may put on one tab here (${limit}). Remove one from it first, or put this on another tab.`);
  }
  return { ok: true, made };
}

/** The tab rules from config (`tabs:`) and environment (LENSPACK_TABS_* and friends, which win), checked. The switches (create, playground) are features, set by the host. */
export function tabRulesFrom(config: unknown, env: Record<string, string | undefined> = {}): Omit<TabRules, "create" | "playground"> {
  if (config !== undefined && config !== null && (typeof config !== "object" || Array.isArray(config))) throw new Error("tabs must be a map, like tabs: { editable: own }");
  const c = (config ?? {}) as Record<string, unknown>;
  const known = ["editable", "protected", "maxPerDashboard", "maxPerUser", "maxWidgetsPerTab"];
  for (const k of Object.keys(c)) if (!known.includes(k)) throw new Error(`tabs.${k} is not a setting (tabs takes ${known.join(", ")})`);
  const given = (envName: string, key: string) => (env[envName] !== undefined && env[envName] !== "" ? { v: env[envName], where: envName } : { v: c[key], where: `tabs.${key}` });
  const e = given("LENSPACK_TABS_EDITABLE", "editable");
  const mode = String(e.v ?? "").trim().toLowerCase();
  if (mode !== "" && !(TAB_MODES as readonly string[]).includes(mode)) throw new Error(`${e.where} must be "all" or "own", not "${String(e.v)}"`);
  const int = (envName: string, key: string, fallback: number, min: number) => {
    const { v, where } = given(envName, key);
    if (v === undefined || v === null || v === "") return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > 1000) throw new Error(`${where} must be a whole number from ${min} to 1000, not "${String(v)}"`);
    return n;
  };
  const w = given("LENSPACK_MAX_WIDGETS_PER_TAB", "maxWidgetsPerTab");
  const widgets = w.v === undefined || w.v === null || w.v === "" || String(w.v).trim().toLowerCase() === "auto" ? ("auto" as const) : int("LENSPACK_MAX_WIDGETS_PER_TAB", "maxWidgetsPerTab", 0, 1);
  const p = given("LENSPACK_PROTECTED_TABS", "protected");
  return {
    editable: (mode || TAB_DEFAULTS.editable) as TabMode,
    protected: protectedFrom(p.v, p.where),
    maxPerDashboard: int("LENSPACK_MAX_TABS_PER_DASHBOARD", "maxPerDashboard", TAB_DEFAULTS.maxPerDashboard, 0),
    maxPerUser: int("LENSPACK_MAX_TABS_PER_USER", "maxPerUser", TAB_DEFAULTS.maxPerUser, 0),
    maxWidgetsPerTab: widgets,
  };
}

/**
 * Protected tabs by dashboard: a map { "12": [TAB-a, TAB-b] } (an entry may be { id, title }; the title is a label), or
 * in the environment JSON, or "12=TAB-a|TAB-b;13=TAB-c". Keys are the host's dashboard ids, as given.
 */
export function protectedFrom(v: unknown, where = "tabs.protected"): Record<string, string[]> {
  if (v === undefined || v === null || v === "") return {};
  let map: unknown = v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("{")) map = JSON.parse(s);
    else
      map = Object.fromEntries(
        s
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const m = /^([^=\s]+)\s*=\s*(.*)$/.exec(part);
            if (!m) throw new Error(`${where}: can't read "${part}" (write 12=TAB-abc|TAB-def;13=TAB-ghi)`);
            return [m[1]!, m[2]!.split(/[|,]/).map((t) => t.trim()).filter(Boolean)];
          }),
      );
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error(`${where} must be a map of dashboard id to tab ids, like { "12": [TAB-abc] }`);
  const out: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(map as Record<string, unknown>)) {
    if (!Array.isArray(list)) throw new Error(`${where}.${k} must be a list of tab ids`);
    out[k] = list.map((x) => {
      const id = typeof x === "string" ? x : x && typeof x === "object" ? (x as { id?: unknown }).id : undefined;
      if (typeof id !== "string" || !/^TAB-[A-Za-z0-9_-]{1,60}$/.test(id)) throw new Error(`${where}.${k}: "${typeof x === "string" ? x : JSON.stringify(x)}" is not a tab id (they look like TAB-abc123)`);
      return id;
    });
  }
  return out;
}
