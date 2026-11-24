import { type LayoutItem, type Placement, WIDTHS } from "./schema";

// Where widgets go on the grid. The functions that take a layout and an item
// (place, besideAnchor, rowBelow, makeRoom, roomInRow, pushDown) change those
// items in place as well as returning their answer: applyOps calls them on its
// own copy of the board. compact and pack return new items and leave theirs alone.

export function widthUnits(width: Placement["width"], cols: number) {
  const units = typeof width === "number" ? width : (WIDTHS[width] ?? 6);
  return Math.max(1, Math.min(cols, units));
}

export function defaultHeight(kind: string) {
  return kind === "kpi" ? 3 : kind === "text" ? 3 : kind === "heatmap" ? 9 : 7;
}

// First fit, scanning top to bottom for a row with room. Simple enough to
// reason about, and it cannot produce an overlap: a candidate position is only
// accepted when nothing already occupies it. Changes the other items in place:
// "top" moves them down, and a widened widget whose extra is taken goes back to
// its own width. besideOnly: only beside an after: anchor, else null.
export function place(layout: LayoutItem[], id: string, w: number, h: number, placement: Placement, cols: number, floors?: Map<string, number>): LayoutItem;
export function place(layout: LayoutItem[], id: string, w: number, h: number, placement: Placement, cols: number, floors: Map<string, number> | undefined, besideOnly: true): LayoutItem | null;
export function place(layout: LayoutItem[], id: string, w: number, h: number, placement: Placement, cols: number, floors?: Map<string, number>, besideOnly = false): LayoutItem | null {
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

  // A bound on the scan, not a limit a board reaches: room turns up by the row under the
  // lowest widget. Should a board ever be taller than the scan, that row is free too.
  for (let y = startY; y < startY + 500; y++) {
    for (let x = 0; x + w <= cols; x++) {
      if (!occupied(x, y, w, h)) return at(x, y);
    }
  }
  return { i: id, x: 0, y: others.reduce((max, item) => Math.max(max, item.y + item.h), startY), w, h };
}

// Beside the anchor, when its row has room. Room in total but split into gaps (on a board
// that is not packed, narrowing a widget leaves a gap where it was) is joined by sliding the
// row's widgets left first (in place). Null when the row has no room for the width asked,
// and then the row is as it was.
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
// after Y" put X back where it was. Moves those items (and their floors) in place.
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
// rather than putting X somewhere nobody asked for. The row's items take their new widths
// and positions in place; the new item is returned, not added to the layout.
export function makeRoom(
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

// Room for `item` at `width` in its own row: when the row would overflow, the other widgets
// narrow in proportion to their widths, never below their narrowest, and the row is laid out
// again left to right. Refuses (with the choices) rather than push a row-mate to another row.
// The row's items take their new widths and positions in place, except `item`'s width,
// which the caller sets.
export function roomInRow(layout: LayoutItem[], item: LayoutItem, width: number, cols: number, minOf: (id: string) => number): { ok: true } | { error: string; hint: string } {
  const row = layout.filter((other) => other.y === item.y).sort((a, b) => a.x - b.x);
  const mates = row.filter((other) => other !== item);
  const own = (o: LayoutItem) => (o.fw !== undefined && o.fw < o.w ? o.fw : o.w);
  const used = mates.reduce((sum, o) => sum + own(o), 0);
  const names = mates.map((o) => `"${o.i}"`).join(", ");
  const refuse = {
    error: `The row of "${item.i}" is full (${row.map((o) => `${o.i} ${o.w}/${cols}`).join(", ")}) and cannot make "${item.i}" ${width}/${cols} wide without squeezing ${names} below their narrowest`,
    hint: `Ask for a smaller width, move one of ${names} to another row (move_widget with place "below:${item.i}"), or remove one`,
  };
  // Full width is a row of its own: what shared the row goes under it (and the edit's note says so).
  if (width >= cols) return { ok: true };
  // A taller widget from a row above reaches into this one: the columns are not the row's to share.
  if (layout.some((o) => o.y < item.y && o.y + o.h > item.y)) return used + width <= cols ? { ok: true } : refuse;
  let widths = mates.map(own);
  if (used + width > cols) {
    const mins = mates.map((o) => Math.min(minOf(o.i), own(o)));
    if (mins.reduce((a, b) => a + b, 0) + width > cols) return refuse;
    widths = shrinkTo(widths, mins, cols - width);
  }
  // Laid out again left to right: packing's extra handed back, gaps closed, nobody overlapping.
  let x = 0;
  for (const o of row) {
    if (o !== item) {
      o.w = widths[mates.indexOf(o)]!;
      delete o.fw;
    }
    o.x = x;
    x += o === item ? width : o.w;
  }
  return { ok: true };
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

/** Moves everything that overlaps `moved` to just below it, cascading, like a drag in react-grid-layout. In place. */
export function pushDown(layout: LayoutItem[], moved: LayoutItem) {
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
