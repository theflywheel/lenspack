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
function place(layout: LayoutItem[], id: string, w: number, h: number, placement: Placement, cols: number) {
  const others = layout.filter((item) => item.i !== id);
  const occupied = (x: number, y: number, width: number, height: number) =>
    others.some(
      (item) => x < item.x + item.w && x + width > item.x && y < item.y + item.h && y + height > item.y,
    );

  let startY = 0;
  if (placement.place === "top") {
    // "Top" means the top row, not a new row above everything. Three thirds
    // asked for the top belong side by side — pushing the previous one down
    // each time is how "KPIs across the top" became a vertical stack.
    for (let x = 0; x + w <= cols; x++) {
      if (!occupied(x, 0, w, h)) return { i: id, x, y: 0, w, h };
    }
    // Genuinely no room up there, so everything else moves down.
    for (const item of others) item.y += h;
  } else if (placement.place.startsWith("after:")) {
    const anchor = others.find((item) => item.i === placement.place.slice("after:".length));
    if (anchor) startY = anchor.y;
  } else {
    // "Bottom" means the end of the flow, not a new row every time. Scanning
    // from the last row's top lets two halves pair up, while a full-width
    // widget finds no room beside them and drops to a row of its own.
    startY = others.reduce((max, item) => Math.max(max, item.y), 0);
  }

  for (let y = startY; y < startY + 500; y++) {
    for (let x = 0; x + w <= cols; x++) {
      if (!occupied(x, y, w, h)) return { i: id, x, y, w, h };
    }
  }
  return { i: id, x: 0, y: startY, w, h };
}

/**
 * Applies a batch of operations to a draft and commits it whole, or rejects the
 * batch naming the operation that failed. Partial application is never allowed:
 * half of a two-op edit is a board nobody asked for.
 */
export function applyOps(config: BoardConfig, ops: BoardOp[], catalogue: Catalogue): ApplyResult {
  const draft: BoardConfig = JSON.parse(JSON.stringify(config));
  const cols = draft.grid.cols;

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
        const h = placement.height ?? defaultHeight(op.widget.kind);
        draft.layout.push(place(draft.layout, op.id, w, h, placement, cols));
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
        draft.layout = draft.layout.filter((entry) => entry.i !== op.id);
        draft.layout.push(place(draft.layout, op.id, item.w, item.h, placement, cols));
        break;
      }

      case "resize_widget": {
        const item = draft.layout.find((entry) => entry.i === op.id);
        if (!item) return fail(`No widget called "${op.id}"`, nearest(op.id, Object.keys(draft.widgets)) ?? undefined);
        item.w = widthUnits(op.width, cols);
        if (op.height) item.h = op.height;
        break;
      }

      case "set_title":
        draft.title = op.title;
        break;

      case "add_filter": {
        if (draft.filters.some((filter) => filter.id === op.filter.id))
          return fail(`A filter called "${op.filter.id}" already exists`);
        if (!findDimension(catalogue, op.filter.field))
          return fail(
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
    }
  }

  // Layout is normalised last: a widget wider than the grid, or one left
  // hanging past the bottom, is corrected rather than rejected.
  draft.layout = compact(draft.layout, cols);

  const parsed = boardConfigSchema.safeParse(draft);
  if (!parsed.success) return { ok: false, opIndex: ops.length - 1, error: parsed.error.issues[0]?.message ?? "Invalid config" };
  return { ok: true, config: parsed.data };
}

function defaultHeight(kind: string) {
  return kind === "kpi" ? 3 : kind === "text" ? 3 : 7;
}

// Gravity: everything floats up until it rests on something. The same rule
// react-grid-layout applies on drag, applied here so a config saved by chat and
// one saved by mouse are the same shape.
export function compact(layout: LayoutItem[], cols: number): LayoutItem[] {
  const sorted = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
  const settled: LayoutItem[] = [];

  for (const item of sorted) {
    const next = { ...item, w: Math.min(item.w, cols) };
    next.x = Math.min(next.x, cols - next.w);
    let y = next.y;
    while (
      y > 0 &&
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

  switch (query.kind) {
    case "breakdown": {
      const dim = findDimension(catalogue, query.dimension);
      if (!dim) return noDim(query.dimension);
      if (dim.type === "time") return { error: `"${query.dimension}" is a time dimension; use a series to break down by time`, hint: "series" };
      if (!findMeasure(catalogue, query.measure)) return noMeasure(query.measure);
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

  // A pie divides a whole into parts, and a rate is not part of anything.
  if (widget.kind === "chart" && widget.chart === "pie") {
    if (widget.query.kind === "breakdown" && isRate(catalogue, widget.query.measure))
      return { error: `A pie of "${widget.query.measure}" would imply the groups sum to a whole, and rates do not`, hint: "bar" };
    if (widget.query.kind !== "breakdown")
      return { error: "A pie needs a breakdown to divide", hint: "breakdown" };
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
    if (q.kind === "breakdown") {
      q.dimension = rename(q.dimension);
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
