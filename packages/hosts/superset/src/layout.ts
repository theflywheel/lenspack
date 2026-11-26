// Superset's dashboard layout (position_json) as a tree: reading it from ROOT_ID down, putting
// charts where Superset will draw them, and checking it before it is saved.
//
// The tree: ROOT_ID → GRID_ID → rows, or ROOT_ID → TABS → TAB → rows when the dashboard has
// top-level tabs. TABS can sit inside the grid or inside a tab, to any depth. When someone makes
// top-level tabs, Superset moves the grid's content into the first tab and leaves GRID_ID in the
// layout, empty and no longer under ROOT_ID: anything put there is never drawn. Every component
// lists its ancestors in `parents`. Superset checks none of this when a layout is saved.

export type Component = { id: string; type: string; children: string[]; parents?: string[]; meta?: Record<string, any> };
export type Position = Record<string, Component | string>;

/** Superset's columns per row (GRID_COLUMN_COUNT). */
export const COLUMNS = 12;

export const isComponent = (v: unknown): v is Component => !!v && typeof v === "object" && typeof (v as Component).type === "string" && Array.isArray((v as Component).children ?? []);

/** The component with this id, or undefined. */
export const componentAt = (pos: Position, id: string | undefined): Component | undefined => {
  const c = id === undefined ? undefined : pos[id];
  return isComponent(c) ? c : undefined;
};

/** Which child types each component type may hold (Superset's isValidChild, without its depth limits). */
const VALID_CHILDREN: Record<string, string[]> = {
  ROOT: ["GRID", "TABS"],
  GRID: ["ROW", "TABS", "COLUMN", "HEADER", "DIVIDER", "CHART", "MARKDOWN", "DYNAMIC"],
  TABS: ["TAB"],
  TAB: ["ROW", "TABS", "COLUMN", "HEADER", "DIVIDER", "CHART", "MARKDOWN", "DYNAMIC"],
  ROW: ["CHART", "MARKDOWN", "COLUMN", "DYNAMIC"],
  COLUMN: ["ROW", "TABS", "HEADER", "DIVIDER", "CHART", "MARKDOWN", "DYNAMIC"],
};

/** Each reachable component's parent, walking from ROOT_ID: what Superset draws. A component met twice keeps its first parent. */
export function parentMap(pos: Position): Map<string, string | null> {
  const parent = new Map<string, string | null>();
  const walk = (id: string, from: string | null) => {
    const c = componentAt(pos, id);
    if (!c || parent.has(id)) return;
    parent.set(id, from);
    for (const k of c.children ?? []) walk(k, id);
  };
  walk("ROOT_ID", null);
  return parent;
}

/** The ids Superset draws: everything reachable from ROOT_ID. */
export const reachable = (pos: Position) => new Set(parentMap(pos).keys());

/** Whether the layout has tabs or columns, which a flat grid of rows cannot say. */
export const nestedLayout = (pos: Position) => Object.values(pos).some((c) => isComponent(c) && (c.type === "TABS" || c.type === "TAB" || c.type === "COLUMN"));

/** Whether the layout has tabs. */
export const hasTabs = (pos: Position) => Object.values(pos).some((c) => isComponent(c) && c.type === "TAB");

/** A layout with ROOT_ID and, unless ROOT_ID has tabs instead, GRID_ID under it. */
export function withRoot(given: Position | null | undefined): Position {
  const pos: Position = structuredClone(given ?? {});
  pos.DASHBOARD_VERSION_KEY ??= "v2";
  if (!componentAt(pos, "ROOT_ID")) pos.ROOT_ID = { id: "ROOT_ID", type: "ROOT", children: [] };
  const root = componentAt(pos, "ROOT_ID")!;
  if (!componentAt(pos, "GRID_ID")) pos.GRID_ID = { id: "GRID_ID", type: "GRID", children: [], parents: ["ROOT_ID"] };
  if (!root.children.length) root.children.push("GRID_ID");
  return pos;
}

/**
 * Where Superset draws a chart that is on the dashboard but not in its layout, and so where a new
 * chart goes when nothing says otherwise: the first top-level tab, else the grid
 * (Superset's findFirstParentContainer).
 */
export function defaultContainer(pos: Position): string | null {
  const top = componentAt(pos, componentAt(pos, "ROOT_ID")?.children[0]);
  if (top?.type === "TABS") {
    const first = componentAt(pos, top.children[0]);
    if (first?.type === "TAB") return first.id;
  }
  if (top?.type === "GRID") return top.id;
  return null;
}

/** The innermost of these tab ids that Superset draws: the tab a viewer is on, when their page said. */
export function openTab(pos: Position, tabs: readonly string[] | undefined): string | null {
  if (!tabs?.length) return null;
  const drawn = reachable(pos);
  for (const id of [...tabs].reverse()) if (drawn.has(id) && componentAt(pos, id)?.type === "TAB") return id;
  return null;
}

const ROW_META = { background: "BACKGROUND_TRANSPARENT" };

/** An id not in the layout yet, `<prefix>-<n>`. */
export function freshId(pos: Position, prefix: string): string {
  for (let n = 1; ; n++) if (!(`${prefix}-${n}` in pos)) return `${prefix}-${n}`;
}

/** The ids above a component, ROOT_ID first, from the tree itself (a stored `parents` can be stale); its stored ones when ROOT_ID doesn't reach it. */
function chainAbove(pos: Position, id: string): string[] {
  const parent = parentMap(pos);
  if (!parent.has(id)) return componentAt(pos, id)?.parents ?? [];
  const out: string[] = [];
  for (let p = parent.get(id); p; p = parent.get(p)) out.unshift(p);
  return out;
}

/** Sets `parents` on a component and everything under it from its place in the tree. */
function reparent(pos: Position, id: string, parents: string[]) {
  const c = componentAt(pos, id);
  if (!c) return;
  c.parents = parents;
  for (const k of c.children ?? []) reparent(pos, k, [...parents, id]);
}

/** A new row holding `items` in a grid, tab or column, at `at` (the end when omitted). Returns the row's id. */
export function insertRow(pos: Position, containerId: string, items: Component[], at?: number): string {
  const container = componentAt(pos, containerId);
  if (!container) throw new Error(`no component ${containerId} in the layout`);
  const id = freshId(pos, "ROW-lp");
  pos[id] = { id, type: "ROW", children: [], meta: { ...ROW_META } };
  for (const c of items) {
    pos[c.id] = c;
    (pos[id] as Component).children.push(c.id);
  }
  const index = at === undefined ? container.children.length : Math.max(0, Math.min(at, container.children.length));
  container.children.splice(index, 0, id);
  reparent(pos, id, [...chainAbove(pos, container.id), container.id]);
  return id;
}

/** Puts a component into an existing row at `at` (the end when omitted). */
export function insertInRow(pos: Position, rowId: string, item: Component, at?: number) {
  const row = componentAt(pos, rowId);
  if (!row) throw new Error(`no row ${rowId} in the layout`);
  pos[item.id] = item;
  const index = at === undefined ? row.children.length : Math.max(0, Math.min(at, row.children.length));
  row.children.splice(index, 0, item.id);
  reparent(pos, item.id, [...chainAbove(pos, row.id), row.id]);
}

/** Columns a component takes in its row. */
const widthOf = (pos: Position, id: string) => Math.max(1, Math.min(COLUMNS, Number(componentAt(pos, id)?.meta?.width ?? 4)));

/** Columns a row's children take together. */
export const rowWidth = (pos: Position, rowId: string) => (componentAt(pos, rowId)?.children ?? []).reduce((n, k) => n + widthOf(pos, k), 0);

/**
 * Where a component sits: the row holding it (when its parent is a row), and its block, the
 * ancestor that is a direct child of a grid or a tab, with that container and the block's index in it.
 */
export function locate(pos: Position, id: string): { row?: string; index?: number; container: string; block: string; blockIndex: number } | null {
  const parent = parentMap(pos);
  if (!parent.has(id)) return null;
  const up = parent.get(id) ?? undefined;
  const row = componentAt(pos, up)?.type === "ROW" ? up : undefined;
  let block = id;
  for (;;) {
    const p = parent.get(block);
    if (!p) return null;
    const t = componentAt(pos, p)?.type;
    if (t === "GRID" || t === "TAB") {
      return { ...(row ? { row, index: componentAt(pos, row)!.children.indexOf(id) } : {}), container: p, block, blockIndex: componentAt(pos, p)!.children.indexOf(block) };
    }
    block = p;
  }
}

/** Takes a component out of every children list and out of the layout, with what is under it. */
export function removeComponent(pos: Position, id: string) {
  const c = componentAt(pos, id);
  for (const k of c?.children ?? []) removeComponent(pos, k);
  delete pos[id];
  for (const other of Object.values(pos)) if (isComponent(other) && other.children?.includes(id)) other.children = other.children.filter((k) => k !== id);
}

/** A row wider than Superset's 12 columns, split in order into rows that fit, one after the other in its container. */
export function wrapRow(pos: Position, rowId: string) {
  const row = componentAt(pos, rowId);
  const container = componentAt(pos, parentMap(pos).get(rowId) ?? row?.parents?.at(-1));
  if (!row || !container || rowWidth(pos, rowId) <= COLUMNS) return;
  const lines: string[][] = [[]];
  let used = 0;
  for (const k of row.children) {
    const w = widthOf(pos, k);
    if (used + w > COLUMNS && lines.at(-1)!.length) {
      lines.push([]);
      used = 0;
    }
    lines.at(-1)!.push(k);
    used += w;
  }
  row.children = lines[0]!;
  let at = container.children.indexOf(rowId);
  for (const line of lines.slice(1)) {
    const id = freshId(pos, "ROW-lp");
    pos[id] = { id, type: "ROW", children: line, meta: { ...(row.meta ?? ROW_META) } };
    container.children.splice(++at, 0, id);
    reparent(pos, id, [...chainAbove(pos, container.id), container.id]);
  }
}

/** A tab's title as its strip shows it. */
const tabTitle = (c: Component) => String(c.meta?.text || c.meta?.defaultText || c.id).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || c.id;

/** One tab, in reading order: its titles from the outermost tab in, and the charts and notes in it that are not in a tab inside it. */
export type LayoutTab = { id: string; path: string[]; titles: string[]; components: string[] };

/** Every tab Superset draws, outer before inner, each with what sits directly in it. */
export function tabsOf(pos: Position): LayoutTab[] {
  const out: LayoutTab[] = [];
  // Each component is read once: a layout with a loop is refused by layoutProblems, and only read here.
  const seen = new Set<string>();
  const walk = (id: string, tab: LayoutTab | null, path: string[], titles: string[]) => {
    const c = componentAt(pos, id);
    if (!c || seen.has(id)) return;
    seen.add(id);
    if (c.type === "TAB") {
      const t: LayoutTab = { id, path: [...path, id], titles: [...titles, tabTitle(c)], components: [] };
      out.push(t);
      for (const k of c.children) walk(k, t, t.path, t.titles);
      return;
    }
    if ((c.type === "CHART" || c.type === "MARKDOWN") && tab) tab.components.push(id);
    for (const k of c.children ?? []) walk(k, tab, path, titles);
  };
  walk("ROOT_ID", null, [], []);
  return out;
}

/**
 * Charts the layout does not draw (not in it, or only under a part ROOT_ID does not reach, such as
 * the grid top-level tabs left behind), put in rows where Superset draws such charts: the first
 * top-level tab, else the grid. Three to a row, a third wide each.
 */
export function placeCharts(given: Position | null | undefined, chartIds: readonly number[], o: { prefix?: string } = {}): Position {
  const pos = withRoot(given);
  const drawn = reachable(pos);
  const shown = new Set<number>();
  for (const id of drawn) {
    const c = componentAt(pos, id);
    if (c?.type === "CHART" && typeof c.meta?.chartId === "number") shown.add(c.meta.chartId);
  }
  const missing = [...new Set(chartIds)].filter((id) => !shown.has(id));
  if (!missing.length) return pos;
  // The undrawn copies go: one component per chart, where it can be seen.
  for (const [k, c] of Object.entries(pos)) if (isComponent(c) && c.type === "CHART" && !drawn.has(k) && missing.includes(c.meta?.chartId)) removeComponent(pos, k);
  const target = defaultContainer(pos) ?? "GRID_ID";
  for (let i = 0; i < missing.length; i += 3) {
    const items = missing.slice(i, i + 3).map((chartId) => ({ id: freshId(pos, `CHART-${o.prefix ?? "lp"}-${chartId}`), type: "CHART", children: [], meta: { chartId, width: 4, height: 50 } }));
    insertRow(pos, target, items);
  }
  return pos;
}

/**
 * What is wrong with a layout, one line each; empty when Superset can draw it as it is. Checked:
 * ROOT_ID is a ROOT with one GRID or TABS under it; each component is stored under its own id;
 * every child exists, is listed by one parent only, may sit in that parent, and its `parents` are
 * the chain above it; no loops; every chart is drawn (reachable from ROOT_ID).
 */
export function layoutProblems(pos: Position): string[] {
  const out: string[] = [];
  const root = componentAt(pos, "ROOT_ID");
  if (!root || root.type !== "ROOT") return ["ROOT_ID is missing or is not the root"];
  const top = root.children.map((k) => componentAt(pos, k));
  if (root.children.length !== 1 || !top[0] || (top[0].type !== "GRID" && top[0].type !== "TABS")) out.push("ROOT_ID must hold exactly one GRID or TABS");
  for (const [k, c] of Object.entries(pos)) if (isComponent(c) && c.id !== k) out.push(`${k} is stored under another component's id (${c.id})`);
  const listedBy = new Map<string, string>();
  for (const [k, c] of Object.entries(pos)) {
    if (!isComponent(c)) continue;
    for (const kid of c.children ?? []) {
      if (!componentAt(pos, kid)) out.push(`${k} lists ${kid}, which is not in the layout`);
      else if (listedBy.has(kid) && listedBy.get(kid) !== k) out.push(`${kid} is listed by both ${listedBy.get(kid)} and ${k}`);
      else if (listedBy.has(kid)) out.push(`${k} lists ${kid} twice`);
      else listedBy.set(kid, k);
    }
  }
  const drawn = new Set<string>();
  const walk = (id: string, chain: string[]) => {
    const c = componentAt(pos, id);
    if (!c) return;
    if (chain.includes(id)) return void out.push(`${id} is inside itself`);
    if (drawn.has(id)) return;
    drawn.add(id);
    const above = chain.at(-1);
    if (above) {
      const parent = componentAt(pos, above)!;
      if (!(VALID_CHILDREN[parent.type] ?? []).includes(c.type)) out.push(`${id} (${c.type}) cannot sit in ${above} (${parent.type})`);
      if ((c.parents ?? []).join(">") !== chain.join(">")) out.push(`${id}'s parents are ${JSON.stringify(c.parents ?? [])}, not ${JSON.stringify(chain)}`);
    }
    for (const k of c.children ?? []) walk(k, [...chain, id]);
  };
  walk("ROOT_ID", []);
  for (const [k, c] of Object.entries(pos)) if (isComponent(c) && c.type === "CHART" && !drawn.has(k)) out.push(`${k} (chart ${c.meta?.chartId}) is not under ROOT_ID, so Superset would not show it`);
  return out;
}
