import { applyOps } from "./ops";
import type { BoardConfig, TabDef } from "./schema";
import type { BoardStore } from "./store";

// A board's tabs, when its host lays it out in tabs (BoardConfig.tabs, each widget's layout item naming its tab):
// what is on each, what sits inside what, and a store that asks before every write. Host-neutral: a tab is an opaque
// id with a title. Who may change which tab is policy's (kernel/policy tabs.ts), given to guardedStore as a callback.

/** Said when a tab is asked for on a board with no tabs: making the first one would move everything into it. */
export const NO_TABS_MESSAGE =
  "This dashboard has no tabs, and making the first one would move everything on it into that tab, so the assistant doesn't add tabs here. Add the first tab in Superset (Edit dashboard), or make your own copy to change.";

/** The tabs in the same set as this one (itself included): those with the same parent tab. */
export const tabSiblings = (tabs: readonly TabDef[], id: string): TabDef[] => {
  const tab = tabs.find((t) => t.id === id);
  return tab ? tabs.filter((t) => t.parent === tab.parent) : [];
};

/** This tab and every tab inside it, at any depth. */
export function tabAndInside(tabs: readonly TabDef[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const t of tabs) if (t.parent === out[i] && !out.includes(t.id)) out.push(t.id);
  return out;
}

/** This tab and the tabs it sits in, innermost first. */
export function tabAndAbove(tabs: readonly TabDef[], id: string): string[] {
  const out: string[] = [];
  for (let at: string | undefined = id; at !== undefined && !out.includes(at); at = tabs.find((t) => t.id === at)?.parent) out.push(at);
  return out;
}

/** The widgets directly on each tab (not on a tab inside it), by tab id; every tab is listed, an empty one with none. */
export function widgetsByTab(config: BoardConfig): Map<string, string[]> {
  const out = new Map<string, string[]>((config.tabs ?? []).map((t) => [t.id, []]));
  for (const l of config.layout) if (l.tab !== undefined && config.widgets[l.i]) out.get(l.tab)?.push(l.i);
  return out;
}

/** A tab's title with the tabs around it, outermost first ("Overview › Trend"). */
export const tabPath = (tabs: readonly TabDef[], id: string): string =>
  tabAndAbove(tabs, id)
    .reverse()
    .map((t) => tabs.find((x) => x.id === t)?.title ?? t)
    .join(" › ");

/**
 * Asked before every write to a board: the board as it is, and as the write would leave it. Returns why the write is
 * refused, in words for the person, or null to let it through.
 */
export type WriteCheck = (id: string, before: BoardConfig, after: BoardConfig) => Promise<string | null>;

/** A write the guard refused: its message is the reason, for the person. */
export class RefusedWrite extends Error {}

/**
 * A store that asks `check` before every write to a board (an edit, a replaced config such as an applied layout or a
 * drag, a restore of an earlier version), so no path past the chat's own tools writes what the deployment's rules
 * refuse. A refused edit is a failed patch, with the reason; a refused replace or restore throws it.
 */
export function guardedStore(inner: BoardStore, check: WriteCheck): BoardStore {
  return {
    get: (id) => inner.get(id),
    list: () => inner.list(),
    create: (input) => inner.create(input),
    share: (id, shared) => inner.share(id, shared),
    delete: (id) => inner.delete(id),
    versions: (id) => inner.versions(id),
    ...(inner.admit ? { admit: inner.admit.bind(inner) } : {}),
    ...(inner.tabs ? { tabs: inner.tabs.bind(inner) } : {}),
    async patch(input) {
      const board = await inner.get(input.id);
      if (board) {
        const r = applyOps(board.config, input.ops, input.catalogue);
        // An edit the ops refuse is refused below, in the store's own words.
        if (r.ok) {
          const refused = await check(input.id, board.config, r.config);
          if (refused) return { ok: false, error: refused };
        }
      }
      return inner.patch(input);
    },
    async replaceConfig(input) {
      const board = await inner.get(input.id);
      if (board) {
        const refused = await check(input.id, board.config, input.config);
        if (refused) throw new RefusedWrite(refused);
      }
      return inner.replaceConfig(input);
    },
    async revertTo(id, version) {
      const [board, versions] = await Promise.all([inner.get(id), inner.versions(id)]);
      const target = versions.find((v) => v.version === version);
      if (board && target) {
        const refused = await check(id, board.config, target.config);
        if (refused) throw new RefusedWrite(refused);
      }
      return inner.revertTo(id, version);
    },
  };
}
