import type { BoardConfig, Query, TimeRange } from "./schema";

// A compact picture of the board rather than its JSON. The model works from
// this by default and only asks for detail when it edits — which is what keeps
// a long editing session affordable.
const WIDTH_WORDS: Record<number, string> = { 12: "full width", 9: "three quarters width", 8: "two thirds width", 6: "half width", 4: "a third width", 3: "a quarter width" };

/**
 * A width as words and columns, "a quarter width (3/12)": the model repeats the words rather
 * than working out that 3 of 12 columns is a quarter, which it got wrong ("a third").
 */
export function widthWords(w: number, cols = 12) {
  const word = cols === 12 ? WIDTH_WORDS[w] : w === cols ? "full width" : undefined;
  return word ? `${word} (${w}/${cols})` : `${w}/${cols} width`;
}

export function summarise(config: BoardConfig) {
  const rows = new Map<number, string[]>();
  for (const item of [...config.layout].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const widget = config.widgets[item.i];
    if (!widget) continue;
    const kind = widget.kind === "chart" ? widget.chart : widget.kind;
    // A text tile's own words, briefly: it may stand in for a chart lenspack cannot draw, and
    // the model should be able to say what it is.
    const what = widget.kind === "text" ? (widget.body.trim() ? ` says “${excerpt(widget.body, 200)}”` : "") : ` ${describeQuery(widget.query)}`;
    const line = rows.get(item.y) ?? [];
    line.push(`${item.i} (${kind}, ${widthWords(item.w, config.grid.cols)})${what} “${widget.title}”`);
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

function excerpt(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
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
    case "points":
      return `${query.entity} points${query.color ? ` coloured by ${query.color}` : ""}${query.size ? ` sized by ${query.size}` : ""}${query.label ? ` named by ${query.label}` : ""}${query.limit !== 5000 ? ` top ${query.limit}` : ""}${time}`;
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
 * ended up and with whom, which other widgets changed row or width, and whether the rows it
 * touched are now exactly full. A model told only "applied" cannot see that a move made room
 * by shrinking two charts, that a resize pushed a neighbour to the next row, or that there is
 * nothing left to fix. Rows are numbered as in summarise().
 */
export function layoutChanges(before: BoardConfig, after: BoardConfig, ops: { op: string; id?: string; width?: unknown; placement?: { width?: unknown } }[]) {
  const cols = after.grid.cols;
  const rows = (config: BoardConfig) => {
    const ys = [...new Set(config.layout.map((item) => item.y))].sort((a, b) => a - b);
    const at = new Map(config.layout.map((item) => [item.i, item]));
    const mates = (id: string) => {
      const item = at.get(id);
      return item ? config.layout.filter((o) => o.y === item.y && o.i !== id).sort((p, q) => p.x - q.x).map((o) => o.i) : [];
    };
    return { at, mates, number: (id: string) => ys.indexOf(at.get(id)?.y ?? -1) + 1 };
  };
  const was = rows(before);
  const now = rows(after);
  const named = new Set(ops.map((op) => op.id).filter((id): id is string => !!id));
  const moved = [...new Set(ops.filter((op) => op.op === "move_widget" && op.id).map((op) => op.id!))];
  const laidOut = [...new Set(ops.filter((op) => (op.op === "move_widget" || op.op === "resize_widget") && op.id).map((op) => op.id!))];
  const units: Record<string, number> = { full: 12, half: 6, third: 4, quarter: 3 };
  const asked = new Map<string, number>();
  for (const op of ops) {
    const width = op.op === "resize_widget" ? op.width : op.op === "move_widget" ? op.placement?.width : undefined;
    if (op.id && width !== undefined) asked.set(op.id, typeof width === "number" ? width : (units[String(width)] ?? 0));
  }
  const notes: string[] = [];
  for (const id of moved) {
    if (!now.at.has(id)) continue;
    const mates = now.mates(id);
    const width = widthWords(now.at.get(id)!.w, cols);
    notes.push(mates.length ? `${id}: now row ${now.number(id)}, ${width}, beside ${mates.join(", ")}` : `${id}: now row ${now.number(id)} on its own, ${width}`);
  }
  for (const [id, want] of asked) {
    const item = now.at.get(id);
    if (item && want > 0 && item.w !== want) notes.push(`${id} is ${widthWords(item.w, cols)}, not ${widthWords(want, cols)}${item.w > want ? ": widened to fill its row" : ": narrowed to fit the row"}`);
  }
  // Widgets the edit did not name: a change of row is said in words, a change of width listed.
  const resized: string[] = [];
  for (const item of after.layout) {
    const prior = was.at.get(item.i);
    if (named.has(item.i) || !prior) continue;
    // Moved: it shares its row with none of its old row-mates, and it is the one that moved
    // (a widget whose neighbour left stays put; rows below a new one move down together).
    const used = was.mates(item.i).filter((id) => now.at.has(id));
    const mates = now.mates(item.i);
    const shifted = item.y !== prior.y || item.x !== prior.x;
    const wide = item.w !== prior.w ? `, now ${widthWords(item.w, cols)}` : "";
    if (shifted && used.length && !used.some((id) => mates.includes(id))) notes.push(`${item.i} no longer fits beside ${used.join(", ")} and moved to row ${now.number(item.i)}${wide}`);
    else if (shifted && !used.length && mates.length) notes.push(`${item.i} moved into row ${now.number(item.i)} beside ${mates.join(", ")}${wide}`);
    else if (item.w !== prior.w) resized.push(`${item.i} now ${widthWords(item.w, cols).replace(/\)$/, `, was ${prior.w}/${cols})`)}`);
  }
  if (resized.length) notes.push(`to make room or fill rows, also resized: ${resized.join(", ")}`);
  // A row the edit laid out that is now exactly full: there is nothing left to make room for.
  const told = new Set<number>();
  for (const id of laidOut) {
    const item = now.at.get(id);
    if (!item || told.has(item.y)) continue;
    told.add(item.y);
    const row = after.layout.filter((o) => o.y === item.y).sort((p, q) => p.x - q.x);
    if (row.length > 1 && row.reduce((sum, o) => sum + o.w, 0) === cols)
      notes.push(`row ${now.number(id)} (${row.map((o) => o.i).join(", ")}) is now full (${row.map((o) => o.w).join("+")}); no resize needed`);
  }
  return notes;
}
