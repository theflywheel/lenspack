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
      return `${withMore(query)} by ${query.dimension}${query.by ? ` and ${query.by}` : ""}${query.sortBy === "group" ? ` in ${query.dimension} order` : ""}${query.sort === "asc" ? " (lowest first)" : ""}${query.limit !== 12 ? ` top ${query.limit}` : ""}${time}`;
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
