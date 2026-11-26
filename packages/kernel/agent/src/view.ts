import type { BoardTab } from "@lenspack/core";

// What the viewer is looking at on the host's page when they ask: part of what a chat turn is
// about, like their filter selections. Sent by the host page with each chat request; only ids
// travel from the page. What an id is called comes from the host's own layout on the server.

/** The viewer's place on the host's page: the tabs they have open, outermost first, as the host's ids. */
export type TurnView = { tabs?: string[] };

const MAX_TABS = 8;
const TAB_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** A host's request field for the viewer's place on the page; anything else is dropped. */
export function viewFrom(v: unknown): TurnView | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const tabs = (v as { tabs?: unknown }).tabs;
  const ids = Array.isArray(tabs) ? tabs.filter((t): t is string => typeof t === "string" && TAB_ID.test(t)).slice(0, MAX_TABS) : [];
  return ids.length ? { tabs: ids } : undefined;
}

/**
 * The board part's section on a layout with tabs: what is on each tab, the tab the viewer is on,
 * and how to put a new widget on a tab. Empty when the board has no tabs.
 */
export function tabsText(tabs: readonly BoardTab[] | undefined, view?: TurnView): string {
  if (!tabs?.length) return "";
  const open = [...(view?.tabs ?? [])].reverse().map((id) => tabs.find((t) => t.id === id)).find(Boolean);
  const lines = tabs.map((t) => `- “${t.title}”: ${t.widgets.length ? t.widgets.join(", ") : "(no widgets)"}`);
  return `\n\nTABS (the board is laid out in tabs; the rows above list every widget, tab after tab):\n${lines.join("\n")}
${open ? `The viewer is on the tab “${open.title}”.` : "Which tab the viewer is on is not known."}
- To put a new widget on a tab, place it after: or below: a widget on that tab. With top or bottom it goes at the top or bottom of ${open ? "the viewer's tab" : "the first tab"}.
- get_board and edit results list rows without tabs: a widget placed after: or below: another is on that widget's tab.
- When you say where a widget is, name its tab.`;
}
