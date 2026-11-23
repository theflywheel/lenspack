import type { BoardConfig, Query, TimeRange } from "./schema";

// A compact picture of the board rather than its JSON. The model works from
// this by default and only asks for detail when it edits — which is what keeps
// a long editing session affordable.
export function summarise(config: BoardConfig) {
  const rows = new Map<number, string[]>();
  for (const item of [...config.layout].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const widget = config.widgets[item.i];
    if (!widget) continue;
    const kind = widget.kind === "chart" ? widget.chart : widget.kind;
    const what = widget.kind === "text" ? "" : ` ${describeQuery(widget.query)}`;
    const line = rows.get(item.y) ?? [];
    line.push(`${item.i} (${kind}, ${item.w}/${config.grid.cols} wide)${what} “${widget.title}”`);
    rows.set(item.y, line);
  }
  const layout = [...rows.entries()].map(([, line], i) => `  row ${i + 1}: ${line.join(" | ")}`).join("\n");
  return [
    `Board: “${config.title}” (pack ${config.pack} v${config.packVersion}${config.grid.density === "compact" ? ", compact" : ""}${config.grid.fill ? ", packed" : ""})`,
    config.layout.length === 0 ? "  (empty)" : layout,
    config.filters.length > 0 ? `Filters: ${config.filters.map((f) => `${f.label} [${f.field}]`).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function describeQuery(query: Query) {
  const time = query.time ? ` ${describeTime(query.time)}` : "";
  switch (query.kind) {
    case "breakdown":
      return `${withMore(query)} by ${query.dimension}${query.by ? ` and ${query.by}` : ""}${query.sortBy === "group" ? ` in ${query.dimension} order` : ""}${query.sort === "asc" ? " (lowest first)" : ""}${query.limit !== 12 ? ` top ${query.limit}` : ""}${query.compare ? " vs previous" : ""}${query.share ? " with share" : ""}${query.other ? " + other" : ""}${time}`;
    case "series":
      return `${withMore(query)} per ${query.grain}${query.by ? ` by ${query.by}` : ""}${time}`;
    case "value":
      return `${withMore(query)}${query.compare ? " vs previous" : ""}${time}`;
    case "rows":
      return `${query.entity} rows [${query.columns.join(", ")}]${time}`;
  }
}

function describeTime(t: TimeRange) {
  if ("last" in t) return `last ${t.last}`;
  if ("from" in t) return `${t.from.slice(0, 10)}→${t.to.slice(0, 10)}`;
  const at = !t.offset ? `this ${t.period}` : t.offset === -1 ? `last ${t.period}` : `${t.period} ${t.offset}`;
  return (t.count ?? 1) > 1 ? `${t.count} ${t.period}s to ${at}` : at;
}

function withMore(query: { measure: string; measures?: string[] }) {
  return query.measures?.length ? `${query.measure} + ${query.measures.join(", ")}` : query.measure;
}

/**
 * What a layout edit did besides what it was asked, in a few words: where each moved widget
 * ended up and with whom, and which other widgets changed width. A model told only "applied"
 * cannot see that a move made room by shrinking two charts, or that a widget it asked for
 * at half width was widened to fill its row.
 */
export function layoutChanges(before: BoardConfig, after: BoardConfig, ops: { op: string; id?: string; width?: unknown; placement?: { width?: unknown } }[]) {
  const cols = after.grid.cols;
  const prior = new Map(before.layout.map((item) => [item.i, item]));
  const named = new Set(ops.map((op) => op.id).filter((id): id is string => !!id));
  const moved = ops.filter((op) => op.op === "move_widget" && op.id).map((op) => op.id!);
  const asked = new Map<string, number>();
  const units: Record<string, number> = { full: 12, half: 6, third: 4, quarter: 3 };
  for (const op of ops) {
    const width = op.op === "resize_widget" ? op.width : op.op === "move_widget" ? op.placement?.width : undefined;
    if (op.id && width !== undefined) asked.set(op.id, typeof width === "number" ? width : (units[String(width)] ?? 0));
  }
  const notes: string[] = [];
  for (const id of new Set(moved)) {
    const item = after.layout.find((entry) => entry.i === id);
    if (!item) continue;
    const mates = after.layout.filter((entry) => entry.y === item.y && entry.i !== id).sort((a, b) => a.x - b.x).map((entry) => entry.i);
    notes.push(mates.length ? `${id} is now in a row with ${mates.join(", ")}` : `${id} is on a row of its own`);
  }
  for (const [id, want] of asked) {
    const item = after.layout.find((entry) => entry.i === id);
    if (item && want > 0 && item.w !== want) notes.push(`${id} is ${item.w}/${cols} wide, not ${want}/${cols}${item.w > want ? ": widened to fill its row" : ": narrowed to fit the row"}`);
  }
  const resized = after.layout
    .filter((item) => !named.has(item.i) && prior.has(item.i) && prior.get(item.i)!.w !== item.w)
    .map((item) => `${item.i} ${prior.get(item.i)!.w}→${item.w}`);
  if (resized.length) notes.push(`to make room or fill rows, also resized: ${resized.join(", ")}`);
  return notes;
}
