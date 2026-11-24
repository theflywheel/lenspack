import { z } from "zod";

import type { Catalogue } from "./catalogue";
import { checkWidget, filterProblem, nearest } from "./check";
import { compact, defaultHeight, makeRoom, minWidth, pack, place, pushDown, roomInRow, widthUnits } from "./layout";
import { type BoardConfig, type LayoutItem, type Problem, boardConfigSchema, filterSchema, placementSchema, widgetSchema } from "./schema";

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
  // Replaces a filter in place (its label, what it applies to, its default), keeping its id and position.
  z.object({ op: z.literal("update_filter"), id: z.string(), filter: filterSchema }),
  z.object({ op: z.literal("remove_filter"), id: z.string() }),
  // "Make it compact": density and packing, together or separately.
  z.object({
    op: z.literal("set_layout_mode"),
    density: z.enum(["comfortable", "compact"]).optional(),
    fill: z.boolean().optional(),
  }),
]);
export type BoardOp = z.infer<typeof opSchema>;

export type ApplyResult = { ok: true; config: BoardConfig } | ({ ok: false; opIndex: number } & Problem);

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
        const width = widthUnits(op.width, cols);
        for (const id of rowOf(item)) touched.add(id);
        // The move tool resizes a widget just before moving it: it is leaving this row, so its
        // row-mates make no room for it.
        const leaving = ops.slice(index + 1).some((later) => later.op === "move_widget" && later.id === op.id);
        if (!leaving) {
          // Wider than its row has room for: the row-mates narrow to make room, as for a move,
          // so the widget gets its width and nobody is pushed off the row.
          const room = roomInRow(draft.layout, item, width, cols, (id) => minWidth(draft.widgets[id]?.kind));
          if ("error" in room) return fail(room.error, room.hint);
        }
        item.w = width;
        delete item.fw;
        if (op.height) item.h = op.height;
        sized.add(op.id);
        // A taller widget can cover the top of the next row, and gravity only moves things up,
        // so push whatever it now covers down below it (and whatever that covers, in turn).
        pushDown(draft.layout, item);
        break;
      }

      case "set_title":
        draft.title = op.title;
        break;

      case "add_filter": {
        if (draft.filters.some((filter) => filter.id === op.filter.id))
          return fail(`A filter called "${op.filter.id}" already exists`);
        const problem = filterProblem(op.filter, draft, catalogue);
        if (problem) return fail(problem.error, problem.hint);
        draft.filters.push(op.filter);
        break;
      }

      case "update_filter": {
        const at = draft.filters.findIndex((filter) => filter.id === op.id);
        if (at < 0) return fail(`No filter called "${op.id}"`, nearest(op.id, draft.filters.map((f) => f.id)) ?? undefined);
        if (draft.filters[at]!.type === "host") return fail(`“${draft.filters[at]!.label}” is kept as the host has it: it can be removed here, but changed only there`);
        if (op.filter.id !== op.id) return fail("A filter keeps its id when it changes");
        const problem = filterProblem(op.filter, draft, catalogue);
        if (problem) return fail(problem.error, problem.hint);
        draft.filters[at] = op.filter;
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
