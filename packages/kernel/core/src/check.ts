import { type Catalogue, dimension as findDimension, entity as findEntity, isRate, measure as findMeasure } from "./catalogue";
import { computeProblem } from "./compute";
import { type BoardConfig, type Filter, type Problem, type Query, type Widget, measured, ratioTo } from "./schema";

// What may go on a board: every key a query or a filter names exists in the
// pack, and every widget draws something its kind can show.

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

/** Why a filter cannot go on this board, or null. A host filter only ever comes from the host. */
export function filterProblem(filter: Filter, draft: BoardConfig, catalogue: Catalogue): Problem | null {
  if (filter.type === "host") return { error: "A filter kept as the host has it can only come from the host" };
  if (filter.type === "daterange" ? filter.field !== "time" : !findDimension(catalogue, filter.field))
    return filter.type === "daterange"
      ? { error: 'A date range filter sets time; its field is "time"' }
      : { error: `"${filter.field}" is not a dimension in this pack`, hint: nearest(filter.field, catalogue.dimensions.map((d) => d.key)) ?? undefined };
  if (filter.default?.values && filter.type !== "select") return { error: "Only a select filter has default values" };
  const missing = filter.applies.filter((target) => target !== "*" && !draft.widgets[target]);
  return missing.length > 0 ? { error: `Filter targets widgets that do not exist: ${missing.join(", ")}` } : null;
}

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
  for (const key of ratioTo(query)) if (!findMeasure(catalogue, key)) return noMeasure(key);
  const computing = computeProblem(query, measured(query) ? findMeasure(catalogue, query.measure) : null);
  if (computing) return computing;
  if (measured(query) && query.measures) {
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
    case "points": {
      const ent = findEntity(catalogue, query.entity);
      if (!ent) return { error: `"${query.entity}" is not an entity in this pack`, hint: nearest(query.entity, catalogue.entities.map((e) => e.key)) ?? undefined };
      if (!ent.hasLocation) {
        const located = catalogue.entities.filter((e) => e.hasLocation).map((e) => e.key);
        return { error: `"${query.entity}" has no location (latitude and longitude), so it cannot be drawn as points` + (located.length ? `; these do: ${located.join(", ")}` : "; no entity in this pack has one"), hint: located[0] };
      }
      for (const key of [query.color, query.label]) if (key !== undefined && !findDimension(catalogue, key)) return noDim(key);
      if (query.color !== undefined && findDimension(catalogue, query.color)!.type === "time") return { error: `"${query.color}" is a time dimension; colour points by a category`, hint: "color" };
      if (query.size !== undefined) {
        const m = findMeasure(catalogue, query.size);
        if (!m) return noMeasure(query.size);
        if (m.entity !== query.entity) return { error: `"${query.size}" is measured on "${m.entity}", not "${query.entity}": a point's size must be a measure of the points' own entity` };
      }
      return null;
    }
  }
}

export function checkWidget(widget: Widget, catalogue: Catalogue): Problem | null {
  if (widget.kind === "text") return null;

  const problem = checkQuery(widget.query, catalogue);
  if (problem) return problem;

  // A chart split by a second dimension spends its colours on that split; a
  // table can show both the split and several measures as columns.
  if (widget.kind === "chart" && widget.query.kind === "breakdown" && widget.query.by && widget.query.measures?.length)
    return { error: "A breakdown split by a second dimension draws one measure; drop by, or drop measures, or make it a table", hint: "measures" };

  // Points go on a map (or in a table); a map draws nothing else.
  if (widget.query.kind === "points" && widget.kind !== "table" && !(widget.kind === "chart" && widget.chart === "map"))
    return { error: "A points query is drawn as a map chart, or listed in a table", hint: "map" };
  if (widget.kind === "chart" && widget.chart === "map" && widget.query.kind !== "points")
    return { error: "A map draws a points query: the rows of an entity with a location", hint: "points" };

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
    if (widget.query.compute) return { error: "A pie divides a whole into parts, and a computed number (an average, a change, a ratio) is not part of one", hint: "bar" };
    if (widget.query.measures?.length) return { error: "A pie divides one measure; several measures need a bar or a table", hint: "bar" };
  }

  return null;
}
