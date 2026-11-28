import { randomBytes } from "node:crypto";

import type { BoardConfig, RecordStore } from "@lenspack/core";
import { CHAT_TAB_PREFIX, type TabActor, type TabFacts, type TabRules, chatTabs, checkTabChange, keepsName, mayAddTab, mayMakeTabs, namedTabs, playgroundTitle, protectedFrom, protectedTabIds, tabRulesFrom, tabRulesInForce, widgetLimit } from "@lenspack/policy";

import type { SupersetClient } from "./client";

// Tabs on Superset dashboards, the host's part: who made which tab through the chat (a small record in the state
// directory, behind RecordStore), the deployment's tab rules from superset.yaml, the environment and the settings
// page, email reports sent from a tab, and the TabPort the chat's tools ask. Every decision is policy's
// (kernel/policy tabs.ts); this file reads the facts and passes them on.

/** One tab made through the chat: kept after the tab is deleted, so Undo brings back its maker too. */
export type TabRecord = { board: string; tab: string; title: string; user: string; userId?: number; playground?: boolean; at: string };

/** superset.yaml's tabs: section (docs/features/tabs.md). Protected tabs are keyed by dashboard id, as in `dashboards:`. */
export type TabsConfig = { editable?: "all" | "own"; protected?: Record<string, (string | { id: string; title?: string })[]>; maxPerDashboard?: number; maxPerUser?: number; maxWidgetsPerTab?: "auto" | number };

/** What an admin set on the settings page (settings section "tabs"): each key wins over the config's. */
export type TabsSaved = { editable?: "all" | "own"; protected?: Record<string, string[]>; maxPerDashboard?: number; maxPerUser?: number; maxWidgetsPerTab?: "auto" | number };

const recordId = (board: string, tab: string) => `${board}|${tab}`;

export type SupersetTabsOptions = {
  records: RecordStore<TabRecord>;
  /** The rules from the config and environment, checked at start. */
  configured: Omit<TabRules, "create" | "playground">;
  /** What an admin saved (settings section "tabs"), read on every request. */
  saved: () => TabsSaved;
  /** The switches, read on every request: chatTabs and playground. */
  switches: () => { create: boolean; playground: boolean };
  client: SupersetClient;
  /** The dashboard behind a board, when it is one. */
  dashboardOf: (board: string) => number | undefined;
  log?: (line: string) => void;
};

export function supersetTabs(o: SupersetTabsOptions) {
  /** The rules in force now, protected tabs keyed by board id (superset-<n>). */
  const rules = (): TabRules => {
    const s = o.saved();
    const byDashboard = s.protected ?? o.configured.protected;
    return {
      editable: s.editable ?? o.configured.editable,
      protected: Object.fromEntries(Object.entries(byDashboard).map(([d, ids]) => [/^\d+$/.test(d) ? `superset-${d}` : d, ids])),
      maxPerDashboard: s.maxPerDashboard ?? o.configured.maxPerDashboard,
      maxPerUser: s.maxPerUser ?? o.configured.maxPerUser,
      maxWidgetsPerTab: s.maxWidgetsPerTab ?? o.configured.maxWidgetsPerTab,
      ...o.switches(),
    };
  };

  const facts = async (board: string): Promise<TabFacts> => {
    const made: TabFacts["made"] = {};
    for (const r of await o.records.list()) if (r.board === board) (made as Record<string, unknown>)[r.tab] = { user: r.user, ...(r.userId !== undefined ? { userId: r.userId } : {}), ...(r.playground ? { playground: true } : {}) };
    return { made };
  };

  /** Policy's verdict on a write by this person; a pass records them as the maker of each tab it makes. */
  async function check(who: TabActor, board: string, before: BoardConfig, after: BoardConfig): Promise<string | null> {
    const r = rules();
    if (!tabRulesInForce(r, board)) return null;
    const v = checkTabChange(who, before, after, board, await facts(board), r);
    if (!v.ok) return v.why;
    for (const tab of v.made) {
      const title = after.tabs?.find((t) => t.id === tab)?.title ?? tab;
      const userId = who.userId === undefined || who.userId === null ? undefined : Number(who.userId);
      await o.records.put(recordId(board, tab), { board, tab, title, user: who.user, ...(userId !== undefined && Number.isSafeInteger(userId) ? { userId } : {}), ...(who.edits ? {} : { playground: true }), at: new Date().toISOString() });
      o.log?.(`${board}: tab ${tab} (“${title}”) made through the chat by ${who.user}`);
    }
    return null;
  }

  /** The tabs nobody changes through Lenspack on this board, for the last check before saving. */
  const protectedFor = async (board: string, before: BoardConfig) => {
    const r = rules();
    return tabRulesInForce(r, board) ? protectedTabIds(before, board, await facts(board), r) : [];
  };

  /** What the chat's tools ask for this person on this board. */
  async function port(who: TabActor, board: string) {
    const r = rules();
    if (!tabRulesInForce(r, board)) return undefined;
    const named = namedTabs(who, r);
    const titleFor = (words: string, taken: readonly string[], current?: string) => {
      if (!named) return words.trim().slice(0, 80);
      // On the playground a title keeps the person's name: a rename that drops it puts it back in front.
      if (current !== undefined && keepsName(who.user, words)) return words.trim().slice(0, 80);
      return playgroundTitle(who.user, words, taken);
    };
    return {
      canMake: mayMakeTabs(who, r),
      named,
      playground: !who.edits && r.playground,
      check: (before: BoardConfig, after: BoardConfig) => check(who, board, before, after),
      mayAdd: async (config: BoardConfig) => {
        const v = mayAddTab(who, config, await facts(board), rules());
        return v.ok ? null : v.why;
      },
      newTabId: () => `${CHAT_TAB_PREFIX}${randomBytes(6).toString("base64url")}`,
      titleFor,
      reportsOn: (tab: string) => reportsOnTab(o.client, o.dashboardOf(board), tab),
      describe: async (config: BoardConfig) => describeRules(who, config, board, await facts(board), rules()),
    };
  }

  /** The chat-made tabs on each board, now: for the admin list. */
  async function list(boards: Record<string, BoardConfig | null>) {
    const all = await o.records.list();
    return Object.entries(boards).flatMap(([board, config]) =>
      config?.tabs
        ? all
            .filter((r) => r.board === board && config.tabs!.some((t) => t.id === r.tab))
            .map((r) => {
              const t = config.tabs!.find((x) => x.id === r.tab)!;
              return { board, dashboard: o.dashboardOf(board) ?? null, tab: r.tab, title: t.title, user: r.user, userId: r.userId ?? null, playground: !!r.playground, at: r.at, widgets: config.layout.filter((l) => l.tab === r.tab && config.widgets[l.i]).length };
            })
        : [],
    );
  }

  /**
   * Each board's tabs for the settings page: every tab with its title and parent, whether an admin protected it (or
   * the tab above it), whether it is protected because only chat-made tabs may change, who made it through the chat,
   * and how many widgets sit on it; with the board's counts against the limits and the widget limit in force.
   */
  async function overview(boards: Record<string, { title?: string; config: BoardConfig | null }>) {
    const r = rules();
    return Promise.all(
      Object.entries(boards).map(async ([board, { title, config }]) => {
        const tabs = config?.tabs ?? [];
        const f = await facts(board);
        const listed = new Set((r.protected[board] ?? []).filter((id) => tabs.some((t) => t.id === id)));
        const guarded = new Set(config ? protectedTabIds(config, board, f, { ...r, editable: "all" }) : []);
        const byUser: Record<string, number> = {};
        const rows = tabs.map((t) => {
          const maker = f.made[t.id];
          if (maker) byUser[maker.user] = (byUser[maker.user] ?? 0) + 1;
          return {
            id: t.id,
            title: t.title,
            parent: t.parent ?? null,
            protected: listed.has(t.id),
            inherited: !listed.has(t.id) && guarded.has(t.id),
            ownOnly: r.editable === "own" && !maker,
            chat: maker ? { user: maker.user, playground: !!(maker as { playground?: boolean }).playground } : null,
            widgets: config!.layout.filter((l) => l.tab === t.id && config!.widgets[l.i]).length,
          };
        });
        // Protected ids this board no longer has (deleted or made again in Superset): shown so they can be dropped.
        const missing = (r.protected[board] ?? []).filter((id) => !tabs.some((t) => t.id === id));
        return {
          board,
          dashboard: o.dashboardOf(board) ?? null,
          title: title ?? config?.title ?? board,
          tabs: rows,
          missing,
          chatTabs: rows.filter((t) => t.chat).length,
          byUser,
          widgetLimit: config && tabs.length ? widgetLimit(config, f, r) : null,
        };
      }),
    );
  }

  return { rules, facts, check, protectedFor, port, list, overview };
}

/** The prompt's lines on the tab rules for this person on this board. */
export function describeRules(who: TabActor, config: BoardConfig, board: string, facts: TabFacts, rules: TabRules): string {
  const tabs = config.tabs ?? [];
  if (!tabs.length) return rules.playground && !who.edits ? "\n\nTABS: this dashboard has no tabs, so this user can't have a tab of their own on it; answer questions as usual." : "";
  const title = (id: string) => `“${tabs.find((t) => t.id === id)?.title ?? id}”`;
  const guarded = protectedTabIds(config, board, facts, rules);
  const { all, mine } = chatTabs(config, facts, who);
  const lines: string[] = [];
  if (rules.editable === "own") lines.push("- The chat changes only tabs made through it; every other tab is protected.");
  if (guarded.length) lines.push(`- Protected (the chat never changes them, nor their charts or the filters that reach them, for anyone, admins too): ${guarded.map(title).join(", ")}.`);
  if (all.length) lines.push(`- Made through the chat: ${all.map((t) => `${title(t.id)} (${mine.includes(t) ? "this user's" : `by ${facts.made[t.id]!.user}`})`).join(", ")}. Only its maker and admins change one.`);
  if (mayMakeTabs(who, rules)) {
    lines.push(`- add_tab makes a tab: this user may have ${rules.maxPerUser} here (has ${mine.length}); the dashboard may have ${rules.maxPerDashboard} made through the chat (has ${all.length}).${namedTabs(who, rules) ? " A tab they make is named after them." : ""}`);
    lines.push("- When asked to change a protected tab or someone else's, say so and offer a tab of their own instead.");
  } else if (guarded.length || all.length) lines.push("- When asked to change a protected tab or someone else's, say so plainly; nothing else is changed.");
  lines.push(`- At most ${widgetLimit(config, facts, rules)} widgets on one tab.`);
  if (!who.edits && rules.playground)
    lines.push(
      "- PLAYGROUND: this user can view this dashboard but not edit it, except tabs of their own. Despite the line above that you cannot change the board, you may make a tab for them (add_tab), add, change and remove widgets on their own tabs only (add_widget with tab: its title), and delete their own tabs (remove_tab). Anything else is refused. Questions about any tab are answered as usual.",
    );
  return `\n\nTAB RULES (this deployment's; they bind the chat):\n${lines.join("\n")}`;
}

/**
 * The email reports and alerts Superset sends from this tab of this dashboard, by name; null when they can't be read.
 * Superset keeps a report's tab in its extra (dashboard.activeTabs, or an anchor), and turns a report off when a save
 * drops its tab.
 */
export async function reportsOnTab(client: SupersetClient, dashboard: number | undefined, tab: string): Promise<string[] | null> {
  if (dashboard === undefined) return [];
  try {
    const q = encodeURIComponent(`(filters:!((col:dashboard_id,opr:eq,value:${dashboard})),page_size:100)`);
    const list = await client.get<{ result: { id: number; name: string }[] }>(`/api/v1/report/?q=${q}`);
    const out: string[] = [];
    for (const r of list.result ?? []) {
      const one = await client.get<{ result: { name: string; active?: boolean; extra?: unknown; extra_json?: unknown } }>(`/api/v1/report/${r.id}`);
      const extra = one.result.extra ?? one.result.extra_json;
      const text = typeof extra === "string" ? extra : JSON.stringify(extra ?? {});
      if (text.includes(`"${tab}"`)) out.push(one.result.name ?? r.name);
    }
    return out;
  } catch (e) {
    // Alerts and reports switched off in Superset (no such route): there are none to stop.
    if ((e as { status?: number }).status === 404) return [];
    return null;
  }
}

/** The tab rules from superset.yaml and the environment, checked; a mistake stops the start. */
export const tabsConfigFrom = (config: unknown, env: Record<string, string | undefined>) => tabRulesFrom(config, env);

/** A settings-page change (PUT /_superset/settings/tabs), checked: the next saved value, or why not. null resets a key to the config's. */
export function tabsSettingsChange(current: TabsSaved, body: Record<string, unknown>): { ok: true; next: TabsSaved } | { ok: false; error: string } {
  const next: TabsSaved = { ...current };
  for (const [k, v] of Object.entries(body)) {
    if (k === "editable") {
      if (v === null) delete next.editable;
      else if (v === "all" || v === "own") next.editable = v;
      else return { ok: false, error: 'editable must be "all" or "own", or null' };
    } else if (k === "protected") {
      if (v === null) delete next.protected;
      else
        try {
          next.protected = protectedFrom(v, "protected");
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
    } else if (k === "maxPerDashboard" || k === "maxPerUser") {
      if (v === null) delete next[k];
      else if (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1000) next[k] = v as number;
      else return { ok: false, error: `${k} must be a whole number from 0 to 1000, or null` };
    } else if (k === "maxWidgetsPerTab") {
      if (v === null) delete next.maxWidgetsPerTab;
      else if (v === "auto") next.maxWidgetsPerTab = "auto";
      else if (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000) next.maxWidgetsPerTab = v as number;
      else return { ok: false, error: 'maxWidgetsPerTab must be "auto" or a whole number from 1 to 1000, or null' };
    } else return { ok: false, error: `unknown setting "${k}" (editable, protected, maxPerDashboard, maxPerUser, maxWidgetsPerTab)` };
  }
  return { ok: true, next };
}

/** The start-up log's line on tabs. */
export function tabsLine(r: TabRules): string {
  const listed = Object.entries(r.protected).filter(([, ids]) => ids.length);
  return `tabs: chat changes ${r.editable === "own" ? "only tabs made through it" : "any tab not protected"}; protected ${listed.length ? listed.map(([b, ids]) => `${b.replace(/^superset-/, "dashboard ")}: ${ids.join(", ")}`).join("; ") : "none"}; chat tabs ${r.create ? "on" : "off"}; playground ${r.playground ? "on" : "off"}; at most ${r.maxPerUser} per person and ${r.maxPerDashboard} per dashboard; widgets per tab ${r.maxWidgetsPerTab === "auto" ? "auto (1.5 × the fullest tab)" : r.maxWidgetsPerTab}`;
}
