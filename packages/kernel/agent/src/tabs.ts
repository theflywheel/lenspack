import { z } from "zod";

import { type BoardConfig, type BoardOp, type BoardStore, nearest, tabAndInside, tabPath, widgetsByTab } from "@lenspack/core";

import { bool, str } from "./args";
import { type Tool, defineTool } from "./tools";
import type { TurnView } from "./view";

// The chat's tab tools: make, rename and delete tabs on a board its host lays out in tabs. Each is an ordinary board
// edit (a version, undone like any other, held for the reviewer, in the audit log). Who may do what is the host's
// TabPort, which asks policy (kernel/policy tabs.ts); the edit queue asks it again before every edit is queued.

/** What the host says about tabs for this turn: who may make them, and the check every edit passes. */
export type TabPort = {
  /** This person may have the chat make tabs here (the chatTabs switch for editors, or the playground). */
  canMake: boolean;
  /** A tab this person makes is named after them (the playground's rule). */
  named: boolean;
  /**
   * The person may only view this dashboard, but the playground lets them change tabs of their own: their edits are
   * not refused outright, they go through check(), which refuses anything outside their own tabs.
   */
  playground: boolean;
  /** Policy's verdict on a write from `before` to `after`: why it is refused, or null. A pass records the tabs it makes. */
  check(before: BoardConfig, after: BoardConfig): Promise<string | null>;
  /** Whether one more tab may be made here (switches and limits): why not, or null. */
  mayAdd(config: BoardConfig): Promise<string | null>;
  /** A new tab id. */
  newTabId(): string;
  /** The title a new or renamed tab gets from the words given (on the playground: the person's name first). */
  titleFor(words: string, taken: readonly string[], current?: string): string;
  /** Email reports and alerts sent from this tab, by name; null when they could not be read. */
  reportsOn?(tabId: string): Promise<string[] | null>;
  /** Lines for the prompt: which tabs are protected, whose, the limits. Empty when no tab rule is in force. */
  describe(config: BoardConfig): Promise<string>;
};

/** The tab a person or the model names: by id, by its title, or by its title with the tabs around it. */
export function tabNamed(config: BoardConfig, name: string): { id: string; title: string } {
  const tabs = config.tabs ?? [];
  if (!tabs.length) throw new Error("This board has no tabs");
  const n = name.trim().toLowerCase().replace(/^[“"']|[”"']$/g, "");
  const tests = [(id: string, t: string) => id.toLowerCase() === n, (_: string, t: string) => t.toLowerCase() === n, (id: string) => tabPath(tabs, id).toLowerCase() === n];
  for (const test of tests) {
    const hits = tabs.filter((t) => test(t.id, t.title));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new Error(`Several tabs are called "${name}": ${hits.map((t) => `“${tabPath(tabs, t.id)}” (${t.id})`).join(", ")}; name one by its id`);
  }
  const near = nearest(name, tabs.map((t) => t.title));
  throw new Error(`No tab called "${name}". The board's tabs: ${tabs.map((t) => `“${t.title}”`).join(", ")}${near ? `. Did you mean “${near}”?` : ""}`);
}

/**
 * The tab a new widget goes on when its edit names no anchor: the one asked for, else the tab the viewer has open,
 * else the first tab (where the host draws a chart with no place). Undefined on a board without tabs.
 */
export function tabForNew(config: BoardConfig, asked: string, view?: TurnView): string | undefined {
  const tabs = config.tabs ?? [];
  if (!tabs.length) return undefined;
  if (asked.trim()) return tabNamed(config, asked).id;
  const open = [...(view?.tabs ?? [])].reverse().find((id) => tabs.some((t) => t.id === id));
  return open ?? tabs[0]!.id;
}

export type TabToolsOptions = {
  port: TabPort;
  store: BoardStore;
  boardId: string;
  /** The edit queue of the turn's board tools: ops (or a function giving them) go through the same checks as any edit. */
  edit: (work: () => Promise<BoardOp[] | { applied: boolean; [k: string]: unknown }>) => Promise<unknown>;
};

export function tabTools(o: TabToolsOptions): Tool[] {
  const { port, store, boardId } = o;
  const board = async () => {
    const b = await store.get(boardId);
    if (!b) throw new Error("This board no longer exists");
    return b.config;
  };
  const tools: Tool[] = [];
  if (port.canMake)
    tools.push(
      defineTool({
        name: "add_tab",
        description: `Make a new tab on the board, at the end of its outermost tabs. Then put widgets on it with add_widget (tab: its title).${port.named ? " Its title starts with the user's name; give only the rest (or nothing)." : ""} There is a limit on how many tabs the chat may make: a refusal says it and how to free one.`,
        inputSchema: z.object({ title: str().describe(port.named ? "Optional words after the user's name, e.g. stock trend" : "The new tab's title") }),
        execute: async ({ title }) => {
          let made: { id: string; title: string } | undefined;
          const result = (await o.edit(async () => {
            const config = await board();
            const refused = await port.mayAdd(config);
            if (refused) return { applied: false, error: refused };
            const name = port.titleFor(title, (config.tabs ?? []).map((t) => t.title));
            if (!name) return { applied: false, error: "Give the tab a title" };
            made = { id: port.newTabId(), title: name };
            return [{ op: "add_tab", id: made.id, title: made.title }];
          })) as { applied?: boolean };
          return result.applied && made ? { ...result, tab: made } : result;
        },
      }),
    );
  tools.push(
    defineTool({
      name: "rename_tab",
      description: "Change a tab's title. Name the tab as the board shows it.",
      inputSchema: z.object({ tab: z.string().describe("The tab's title (or id)"), title: z.string().describe("The new title") }),
      execute: ({ tab, title }) =>
        o.edit(async () => {
          const config = await board();
          const t = tabNamed(config, tab);
          const name = port.titleFor(title, (config.tabs ?? []).filter((x) => x.id !== t.id).map((x) => x.title), t.title);
          if (name === t.title) return { applied: false, unchanged: true, error: `The tab is already called “${name}”` };
          return [{ op: "rename_tab", id: t.id, title: name }];
        }),
    }),
    defineTool({
      name: "remove_tab",
      description:
        "Delete a tab with everything on it (its widgets, and tabs inside it). Say what goes with it before you do it. Email reports or alerts sent from a tab stop when it is deleted: when the result asks for confirmation, tell the user which, ask, and call again with confirmed true only after they agree. Undo (restore_version) brings the tab back, not the reports.",
      inputSchema: z.object({ tab: z.string().describe("The tab's title (or id)"), confirmed: bool(false).describe("true only after the user agreed to stop the reports named in the first answer") }),
      execute: async ({ tab, confirmed }) => {
        let gone: string[] = [];
        const result = (await o.edit(async () => {
          const config = await board();
          const t = tabNamed(config, tab);
          const inside = new Set(tabAndInside(config.tabs ?? [], t.id));
          gone = [...widgetsByTab(config)].filter(([id]) => inside.has(id)).flatMap(([, w]) => w.map((id) => config.widgets[id]?.title ?? id));
          if (!confirmed && port.reportsOn) {
            const reports = await port.reportsOn(t.id);
            if (reports === null) return { applied: false, needsConfirmation: true, error: `The email reports on this dashboard could not be checked. Deleting “${t.title}” stops any report or alert sent from it. Ask the user to confirm, then call remove_tab again with confirmed true.` };
            if (reports.length) return { applied: false, needsConfirmation: true, reports, error: `“${t.title}” has email reports or alerts sent from it (${reports.map((r) => `“${r}”`).join(", ")}). Deleting the tab stops them, and Undo does not start them again. Ask the user to confirm, then call remove_tab again with confirmed true.` };
          }
          return [{ op: "remove_tab", id: t.id }];
        })) as { applied?: boolean };
        return result.applied ? { ...result, removedWidgets: gone } : result;
      },
    }),
  );
  return tools;
}
