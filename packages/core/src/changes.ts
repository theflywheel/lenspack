import type { BoardConfig, LayoutItem } from "./schema";
import type { BoardVersion } from "./store";

// What changed between two versions of a board, in words a person (or a
// model) reads: widgets by their titles, never by ids. Used to tell the chat
// what the user changed by hand since its last turn, and to tell the user the
// same thing in the chat panel.

const title = (config: BoardConfig, id: string) => `“${config.widgets[id]?.title ?? id}”`;
const readingOrder = (layout: LayoutItem[]) => [...layout].sort((a, b) => a.y - b.y || a.x - b.x).map((l) => l.i);

/** The ids in `a` that are not in a longest common subsequence of `a` and `b`: what moved in reading order. */
function outOfOrder(a: string[], b: string[]): Set<string> {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      kept.add(a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return new Set(a.filter((id) => !kept.has(id)));
}

/**
 * The changes from `before` to `after`, one short phrase each ("removed
 * “Sales by month”", "moved “Total”"). Empty when nothing a person would call
 * a change happened. A widget pushed up or down only because another was
 * added, removed or moved is not reported as moved.
 */
export function describeChanges(before: BoardConfig, after: BoardConfig): string[] {
  const out: string[] = [];
  if (before.title !== after.title) out.push(`renamed the board to “${after.title}”`);
  const was = new Map(before.layout.map((l) => [l.i, l]));
  const now = new Map(after.layout.map((l) => [l.i, l]));
  for (const l of after.layout) if (!was.has(l.i) && after.widgets[l.i]) out.push(`added ${title(after, l.i)}`);
  for (const l of before.layout) if (!now.has(l.i) && before.widgets[l.i]) out.push(`removed ${title(before, l.i)}`);
  const common = after.layout.filter((l) => was.has(l.i)).map((l) => l.i);
  const shared = new Set(common);
  const moved = outOfOrder(
    readingOrder(after.layout).filter((i) => shared.has(i)),
    readingOrder(before.layout).filter((i) => shared.has(i)),
  );
  for (const id of common) {
    const a = was.get(id)!;
    const b = now.get(id)!;
    const resized = a.w !== b.w || a.h !== b.h;
    // Only a reading-order change, or a sideways step within the same row, counts as a move.
    const isMoved = moved.has(id) || (a.y === b.y && a.x !== b.x && !resized);
    const wa = before.widgets[id];
    const wb = after.widgets[id];
    if (wa && wb && wa.title !== wb.title) out.push(`renamed “${wa.title}” to “${wb.title}”`);
    else if (wa && wb && JSON.stringify(wa) !== JSON.stringify(wb)) out.push(`changed ${title(after, id)}`);
    if (isMoved && resized) out.push(`moved and resized ${title(after, id)}`);
    else if (isMoved) out.push(`moved ${title(after, id)}`);
    else if (resized) out.push(`resized ${title(after, id)}`);
  }
  const filters = (c: BoardConfig) => new Map(c.filters.map((f) => [f.id, f.label]));
  const fa = filters(before);
  const fb = filters(after);
  for (const [id, label] of fb) if (!fa.has(id)) out.push(`added the filter “${label}”`);
  for (const [id, label] of fa) if (!fb.has(id)) out.push(`removed the filter “${label}”`);
  if (before.grid.density !== after.grid.density) out.push(`made the board ${after.grid.density}`);
  if (before.grid.fill !== after.grid.fill) out.push(after.grid.fill ? "packed the board" : "unpacked the board");
  return out;
}

/** One edit since a point in the version log, as words. */
export type BoardChange = { version: number; source: string; text: string };

// A layout save without a summary of its own is recorded as this; the diff says more.
const DEFAULT_LAYOUT_SUMMARY = "layout changed";

/**
 * The edits made after version `since` by anything but the chat: dragging,
 * the × on a widget, a rollback, the ops box. Oldest first. Each is described
 * from the version log itself: the change from the version before it, or the
 * summary it was saved with when that says more (a drag names its widget).
 */
export function changesSince(versions: BoardVersion[], since: number): BoardChange[] {
  const byVersion = new Map(versions.map((v) => [v.version, v]));
  return versions
    .filter((v) => v.version > since && v.source !== "chat")
    .sort((a, b) => a.version - b.version)
    .map((v) => {
      const prev = byVersion.get(v.version - 1);
      const diff = prev ? describeChanges(prev.config, v.config) : [];
      const own = v.summary && v.summary !== DEFAULT_LAYOUT_SUMMARY ? v.summary : "";
      const text =
        v.source === "layout" && own ? own
        : v.source === "revert" ? [own, diff.length ? `(${diff.join(", ")})` : ""].filter(Boolean).join(" ")
        : diff.join(", ") || own || "changed the board";
      return { version: v.version, source: v.source, text };
    });
}

/** "a", "a and b", "a, b and c". */
export const listInWords = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
