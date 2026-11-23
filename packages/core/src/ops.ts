import { z } from "zod";

import { type Catalogue, dimension as findDimension, entity as findEntity, isRate, measure as findMeasure } from "./catalogue";
import {
  type BoardConfig,
  type LayoutItem,
  type Placement,
  type Query,
  type Widget,
  boardConfigSchema,
  filterSchema,
  placementSchema,
  widgetSchema,
} from "./schema";

// Domain operations rather than JSON Patch. Each one validates against its own
// narrow schema, each one reads as a sentence in an audit log, and none of them
// can express a structurally destructive edit — there is no op that replaces
// the widgets map, so no sequence of valid ops can empty a board by accident.

export const opSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_widget"),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "Widget ids are lowercase letters, digits, dashes and underscores"),
    widget: widgetSchema,
    placement: placementSchema.optional(),
  }),
  z.object({ op: z.literal("update_widget"), id: z.string(), widget: widgetSchema }),
  z.object({ op: z.literal("remove_widget"), id: z.string() }),
  z.object({ op: z.literal("move_widget"), id: z.string(), placement: placementSchema }),
  z.object({
    op: z.literal("resize_widget"),
    id: z.string(),
    width: z.union([z.enum(["full", "half", "third", "quarter"]), z.number().int().min(1).max(12)]),
    height: z.number().int().min(1).max(20).optional(),
  }),
  z.object({ op: z.literal("set_title"), title: z.string().min(1).max(160) }),
  z.object({ op: z.literal("add_filter"), filter: filterSchema }),
  z.object({ op: z.literal("remove_filter"), id: z.string() }),
  // "Make it compact": density and packing, together or separately.
  z.object({
    op: z.literal("set_layout_mode"),
    density: z.enum(["comfortable", "compact"]).optional(),
    fill: z.boolean().optional(),
  }),
]);
export type BoardOp = z.infer<typeof opSchema>;

export type ApplyResult =
  | { ok: true; config: BoardConfig }
  | { ok: false; opIndex: number; error: string; hint?: string };

const WIDTHS: Record<string, number> = { full: 12, half: 6, third: 4, quarter: 3 };

function widthUnits(width: Placement["width"], cols: number) {
  const units = typeof width === "number" ? width : (WIDTHS[width] ?? 6);
  return Math.max(1, Math.min(cols, units));
}

// Suggests what the model probably meant. The retry loop is only cheap because
// the error names the nearest real key, which turns most second attempts into
// successes.
export function nearest(value: string, candidates: string[]) {
  let best: { key: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = editDistance(value.toLowerCase(), candidate.toLowerCase());
    if (!best || distance < best.distance) best = { key: candidate, distance };
  }
  // Beyond roughly half the word, a suggestion is noise rather than help.
  return best && best.distance <= Math.max(2, Math.ceil(value.length / 2)) ? best.key : null;
}

function editDistance(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length]![b.length]!;
}

// First fit, scanning top to bottom for a row with room. Simple enough to
// reason about, and it cannot produce an overlap: a candidate position is only
// accepted when nothing already occupies it.
function place(layout: LayoutItem[], id: string, w: number, h: number, placement: Placement, cols: number, floors?: Map<string, number>): LayoutItem;
function place(layout: LayoutItem[], id: string, w: number, h: number, placement: Placement, cols: number, floors: Map<string, number> | undefined, besideOnly: true): LayoutItem | null;
function place(layout: LayoutItem[], id: string, w: number, h: number, placement: Placement, cols: number, floors?: Map<string, number>, besideOnly = false): LayoutItem | null {
  const others = layout.filter((item) => item.i !== id);
  // On a packed board the last widget of a row was widened to the edge (fw is its own
  // width). That extra is free for placement: otherwise one "top, third" KPI fills the
  // row and the second, asked for in the next call, cannot go beside it, while the same
  // two ops in one batch would make a row.
  // Only a widget of the same height takes that room: three KPIs make a row, while a
  // chart after a lone KPI still starts a row of its own, as it always has.
  const shrinkable = (item: LayoutItem) => item.fw !== undefined && item.fw < item.w && item.h === h;
  const ownWidth = (item: LayoutItem) => (shrinkable(item) ? item.fw! : item.w);
  const occupied = (x: number, y: number, width: number, height: number) =>
    others.some(
      (item) => x < item.x + ownWidth(item) && x + width > item.x && y < item.y + item.h && y + height > item.y,
    );
  const at = (x: number, y: number) => {
    // A widened widget whose extra the new one takes goes back to its own width;
    // packing widens whichever is last on the row afterwards.
    for (const item of others) {
      if (!shrinkable(item)) continue;
      if (x < item.x + item.w && x + w > item.x && y < item.y + item.h && y + h > item.y) {
        item.w = item.fw!;
        delete item.fw;
      }
    }
    return { i: id, x, y, w, h };
  };

  let startY = 0;
  if (placement.place === "top") {
    // "Top" means the top row, not a new row above everything. Three thirds
    // asked for the top belong side by side — pushing the previous one down
    // each time is how "KPIs across the top" became a vertical stack.
    for (let x = 0; x + w <= cols; x++) {
      if (!occupied(x, 0, w, h)) return at(x, 0);
    }
    // Genuinely no room up there, so everything else moves down, and stays below the
    // new row: gravity would otherwise lift a widget into the room beside this one,
    // and the next widget asked for the top row (in this call or the next) finds it taken.
    for (const item of others) {
      item.y += h;
      floors?.set(item.i, (floors.get(item.i) ?? 0) + h);
    }
  } else if (placement.place.startsWith("after:") || placement.place.startsWith("below:")) {
    const below = placement.place.startsWith("below:");
    const anchor = others.find((item) => item.i === placement.place.slice(placement.place.indexOf(":") + 1));
    if (anchor) {
      if (!below) {
        const beside = besideAnchor(others, anchor, w, h, occupied, at, cols);
        if (beside) return beside;
        if (besideOnly) return null;
      }
      return at(0, rowBelow(others, anchor, h, floors));
    }
  } else {
    // "Bottom" means the end of the flow, not a new row every time. Scanning
    // from the last row's top lets two halves pair up, while a full-width
    // widget finds no room beside them and drops to a row of its own.
    startY = others.reduce((max, item) => Math.max(max, item.y), 0);
  }

  for (let y = startY; y < startY + 500; y++) {
    for (let x = 0; x + w <= cols; x++) {
      if (!occupied(x, y, w, h)) return at(x, y);
    }
  }
  return { i: id, x: 0, y: startY, w, h };
}

// Beside the anchor, when its row has room. Room in total but split into gaps (on a board
// that is not packed, narrowing a widget leaves a gap where it was) is joined by sliding the
// row's widgets left first. Null when the row has no room for the width asked.
function besideAnchor(
  others: LayoutItem[],
  anchor: LayoutItem,
  w: number,
  h: number,
  occupied: (x: number, y: number, width: number, height: number) => boolean,
  at: (x: number, y: number) => LayoutItem,
  cols: number,
): LayoutItem | null {
  for (let x = 0; x + w <= cols; x++) {
    if (!occupied(x, anchor.y, w, h)) return at(x, anchor.y);
  }
  const row = others.filter((item) => item.y === anchor.y).sort((a, b) => a.x - b.x);
  const before = row.map((item) => item.x);
  for (const item of row) {
    for (let x = 0; x < item.x; x++) {
      const clash = others.some(
        (o) => o !== item && x < o.x + o.w && x + item.w > o.x && item.y < o.y + o.h && item.y + item.h > o.y,
      );
      if (!clash) {
        item.x = x;
        break;
      }
    }
  }
  for (let x = 0; x + w <= cols; x++) {
    if (!occupied(x, anchor.y, w, h)) return at(x, anchor.y);
  }
  row.forEach((item, k) => (item.x = before[k]!));
  return null;
}

// The top of a new row straight after the anchor's row; everything from there down moves
// down to make it. Scanning on down for the first gap instead found the moved widget's own
// old place whenever every row was full (on a packed board they always are), so "move X
// after Y" put X back where it was.
function rowBelow(others: LayoutItem[], anchor: LayoutItem, h: number, floors?: Map<string, number>) {
  let y = Math.max(...others.filter((item) => item.y === anchor.y).map((item) => item.y + item.h));
  for (;;) {
    const spanning = others.filter((item) => item.y < y && item.y + item.h > y);
    if (spanning.length === 0) break;
    y = Math.max(...spanning.map((item) => item.y + item.h));
  }
  for (const item of others) {
    if (item.y < y) continue;
    item.y += h;
    floors?.set(item.i, Math.max(floors.get(item.i) ?? 0, y + h));
  }
  return y;
}

/** The narrowest a widget may be squeezed to when room is made beside it: a number reads in 2 columns, a chart needs 3. */
export function minWidth(kind: string | undefined) {
  return kind === "kpi" || kind === "text" ? 2 : 3;
}

type RoomMade = { item: LayoutItem; shrunk: { id: string; from: number; to: number }[] } | { error: string; hint: string };

// "Move X after Y" into a full row means beside Y: Y's row makes room by shrinking its
// widgets in proportion to their widths, never below their minimum, and X keeps the width
// asked for when it can. When the row cannot make room it says so and names the choices,
// rather than putting X somewhere nobody asked for.
function makeRoom(
  layout: LayoutItem[],
  id: string,
  w: number,
  h: number,
  anchor: LayoutItem,
  cols: number,
  minOf: (id: string) => number,
): RoomMade {
  const row = layout.filter((item) => item.i !== id && item.y === anchor.y).sort((a, b) => a.x - b.x);
  const names = row.map((item) => `"${item.i}"`).join(", ");
  const full: RoomMade = {
    error: `The row of "${anchor.i}" is full (${row.map((item) => `${item.i} ${item.w}/${cols}`).join(", ")}) and cannot make room for "${id}" without squeezing a widget below its narrowest`,
    hint: `Shrink one of ${names} with resize_widget, move one of them to another row, or put "${id}" on a new row under it with place "below:${anchor.i}"`,
  };
  // A taller widget from a row above reaching into this one: room is not the row's to give.
  if (layout.some((item) => item.i !== id && item.y < anchor.y && item.y + item.h > anchor.y)) return full;
  const own = row.map((item) => (item.fw !== undefined && item.fw < item.w ? item.fw : item.w));
  const mins = row.map((item) => Math.min(minOf(item.i), own[row.indexOf(item)]!));
  const floor = mins.reduce((a, b) => a + b, 0);
  const wanted = Math.min(w, Math.max(Math.min(minOf(id), w), cols - floor));
  if (wanted + floor > cols) return full;
  const widths = shrinkTo(own, mins, cols - wanted);
  const shrunk = row.flatMap((item, k) => (widths[k]! < item.w ? [{ id: item.i, from: item.w, to: widths[k]! }] : []));
  const item: LayoutItem = { i: id, x: 0, y: anchor.y, w: wanted, h };
  const order = [...row];
  order.splice(row.indexOf(anchor) + 1, 0, item);
  let x = 0;
  for (const entry of order) {
    if (entry !== item) {
      entry.w = widths[row.indexOf(entry)]!;
      delete entry.fw;
    }
    entry.x = x;
    x += entry.w;
  }
  return { item, shrunk };
}

// Widths scaled down in proportion to fit `total`, none below its minimum.
function shrinkTo(widths: number[], mins: number[], total: number) {
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum <= total) return [...widths];
  const out = widths.map((w, k) => Math.max(mins[k]!, Math.floor((w * total) / sum)));
  const spare = (k: number) => out[k]! - mins[k]!;
  while (out.reduce((a, b) => a + b, 0) > total) {
    const k = out.map((_, i) => i).filter((i) => spare(i) > 0).sort((a, b) => out[b]! - out[a]!)[0];
    if (k === undefined) break;
    out[k]! -= 1;
  }
  while (out.reduce((a, b) => a + b, 0) < total) {
    const k = out.map((_, i) => i).filter((i) => out[i]! < widths[i]!).sort((a, b) => (widths[b]! - out[b]!) - (widths[a]! - out[a]!))[0];
    if (k === undefined) break;
    out[k]! += 1;
  }
  return out;
}

/**
 * Applies a batch of operations to a draft and commits it whole, or rejects the
 * batch naming the operation that failed. Partial application is never allowed:
 * half of a two-op edit is a board nobody asked for.
 */
export function applyOps(config: BoardConfig, ops: BoardOp[], catalogue: Catalogue): ApplyResult {
  const draft: BoardConfig = JSON.parse(JSON.stringify(config));
  const cols = draft.grid.cols;
  // Widgets pushed down by a "top" placement may not float back above the row it made.
  const floors = new Map<string, number>();
  // Where each moved widget started, to catch a move that leaves it where it was.
  const moved = new Map<string, { index: number; from: LayoutItem }>();
  // Packing widens the last widget of a row to the edge. Within one call it may only do that
  // in a row the call changed (a row a widget joined, left or was made for), and only for a
  // widget alone there, one just added, or one packing had already widened: moving one chart
  // must not stretch its neighbours, and a widget just resized keeps the width asked for.
  const touched = new Set<string>();
  const added = new Set<string>();
  const sized = new Set<string>();
  let repack = false;
  const rowOf = (item: LayoutItem) => draft.layout.filter((other) => other.y === item.y && other.i !== item.i).map((other) => other.i);

  for (const [index, op] of ops.entries()) {
    const fail = (error: string, hint?: string): ApplyResult => ({ ok: false, opIndex: index, error, hint });

    switch (op.op) {
      case "add_widget": {
        if (draft.widgets[op.id]) return fail(`A widget called "${op.id}" already exists`);
        const semantic = checkWidget(op.widget, catalogue);
        if (semantic) return fail(semantic.error, semantic.hint);

        draft.widgets[op.id] = op.widget;
        const placement = placementSchema.parse(op.placement ?? {});
        const w = widthUnits(placement.width, cols);
        const h = placement.height ?? defaultHeight(op.widget.kind === "chart" ? op.widget.chart : op.widget.kind);
        const item = place(draft.layout, op.id, w, h, placement, cols, floors);
        draft.layout.push(item);
        touched.add(op.id);
        added.add(op.id);
        break;
      }

      case "update_widget": {
        if (!draft.widgets[op.id]) return fail(`No widget called "${op.id}"`, nearest(op.id, Object.keys(draft.widgets)) ?? undefined);
        const semantic = checkWidget(op.widget, catalogue);
        if (semantic) return fail(semantic.error, semantic.hint);
        draft.widgets[op.id] = op.widget;
        break;
      }

      case "remove_widget": {
        if (!draft.widgets[op.id]) return fail(`No widget called "${op.id}"`, nearest(op.id, Object.keys(draft.widgets)) ?? undefined);
        delete draft.widgets[op.id];
        const gone = draft.layout.find((item) => item.i === op.id);
        if (gone) for (const id of rowOf(gone)) touched.add(id);
        draft.layout = draft.layout.filter((item) => item.i !== op.id);
        // Removal cascades in the same transaction, so a filter can never be
        // left pointing at something that is gone.
        draft.filters = draft.filters
          .map((filter) => ({ ...filter, applies: filter.applies.filter((target) => target !== op.id) }))
          .filter((filter) => filter.applies.length > 0);
        break;
      }

      case "move_widget": {
        const item = draft.layout.find((entry) => entry.i === op.id);
        if (!item) return fail(`No widget called "${op.id}"`, nearest(op.id, Object.keys(draft.widgets)) ?? undefined);
        const placement = placementSchema.parse(op.placement);
        if (!moved.has(op.id)) moved.set(op.id, { index, from: { ...item } });
        for (const id of rowOf(item)) touched.add(id);
        touched.add(op.id);
        sized.delete(op.id);
        draft.layout = draft.layout.filter((entry) => entry.i !== op.id);
        // A moved widget takes its own width with it, not the room packing gave it.
        const width = item.fw !== undefined && item.fw < item.w ? item.fw : item.w;
        const anchorId = placement.place.startsWith("after:") ? placement.place.slice("after:".length) : null;
        const anchor = anchorId ? draft.layout.find((entry) => entry.i === anchorId) : undefined;
        if (anchorId && !anchor && anchorId !== op.id)
          return fail(`No widget called "${anchorId}" to put "${op.id}" after`, nearest(anchorId, Object.keys(draft.widgets)) ?? undefined);
        // A full-width widget cannot sit beside anything: "after" is then the row under the anchor's.
        if (anchor && width >= cols) {
          draft.layout.push(place(draft.layout, op.id, width, item.h, { ...placement, place: `below:${anchor.i}` }, cols, floors));
          break;
        }
        if (anchor) {
          // Beside the anchor: in room its row has, else in room the row makes.
          const beside = place(draft.layout, op.id, width, item.h, placement, cols, floors, true);
          if (beside) {
            draft.layout.push(beside);
            break;
          }
          const room = makeRoom(draft.layout, op.id, width, item.h, anchor, cols, (id) => minWidth(draft.widgets[id]?.kind));
          if ("error" in room) return fail(room.error, room.hint);
          draft.layout.push(room.item);
          // A taller newcomer covers the top of the next row: that row moves down under it.
          pushDown(draft.layout, room.item);
          break;
        }
        draft.layout.push(place(draft.layout, op.id, width, item.h, placement, cols, floors));
        break;
      }

      case "resize_widget": {
        const item = draft.layout.find((entry) => entry.i === op.id);
        if (!item) return fail(`No widget called "${op.id}"`, nearest(op.id, Object.keys(draft.widgets)) ?? undefined);
        item.w = widthUnits(op.width, cols);
        delete item.fw;
        if (op.height) item.h = op.height;
        for (const id of rowOf(item)) touched.add(id);
        sized.add(op.id);
        // Growing in place can cover a neighbour, and gravity only moves things up, so
        // push whatever it now covers down below it (and whatever that covers, in turn).
        pushDown(draft.layout, item);
        break;
      }

      case "set_title":
        draft.title = op.title;
        break;

      case "add_filter": {
        if (draft.filters.some((filter) => filter.id === op.filter.id))
          return fail(`A filter called "${op.filter.id}" already exists`);
        if (op.filter.type === "daterange" ? op.filter.field !== "time" : !findDimension(catalogue, op.filter.field))
          return fail(op.filter.type === "daterange" ? 'A date range filter sets time; its field is "time"' :
            `"${op.filter.field}" is not a dimension in this pack`,
            nearest(op.filter.field, catalogue.dimensions.map((d) => d.key)) ?? undefined,
          );
        const missing = op.filter.applies.filter((target) => target !== "*" && !draft.widgets[target]);
        if (missing.length > 0) return fail(`Filter targets widgets that do not exist: ${missing.join(", ")}`);
        draft.filters.push(op.filter);
        break;
      }

      case "remove_filter": {
        if (!draft.filters.some((filter) => filter.id === op.id))
          return fail(`No filter called "${op.id}"`, nearest(op.id, draft.filters.map((f) => f.id)) ?? undefined);
        draft.filters = draft.filters.filter((filter) => filter.id !== op.id);
        break;
      }

      case "set_layout_mode": {
        if (op.density) draft.grid.density = op.density;
        if (op.fill !== undefined) draft.grid.fill = op.fill;
        if (op.fill) repack = true;
        break;
      }
    }
  }

  // Layout is normalised last: a widget wider than the grid, or one left
  // hanging past the bottom, is corrected rather than rejected; a packed
  // board also closes its gaps.
  draft.layout = compact(draft.layout, cols, floors);
  if (draft.grid.fill)
    draft.layout = pack(
      draft.layout,
      cols,
      repack
        ? undefined
        : (row, last) => row.some((item) => touched.has(item.i)) && !sized.has(last.i) && (row.length === 1 || added.has(last.i) || last.fw !== undefined),
    );

  // A move that ends where it started is a failure, not a success: reporting "moved" for a
  // board that did not change is how a model tells the user it is done when it is not.
  for (const [id, { index, from }] of moved) {
    const to = draft.layout.find((entry) => entry.i === id);
    if (to && to.x === from.x && to.y === from.y && to.w === from.w && to.h === from.h)
      return {
        ok: false,
        opIndex: index,
        error: `Moving "${id}" there changes nothing: it is already in that position`,
        hint: 'Say where it should go instead: place "top", or "after:<id>" of the widget it should follow.',
      };
  }

  const parsed = boardConfigSchema.safeParse(draft);
  if (!parsed.success) return { ok: false, opIndex: ops.length - 1, error: parsed.error.issues[0]?.message ?? "Invalid config" };
  return { ok: true, config: parsed.data };
}

function defaultHeight(kind: string) {
  return kind === "kpi" ? 3 : kind === "text" ? 3 : kind === "heatmap" ? 9 : 7;
}

// Gravity: everything floats up until it rests on something. The same rule
// react-grid-layout applies on drag, applied here so a config saved by chat and
// one saved by mouse are the same shape.
export function compact(layout: LayoutItem[], cols: number, floors?: Map<string, number>): LayoutItem[] {
  const sorted = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
  const settled: LayoutItem[] = [];

  for (const item of sorted) {
    const next = { ...item, w: Math.min(item.w, cols) };
    if (next.fw !== undefined && next.fw >= next.w) delete next.fw;
    next.x = Math.min(next.x, cols - next.w);
    let y = next.y;
    const floor = floors?.get(item.i) ?? 0;
    while (
      y > floor &&
      !settled.some(
        (other) => next.x < other.x + other.w && next.x + next.w > other.x && y - 1 < other.y + other.h && y - 1 + next.h > other.y,
      )
    ) {
      y -= 1;
    }
    settled.push({ ...next, y });
  }
  return settled;
}

/** Moves everything that overlaps `moved` to just below it, cascading, like a drag in react-grid-layout. */
function pushDown(layout: LayoutItem[], moved: LayoutItem) {
  const queue = [moved];
  while (queue.length) {
    const top = queue.shift()!;
    for (const other of [...layout].sort((a, b) => a.y - b.y)) {
      if (other === top) continue;
      const hit = other.x < top.x + top.w && other.x + other.w > top.x && other.y < top.y + top.h && other.y + other.h > top.y;
      if (hit) {
        other.y = top.y + top.h;
        queue.push(other);
      }
    }
  }
}

/**
 * Packs rows: widgets slide left to close gaps, and the last widget on each
 * row grows to the grid edge, so a quarter-width KPI never leaves three
 * quarters of a row empty. Rows are groups of widgets sharing a top edge;
 * a widget that spans several rows keeps its width and blocks the rows it
 * covers. Applied after gravity, so it never creates an overlap.
 */
export function pack(layout: LayoutItem[], cols: number, widen?: (row: LayoutItem[], last: LayoutItem) => boolean): LayoutItem[] {
  const items = layout.map((l) => ({ ...l })).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = new Map<number, typeof items>();
  for (const item of items) rows.set(item.y, [...(rows.get(item.y) ?? []), item]);

  for (const [y, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    // Columns already taken on this row by taller widgets from rows above.
    const blocked = items.filter((o) => o.y < y && o.y + o.h > y);
    const free = (x: number, w: number) => !blocked.some((o) => x < o.x + o.w && x + w > o.x);
    let cursor = 0;
    for (const item of row) {
      // Slide left to the first free column at or after the cursor.
      let x = cursor;
      while (x + item.w <= cols && !free(x, item.w)) x++;
      if (x + item.w <= cols) item.x = x;
      cursor = item.x + item.w;
    }
    // Widen the last widget of the row up to the next blocked column or the edge.
    const last = row[row.length - 1]!;
    if (widen && !widen(row, last)) continue;
    let edge = cols;
    for (const o of blocked) if (o.x >= last.x + last.w && o.x < edge) edge = o.x;
    if (edge - last.x > last.w) {
      // Remember its own width, so placement can hand the extra to the next widget.
      if (last.fw === undefined) last.fw = last.w;
      last.w = edge - last.x;
    }
  }
  return compact(items, cols);
}

export type Problem = { error: string; hint?: string };

/**
 * Checks that every key a query names exists in the catalogue. This is the
 * dominant failure mode — a model naming a dimension the pack does not have —
 * and it is caught here even when the model ignored the catalogue in context.
 * Join validity and fan-out are the compiler's job; this is purely vocabulary.
 */
export function checkQuery(query: Query, catalogue: Catalogue): Problem | null {
  const dimKeys = catalogue.dimensions.map((d) => d.key);
  const measureKeys = catalogue.measures.map((m) => m.key);
  const noDim = (key: string): Problem => ({
    error: `"${key}" is not a dimension in this pack`,
    hint: nearest(key, dimKeys) ?? undefined,
  });
  const noMeasure = (key: string): Problem => ({
    error: `"${key}" is not a measure in this pack`,
    hint: nearest(key, measureKeys) ?? undefined,
  });

  for (const clause of query.filters ?? []) {
    if (!findDimension(catalogue, clause.dimension)) return noDim(clause.dimension);
  }
  if (query.kind !== "rows" && query.measures) {
    for (const key of query.measures) if (!findMeasure(catalogue, key)) return noMeasure(key);
    if (query.measures.includes(query.measure)) return { error: `"${query.measure}" is already the widget's measure; list only the others in measures` };
    if (query.kind === "series" && query.by) return { error: "A series split by a dimension draws one measure; drop by, or drop measures", hint: "measures" };
  }

  switch (query.kind) {
    case "breakdown": {
      const dim = findDimension(catalogue, query.dimension);
      if (!dim) return noDim(query.dimension);
      if (dim.type === "time") return { error: `"${query.dimension}" is a time dimension; use a series to break down by time`, hint: "series" };
      if (!findMeasure(catalogue, query.measure)) return noMeasure(query.measure);
      if (query.by) {
        if (!findDimension(catalogue, query.by)) return noDim(query.by);
        if (query.by === query.dimension) return { error: "A breakdown split by its own dimension has nothing to split", hint: "by" };
      }
      return null;
    }
    case "series": {
      const m = findMeasure(catalogue, query.measure);
      if (!m) return noMeasure(query.measure);
      const ent = findEntity(catalogue, m.entity);
      if (ent && !ent.hasTime) return { error: `"${query.measure}" belongs to "${m.entity}", which has no time column, so it cannot be plotted over time`, hint: "breakdown" };
      if (query.by && !findDimension(catalogue, query.by)) return noDim(query.by);
      return null;
    }
    case "value": {
      const m = findMeasure(catalogue, query.measure);
      if (!m) return noMeasure(query.measure);
      if (query.compare) {
        const ent = findEntity(catalogue, m.entity);
        if (ent && !ent.hasTime) return { error: `"${query.measure}" cannot be compared to a previous period: "${m.entity}" has no time column` };
        if (!query.time) return { error: "A previous-period comparison needs a time range", hint: 'time: { last: "30d" }' };
      }
      return null;
    }
    case "rows": {
      if (!findEntity(catalogue, query.entity))
        return { error: `"${query.entity}" is not an entity in this pack`, hint: nearest(query.entity, catalogue.entities.map((e) => e.key)) ?? undefined };
      for (const column of query.columns) {
        const dim = findDimension(catalogue, column);
        if (!dim) return noDim(column);
        if (dim.entity !== query.entity)
          return { error: `"${column}" belongs to "${dim.entity}", not "${query.entity}"` };
      }
      if (query.orderBy && !findDimension(catalogue, query.orderBy.key)) return noDim(query.orderBy.key);
      return null;
    }
  }
}

function checkWidget(widget: Widget, catalogue: Catalogue): Problem | null {
  if (widget.kind === "text") return null;

  const problem = checkQuery(widget.query, catalogue);
  if (problem) return problem;

  // A chart split by a second dimension spends its colours on that split; a
  // table can show both the split and several measures as columns.
  if (widget.kind === "chart" && widget.query.kind === "breakdown" && widget.query.by && widget.query.measures?.length)
    return { error: "A breakdown split by a second dimension draws one measure; drop by, or drop measures, or make it a table", hint: "measures" };

  // A heatmap shades one measure over two dimensions: columns and rows.
  if (widget.kind === "chart" && widget.chart === "heatmap") {
    const q = widget.query;
    if (q.kind !== "breakdown" && q.kind !== "series") return { error: "A heatmap shades a measure over two dimensions: a breakdown with a split, or a series split by a dimension", hint: "breakdown" };
    if (!q.by) return { error: `A heatmap needs rows as well as columns: split the ${q.kind === "series" ? "series" : "breakdown"} by a second dimension`, hint: "split" };
    if (q.measures?.length) return { error: "A heatmap shades one measure; several measures need a table", hint: "table" };
    if (q.kind === "breakdown" && (q.compare || q.share || q.other)) return { error: "A heatmap shows the measure itself: no previous period, share or other row", hint: "table" };
  }

  // A pie divides a whole into parts, and a rate is not part of anything.
  if (widget.kind === "chart" && widget.chart === "pie") {
    if (widget.query.kind === "breakdown" && isRate(catalogue, widget.query.measure))
      return { error: `A pie of "${widget.query.measure}" would imply the groups sum to a whole, and rates do not`, hint: "bar" };
    if (widget.query.kind !== "breakdown")
      return { error: "A pie needs a breakdown to divide", hint: "breakdown" };
    if (widget.query.measures?.length) return { error: "A pie divides one measure; several measures need a bar or a table", hint: "bar" };
  }

  return null;
}

/**
 * Renames metric keys across a board when a pack renames one. A function, not
 * an op: it runs as a migration by whoever owns the pack, never by the model.
 */
export function migrateKeys(config: BoardConfig, renames: Record<string, string>): BoardConfig {
  const rename = (key: string) => renames[key] ?? key;
  const draft: BoardConfig = JSON.parse(JSON.stringify(config));
  for (const widget of Object.values(draft.widgets)) {
    if (widget.kind === "text") continue;
    const q = widget.query;
    for (const clause of q.filters ?? []) clause.dimension = rename(clause.dimension);
    if (q.kind !== "rows" && q.measures) q.measures = q.measures.map(rename);
    if (q.kind === "breakdown") {
      q.dimension = rename(q.dimension);
      if (q.by) q.by = rename(q.by);
      q.measure = rename(q.measure);
    } else if (q.kind === "series") {
      q.measure = rename(q.measure);
      if (q.by) q.by = rename(q.by);
    } else if (q.kind === "value") {
      q.measure = rename(q.measure);
    } else {
      q.columns = q.columns.map(rename);
      if (q.orderBy) q.orderBy.key = rename(q.orderBy.key);
    }
  }
  for (const filter of draft.filters) filter.field = rename(filter.field);
  return boardConfigSchema.parse(draft);
}
