import { type BoardOp, type Query, applyOps, emptyBoard, opSchema } from "@lenspack/core";
import { type Capabilities, ResolveError, check } from "@lenspack/engine";
import { type MeasureExpr, type Pack, type PackDimension, type PackMeasure, type Where, catalogueFrom, formatExpr, operands, parseExpr, parsePack } from "@lenspack/spec";
import YAML from "yaml";

import { type Bucket, type Leaf, bare, walk } from "./walk";

export { walk, toWhere, type Leaf, type Bucket } from "./walk";

// DIGIT DSS describes a dashboard as hand-written aggregation JSON per chart,
// copied per hierarchy level. This compiles those configs into what lenspack
// keeps separate: one pack (the vocabulary, each number defined once) and
// boards (which numbers to draw, and how). What does not translate is listed
// in the report with the chart and the reason.

export type DssQuery = { indexName: string; dateRefField?: string; requestQueryMap?: string; aggrQuery: string };
export type DssChart = {
  chartName?: string;
  chartType?: string;
  valueType?: string;
  queries: DssQuery[];
  aggregationPaths?: string[];
  action?: string;
  computedFields?: { actionName?: string; fields?: string[]; newField?: string }[];
  filterForCurrentDay?: boolean;
  insight?: { action?: string };
  excludedColumns?: string[];
};
export type DssMaster = { dashboards: { name?: string; id?: string; title?: string; visualizations?: { vizArray?: { name?: string; charts?: { id: string }[] }[] }[] }[] };

export type DssOptions = {
  pack?: string;
  /** Values DSS substitutes from the request (e.g. "PVAR"); each becomes a board filter. */
  placeholders?: string[];
  /** The engine the boards are checked against. Defaults to a search index: no joins. */
  capabilities?: Capabilities;
};

export type ChartOutcome = {
  chart: string;
  status: "converted" | "partial" | "skipped";
  notes: string[];
  widget?: string;
  /** Reached by drilling down another chart's widget rather than drawn on its own. */
  drilledFrom?: string;
  /** The widget drills: it is grouped by a hierarchy level with a level below it. */
  drills?: boolean;
};

export type DssResult = { pack: Pack; packYaml: string; boards: { id: string; title: string; ops: BoardOp[] }[]; outcomes: ChartOutcome[]; assumptions: string[]; report: string };

const SEARCH: Capabilities = { joins: false, exactDistinct: false, exactPercentiles: false };
const GENERIC = /^(count|sum|name|aggr?s?|filters?|value|total|agg|result|daily count|targetvalue)$/i;

export const slug = (s: string, max = 48) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "n_$1")
    .slice(0, max)
    .replace(/_+$/, "") || "unnamed";

const entityKey = (index: string) => slug(index.replace(/-index(-v\d+)?$/, "").replace(/-v\d+$/, ""));
const whereSig = (w: Where[]) => JSON.stringify([...w].map((x) => [x.field, x.op, x.value ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
const readable = (chartName: string) =>
  chartName
    .replace(/^DSS_(HEALTH_)?/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());

function grainOf(interval: string): "hour" | "day" | "week" | "month" | "quarter" | "year" | null {
  const i = interval.toLowerCase();
  if (/^(1?h|hour)$/.test(i)) return "hour";
  if (/^(1?d|day)$/.test(i)) return "day";
  if (/^(1?w|week)$/.test(i)) return "week";
  if (/^(1?m|month|1M)$/.test(interval)) return "month";
  if (/^(1?q|quarter)$/.test(i)) return "quarter";
  if (/^(1?y|year)$/.test(i)) return "year";
  return null;
}

export function compileDss(charts: Record<string, DssChart>, master?: DssMaster, opts: DssOptions = {}): DssResult {
  const placeholders = new Set(opts.placeholders ?? ["PVAR"]);
  const caps = opts.capabilities ?? SEARCH;
  const assumptions: string[] = [];
  const outcomes: ChartOutcome[] = [];

  const entities: Pack["entities"] = {};
  const dimensions = new Map<string, PackDimension>();
  const fieldToDim = new Map<string, string>(); // `${entity}|${field}` → key
  const measures = new Map<string, PackMeasure>();
  const measureBySig = new Map<string, string>();
  const filterDims = new Set<string>();
  // Dimensions a dashboard request can filter by (requestQueryMap keys): the
  // boundary levels. Only these can be levels of a hierarchy; a drill from a
  // category into a boundary is a different kind of link.
  const filterable = new Set<string>();

  const entityFor = (q: DssQuery) => {
    const key = entityKey(q.indexName);
    const e = (entities[key] ??= { source: q.indexName, joins: [] });
    if (!e.time && q.dateRefField) {
      // DIGIT keeps audit times as epoch milliseconds in a long; @timestamp is a real date.
      e.time = /@timestamp$/.test(q.dateRefField) ? q.dateRefField : { field: q.dateRefField, unit: "epoch_ms" };
      assumptions.push(`${key}: time is ${q.dateRefField}${typeof e.time === "string" ? " (a date)" : " (epoch milliseconds)"}`);
    }
    return key;
  };

  const dimension = (entity: string, field: string, preferredKey?: string): string => {
    const f = bare(field);
    const known = fieldToDim.get(`${entity}|${f}`);
    if (known) return known;
    const key = preferredKey ? slug(preferredKey) : slug(f.split(".").pop()!);
    const existing = dimensions.get(key);
    if (!existing) dimensions.set(key, { key, entity, field: f, type: "string", synonyms: [], verified: true });
    else if (existing.entity !== entity && !existing.also?.[entity]) existing.also = { ...(existing.also ?? {}), [entity]: { field: f } };
    else if (existing.entity === entity && existing.field !== f) {
      // Same name, different field on the same entity: keep both, apart.
      const alt = `${key}_${slug(f.split(".").pop()!)}`;
      if (!dimensions.has(alt)) dimensions.set(alt, { key: alt, entity, field: f, type: "string", synonyms: [], verified: true });
      fieldToDim.set(`${entity}|${f}`, alt);
      return alt;
    }
    fieldToDim.set(`${entity}|${f}`, key);
    return key;
  };

  // "Todays visits" is visits over today's window: the window belongs to the
  // widget, so it is not part of the measure's name.
  const name = (leaf: Leaf, chartName: string) => {
    const meaningful = [...leaf.path].reverse().find((p) => !GENERIC.test(p.trim()));
    return slug(meaningful ?? readable(chartName)).replace(/^(todays?|daily)_(?=.)/, "");
  };

  const measure = (entity: string, leaf: Leaf, chartName: string): string => {
    const sig = JSON.stringify([entity, leaf.agg, leaf.field ?? null, whereSig(leaf.where), leaf.scale ?? null]);
    const known = measureBySig.get(sig);
    if (known) return known;
    // DSS keeps one row per hierarchy level for targets and stock, and picks
    // a level with `exists A` + `must_not exists B`. That is part of what the
    // number means, so it is part of its name.
    const level = levelOf(leaf.where);
    const stem = level ? slug(`${name(leaf, chartName).replace(new RegExp(`_?${level}$`), "")}_at_${level}`) : name(leaf, chartName);
    let key = stem;
    if (measures.has(key) || dimensions.has(key)) key = slug(`${key}_${distinguish(leaf.where, measures.get(key)?.where ?? [])}`);
    for (let i = 2; measures.has(key) || dimensions.has(key); i++) key = `${stem}_${i}`;
    const def: PackMeasure = {
      key,
      entity,
      agg: leaf.agg,
      ...(leaf.field ? { field: leaf.field } : {}),
      ...(leaf.where.length ? { where: leaf.where } : {}),
      ...(leaf.scale ? { scale: leaf.scale } : {}),
      label: [...leaf.path].reverse().find((p) => !GENERIC.test(p.trim())) ?? readable(chartName),
      format: "number",
      synonyms: [],
      verified: true,
    };
    measures.set(key, def);
    measureBySig.set(sig, key);
    return key;
  };

  // Arithmetic over measures already defined. Read at the grain of its
  // first operand; the engine combines operands from several entities.
  const derived = (expr: string, label: string, percent: boolean): string => {
    const sig = JSON.stringify(["derived", expr]);
    const known = measureBySig.get(sig);
    if (known) return known;
    let key = slug(label);
    for (let i = 2; measures.has(key) || dimensions.has(key); i++) key = `${slug(label)}_${i}`;
    const first = operands(parseExpr(expr))[0]!;
    measures.set(key, { key, entity: measures.get(first)!.entity, derived: expr, label, format: percent ? "percent" : "number", synonyms: [], verified: true });
    measureBySig.set(sig, key);
    return key;
  };


  type Planned = { id: string; chartId: string; widget: BoardOp; notes: string[] };
  let leafCount = 0;
  const planned = new Map<string, Planned>();

  for (const [chartId, chart] of Object.entries(charts)) {
    // Real configs carry comments and stray values beside the charts.
    if (!chart || typeof chart !== "object" || !Array.isArray((chart as DssChart).queries)) continue;
    const notes: string[] = [];
    const chartName = chart.chartName || chartId;
    try {
      const perQuery = chart.queries.map((q) => {
        const entity = entityFor(q);
        try {
          for (const [k, f] of Object.entries(JSON.parse(q.requestQueryMap || "{}") as Record<string, string>)) filterable.add(dimension(entity, f, k));
        } catch {
          notes.push("requestQueryMap is not JSON");
        }
        const walked = walk(String(q.aggrQuery ?? ""), placeholders);
        for (const p of walked.problems) notes.push(`${q.indexName}: ${p}`);
        for (const p of walked.placeholders) filterDims.add(dimension(entity, p.field));
        return { q, entity, walked };
      });

      // The leaves the chart actually draws.
      const paths = new Set(chart.aggregationPaths ?? []);
      const drawn = perQuery.flatMap(({ entity, walked }) =>
        walked.leaves.filter((l) => paths.size === 0 || l.path.some((p) => paths.has(p))).map((leaf) => ({ entity, leaf })),
      );
      leafCount += drawn.length;
      // DSS merges a chart's queries by bucket key: the terms field each query
      // groups by is one concept, whatever each index calls it.
      const innermost = (l: Leaf) => l.buckets.filter((b): b is Extract<Bucket, { kind: "terms" }> => b.kind === "terms").at(-1);
      const lead = drawn.find((d) => innermost(d.leaf));
      if (lead) {
        const key = dimension(lead.entity, innermost(lead.leaf)!.field);
        const dim = dimensions.get(key)!;
        for (const d of drawn) {
          const t = innermost(d.leaf);
          if (!t || d.entity === dim.entity || dim.also?.[d.entity]) continue;
          dim.also = { ...(dim.also ?? {}), [d.entity]: { field: t.field } };
          if (!fieldToDim.has(`${d.entity}|${t.field}`)) fieldToDim.set(`${d.entity}|${t.field}`, key);
        }
      }
      if (drawn.length === 0) {
        outcomes.push({ chart: chartId, status: "skipped", notes: notes.length ? notes : ["no aggregation lenspack can read"] });
        continue;
      }

      const keyOf = ({ entity, leaf }: { entity: string; leaf: Leaf }): string => {
        if (!leaf.arith) return measure(entity, leaf, chartName);
        const keys = Object.fromEntries(Object.entries(leaf.arith.vars).map(([v, l]) => [v, measure(entity, l, chartName)]));
        return derived(formatExpr(renameKeys(leaf.arith.expr, (v) => keys[v]!)), name(leaf, chartName), leaf.arith.percent);
      };

      // DSS columns by the name the chart uses for them: the leaf's own agg
      // name, and any alias or sum a computed field adds.
      type Column = { label: string; key: string };
      const columns: Column[] = drawn.map((d) => ({ label: d.leaf.path.at(-1)!, key: keyOf(d) }));
      const find = (label: string) =>
        columns.find((c) => c.label === label) ?? (() => {
          const d = drawn.find((x) => x.leaf.path.includes(label));
          return d ? { label, key: keyOf(d) } : undefined;
        })();
      for (const cf of chart.computedFields ?? []) {
        const fields = (cf.fields ?? []).map(find);
        const label = cf.newField ?? cf.fields?.join(" ") ?? "";
        if (fields.some((f) => !f) || !fields.length) {
          notes.push(`computed field ${cf.newField ?? cf.actionName}: an operand did not translate`);
          continue;
        }
        const keys = fields.map((f) => f!.key);
        const action = cf.actionName ?? "";
        if ((action === "AdditiveComputedField" || action === "NoOpsComputedField" || action === "") && keys.length === 1) columns.push({ label, key: keys[0]! });
        else if (action === "AdditiveComputedField" || action === "SumComputedField") columns.push({ label, key: derived(keys.join(" + "), label, false) });
        else if (action === "PercentageComputedField" && keys.length === 2) columns.push({ label, key: derived(`${keys[0]} / ${keys[1]}`, label, true) });
        else notes.push(`computed field ${action} not translated`);
      }

      // What the chart's headline number is.
      let measureKey: string;
      const order = chart.aggregationPaths ?? [];
      if ((chart.action === "percentage" || chart.action === "division") && order.length >= 2) {
        const [a, b] = [find(order[0] ?? ""), find(order[1] ?? "")];
        if (!a || !b) {
          outcomes.push({ chart: chartId, status: "skipped", notes: [...notes, `a ${chart.action} whose operands did not both translate; drawing one of them alone would mislabel it`] });
          continue;
        }
        const label = readable(chartName).replace(/ (province|district|national|locality|village)$/i, "");
        measureKey = derived(`${a.key} / ${b.key}`, label, chart.action === "percentage");
      } else {
        const pct = [...columns].reverse().find((c) => measures.get(c.key)?.format === "percent");
        const hiddenLabels = new Set(chart.excludedColumns ?? []);
        const visible = columns.filter((c) => !hiddenLabels.has(c.label));
        // A windowed chart leads with a column that has time, when it has one.
        const timed = (c: Column) => {
          const m = measures.get(c.key)!;
          const e = m.derived ? measures.get(operands(parseExpr(m.derived))[0]!)!.entity : m.entity;
          return !!entities[e]?.time;
        };
        const lead = (chart.filterForCurrentDay ? visible.find(timed) : undefined) ?? visible[0] ?? columns[0]!;
        measureKey = chart.chartType === "metric" && chart.valueType === "percentage" && pct ? pct.key : lead.key;
      }
      if (chart.action && !["", "percentage", "division"].includes(chart.action)) notes.push(`action "${chart.action}" not translated`);
      if ((chart.action === "percentage" || chart.action === "division") && order.length < 2) notes.push(`action "${chart.action}" without two aggregation paths; drawn as its columns`);

      // Every other visible column rides along as a further measure.
      const hidden = new Set(chart.excludedColumns ?? []);
      const extraKeys = [...new Set(columns.filter((c) => !hidden.has(c.label)).map((c) => c.key))].filter((k) => k !== measureKey);
      // A metric card is one number; its other paths are that number's operands.
      const drawsMany = chart.chartType === "xtable" || chart.chartType === "table" || chart.chartType === "line";
      const measuresExtra = drawsMany ? extraKeys.slice(0, 11) : [];
      if (!drawsMany && chart.chartType !== "metric" && extraKeys.length) notes.push(`${extraKeys.length} more column(s) available as measures: ${extraKeys.join(", ")}`);
      if (extraKeys.length > 11) notes.push(`${extraKeys.length - 11} column(s) beyond eleven dropped`);
      const bucketLeaf = drawn[0]!.leaf;

      const entity = measures.get(measureKey)!.entity;
      const dateBucket = bucketLeaf.buckets.find((b): b is Extract<Bucket, { kind: "date" }> => b.kind === "date");
      const termBuckets = bucketLeaf.buckets.filter((b): b is Extract<Bucket, { kind: "terms" }> => b.kind === "terms");
      const base = { ...(chart.filterForCurrentDay ? { time: { last: "1d" } } : {}) };
      let query: Query;
      if (dateBucket) {
        const grain = grainOf(dateBucket.interval) ?? "day";
        if (!entities[entity]!.time) {
          entities[entity]!.time = /@timestamp$/.test(dateBucket.field) ? dateBucket.field : { field: dateBucket.field, unit: "epoch_ms" };
          assumptions.push(`${entity}: time is ${dateBucket.field} (from a histogram; no dateRefField)`);
        }
        const t = entities[entity]!.time;
        const timeField = typeof t === "string" ? t : t && "field" in t ? t.field : undefined;
        if (timeField !== dateBucket.field) notes.push(`histogram over ${dateBucket.field}; lenspack buckets by the entity's time (${timeField ?? "none"})`);
        const by = termBuckets[0] ? dimension(entity, termBuckets[0].field) : undefined;
        query = { kind: "series", measure: measureKey, grain, ...(by ? { by } : measuresExtra.length ? { measures: measuresExtra } : {}), ...base };
      } else if (termBuckets.length) {
        const dim = dimension(entity, termBuckets[termBuckets.length - 1]!.field);
        if (termBuckets.length > 1) notes.push(`nested terms: grouped by the innermost (${dim}) only`);
        query = { kind: "breakdown", dimension: dim, measure: measureKey, limit: Math.max(2, Math.min(50, termBuckets.at(-1)!.size ?? 12)), sort: "desc", ...(measuresExtra.length ? { measures: measuresExtra } : {}), ...base };
      } else {
        const compare = chart.insight?.action === "differenceOfNumbers" && chart.filterForCurrentDay;
        query = { kind: "value", measure: measureKey, ...(compare ? { compare: "previous_period" } : {}), ...(measuresExtra.length ? { measures: measuresExtra } : {}), ...base };
        if (chart.insight?.action === "differenceOfNumbers" && !compare) notes.push("insight comparison needs a time window; drawn without it");
      }

      const title = readable(chartName);
      const type = chart.chartType ?? "metric";
      const widget =
        query.kind === "value"
          ? { kind: "kpi", title, query }
          : type === "xtable"
            ? { kind: "table", title, query, pageSize: 10 }
            : { kind: "chart", chart: type === "pie" ? "pie" : query.kind === "series" ? "line" : "bar", title, query };
      const id = slug(chartId, 40);
      const width = widget.kind === "kpi" ? "quarter" : widget.kind === "table" ? "full" : "half";
      const height = widget.kind === "kpi" ? 3 : 8;
      planned.set(chartId, { id, chartId, notes, widget: { op: "add_widget", id, placement: { place: "bottom", width, height }, widget } as unknown as BoardOp });
    } catch (e) {
      outcomes.push({ chart: chartId, status: "skipped", notes: [...notes, e instanceof Error ? e.message : String(e)] });
    }
  }

  // ── Hierarchies, from DSS's drill links ────────────────────────────────
  // A chart grouped by A that drills into a chart grouped by B says B nests
  // in A. The links, counted, become the pack's hierarchies.
  type Q = { kind: string; dimension?: string; by?: string; measure: string; measures?: string[] };
  const queryOf = (p: Planned) => (p.widget as unknown as { widget: { query: Q } }).widget.query;
  const groupOf = (p: Planned) => {
    const q = queryOf(p);
    return q.kind === "breakdown" ? q.dimension : q.kind === "series" ? q.by : undefined;
  };
  const edges = new Map<string, Map<string, number>>();
  const drillsTo = new Map<string, string>(); // chart → chart it drills into
  for (const [chartId, chart] of Object.entries(charts)) {
    const target = chart && typeof chart === "object" ? (chart as DssChart & { drillChart?: string }).drillChart : undefined;
    const a = planned.get(chartId);
    const b = target ? planned.get(target) : undefined;
    if (!a || !b) continue;
    const [da, db] = [groupOf(a), groupOf(b)];
    if (!da || !db || da === db) continue;
    if (!filterable.has(da) || !filterable.has(db)) continue;
    drillsTo.set(chartId, target!);
    const out = edges.get(da) ?? new Map<string, number>();
    out.set(db, (out.get(db) ?? 0) + 1);
    edges.set(da, out);
  }
  // A link is a nesting when it carries a real share of the drills into its
  // target (a category view drilling into a boundary a handful of times is
  // not), and is not mutual (two views flipping between each other).
  const weight = (a: string, b: string) => edges.get(a)?.get(b) ?? 0;
  const targets = new Set([...edges.values()].flatMap((m) => [...m.keys()]));
  const parentOf = new Map<string, string>();
  for (const b of targets) {
    const incoming = [...edges.keys()].map((a) => [a, weight(a, b)] as const).filter(([, w]) => w > 0);
    const max = Math.max(...incoming.map(([, w]) => w));
    const kept = incoming.filter(([a, w]) => (w >= 3 || incoming.length === 1) && w / max > 0.25 && weight(b, a) === 0).sort((x, y) => y[1] - x[1]);
    if (kept[0]) parentOf.set(b, kept[0][0]);
  }
  const childrenOf = new Map<string, string[]>();
  for (const [b, a] of parentOf) childrenOf.set(a, [...(childrenOf.get(a) ?? []), b]);
  const hierarchies: Record<string, string[]> = {};
  const roots = [...childrenOf.keys()].filter((a) => !parentOf.has(a)).sort((x, y) => weight(y, childrenOf.get(y)![0]!) - weight(x, childrenOf.get(x)![0]!));
  for (const root of roots) {
    const chain = [root];
    for (let at = root; ; ) {
      const next = (childrenOf.get(at) ?? []).filter((c) => !chain.includes(c)).sort((x, y) => weight(at, y) - weight(at, x))[0];
      if (!next) break;
      chain.push(next);
      at = next;
    }
    if (chain.length >= 2) hierarchies[Object.keys(hierarchies).length ? `boundary_${Object.keys(hierarchies).length + 1}` : "boundary"] = chain;
  }
  for (const [name, levels] of Object.entries(hierarchies)) assumptions.push(`hierarchy ${name}: ${levels.join(" > ")} (from drill links)`);

  // ── Per-level measures ──────────────────────────────────────────────────
  // A family that differs only in which hierarchy level's rows it reads
  // becomes one measure with levels; every reference to a member follows.
  const levelDim = (m: PackMeasure): string | null => {
    const has = (m.where ?? []).filter((w) => w.op === "exists");
    if (has.length !== 1 || !(m.where ?? []).some((w) => w.op === "missing")) return null;
    const dim = fieldToDim.get(`${m.entity}|${has[0]!.field}`) ?? [...dimensions.values()].find((d) => d.field === has[0]!.field || d.also?.[m.entity]?.field === has[0]!.field)?.key;
    return dim && Object.values(hierarchies).some((ls) => ls.includes(dim)) ? dim : null;
  };
  const replaced = new Map<string, string>(); // member → levels measure
  const families = new Map<string, PackMeasure[]>();
  for (const m of measures.values()) {
    if (m.derived || !levelDim(m)) continue;
    const sig = JSON.stringify([m.entity, m.agg, m.field ?? null, m.scale ?? null, whereSig((m.where ?? []).filter((w) => w.op !== "exists" && w.op !== "missing"))]);
    families.set(sig, [...(families.get(sig) ?? []), m]);
  }
  for (const members of families.values()) {
    // One hierarchy per measure: the one that holds most of the family's levels.
    const hierarchyOfLevel = (l: string) => Object.entries(hierarchies).find(([, ls]) => ls.includes(l))?.[0];
    const counts = new Map<string, number>();
    for (const m of members) counts.set(hierarchyOfLevel(levelDim(m)!)!, (counts.get(hierarchyOfLevel(levelDim(m)!)!) ?? 0) + 1);
    const home = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0];
    const byLevel = new Map<string, PackMeasure>();
    for (const m of members) if (hierarchyOfLevel(levelDim(m)!) === home && !byLevel.has(levelDim(m)!)) byLevel.set(levelDim(m)!, m);
    if (byLevel.size < 2) continue;
    const first = members[0]!;
    let key = first.key.replace(/_at_[a-z0-9_]+$/, "") || first.key;
    for (let i = 2; measures.has(key) || dimensions.has(key); i++) key = `${first.key.replace(/_at_[a-z0-9_]+$/, "")}_${i}`;
    measures.set(key, { key, entity: first.entity, levels: Object.fromEntries([...byLevel].map(([l, m]) => [l, m.key])), label: first.label, format: first.format, synonyms: [], verified: true });
    for (const m of byLevel.values()) replaced.set(m.key, key);
  }
  const follow = (k: string) => replaced.get(k) ?? k;
  for (const m of measures.values()) if (m.derived) m.derived = formatExpr(renameKeys(parseExpr(m.derived), follow));
  // Measures that became the same arithmetic are one measure.
  const byExpr = new Map<string, string>();
  const merged = new Map<string, string>();
  for (const m of [...measures.values()]) {
    if (!m.derived) continue;
    const sig = `${m.derived}|${m.format}`;
    const same = byExpr.get(sig);
    if (same) {
      merged.set(m.key, same);
      measures.delete(m.key);
    } else byExpr.set(sig, m.key);
  }
  const final = (k: string) => merged.get(follow(k)) ?? follow(k);
  for (const m of measures.values()) if (m.derived) m.derived = formatExpr(renameKeys(parseExpr(m.derived), final));
  for (const p of planned.values()) {
    const q = queryOf(p);
    q.measure = final(q.measure);
    if (q.measures) q.measures = [...new Set(q.measures.map(final))].filter((k) => k !== q.measure);
  }

  // ── Drill copies fold into the widget they are reached from ─────────────
  // A chart that is only ever reached by drilling from another, and draws
  // the same number one level down, is that widget drilled: it is not drawn
  // on its own.
  const folded = new Map<string, string>(); // chart → the chart whose widget draws it
  for (const [from, to] of drillsTo) {
    const [a, b] = [planned.get(from)!, planned.get(to)!];
    const levels = Object.values(hierarchies).find((ls) => ls.includes(groupOf(a)!) && ls.includes(groupOf(b)!));
    if (!levels || levels.indexOf(groupOf(b)!) <= levels.indexOf(groupOf(a)!)) continue;
    if (queryOf(a).measure !== queryOf(b).measure) continue;
    let root = from;
    while (folded.has(root)) root = folded.get(root)!;
    if (root !== to) folded.set(to, root);
  }

  // A measure named like a dimension (a DSS label that is also a field name)
  // takes a suffix, and every widget and ratio that names it follows.
  for (const key of [...measures.keys()].filter((k) => dimensions.has(k))) {
    let next = `${key}_n`;
    for (let i = 2; measures.has(next) || dimensions.has(next); i++) next = `${key}_n${i}`;
    const def = measures.get(key)!;
    measures.delete(key);
    measures.set(next, { ...def, key: next });
    for (const [sig, k] of measureBySig) if (k === key) measureBySig.set(sig, next);
    for (const m of measures.values()) if (m.derived) m.derived = formatExpr(renameKeys(parseExpr(m.derived), (k) => (k === key ? next : k)));
    for (const p of planned.values()) {
      const q = (p.widget as unknown as { widget: { query: { measure?: string; measures?: string[] } } }).widget.query;
      if (q.measure === key) q.measure = next;
      if (q.measures) q.measures = q.measures.map((k) => (k === key ? next : k));
    }
  }

  const rawPack = {
    pack: slug(opts.pack ?? "dss"),
    version: 1,
    description: `Compiled from DIGIT DSS chart configs (${Object.keys(charts).length} charts).`,
    entities,
    dimensions: [...dimensions.values()],
    measures: [...measures.values()],
    ...(Object.keys(hierarchies).length ? { hierarchies } : {}),
  };
  const pack = parsePack(rawPack);
  const catalogue = catalogueFrom(pack);

  // Every widget is checked the way an edit is: vocabulary, then resolution
  // against the source's capabilities. What fails is reported, not shipped.
  const accepted = new Map<string, Planned>();
  for (const p of planned.values()) {
    const w = (p.widget as { widget: { query: Query } }).widget;
    try {
      // A further column that cannot be grouped like the headline number is
      // dropped with a note; the widget keeps the rest.
      const q = w.query;
      if (q.kind !== "rows" && q.measures?.length) {
        const ok = q.measures.filter((k) => {
          try {
            check({ ...q, measures: [k] } as Query, pack, { capabilities: caps });
            return true;
          } catch {
            p.notes.push(`column ${k} cannot be grouped the same way; left off`);
            return false;
          }
        });
        (q as { measures?: string[] }).measures = ok.length ? ok : undefined;
      }
      check(w.query, pack, { capabilities: caps });
      const probe = applyOps(emptyBoard(pack, "probe"), [opSchema.parse(p.widget) as BoardOp], catalogue);
      if (!probe.ok) throw new Error(probe.error);
      accepted.set(p.chartId, p);
      const g = groupOf(p);
      const drills = !!g && Object.values(hierarchies).some((ls) => ls.includes(g) && ls.indexOf(g) < ls.length - 1);
      outcomes.push({ chart: p.chartId, status: p.notes.length ? "partial" : "converted", notes: p.notes, widget: p.id, ...(drills ? { drills } : {}) });
    } catch (e) {
      outcomes.push({ chart: p.chartId, status: "skipped", notes: [...p.notes, reason(e)] });
    }
  }

  const filterOps = (): BoardOp[] =>
    [...filterDims].map((field) => ({ op: "add_filter", filter: { id: `filter_${field}`, type: "select", label: readable(field), field, applies: ["*"] } }) as unknown as BoardOp);
  // A drilled-into chart is drawn by the widget it is reached from.
  const drawnBy = (chart: string) => {
    let at = chart;
    while (folded.has(at) && accepted.has(folded.get(at)!)) at = folded.get(at)!;
    return at;
  };
  for (const o of outcomes) {
    const root = drawnBy(o.chart);
    if (root !== o.chart && o.status !== "skipped") o.drilledFrom = accepted.get(root)!.id;
  }
  const board = (id: string, title: string, chartIds: string[]) => {
    const seen = new Set<string>();
    const ops = chartIds
      .map((c) => accepted.get(drawnBy(c)))
      .filter((p): p is Planned => !!p && !seen.has(p.id) && !!seen.add(p.id))
      .map((p) => p.widget);
    return { id: slug(id), title, ops: [...ops, ...filterOps()] };
  };

  const boards = master
    ? master.dashboards.map((d) => board(d.id ?? d.name ?? "board", readable(d.title ?? d.name ?? d.id ?? "Dashboard"), (d.visualizations ?? []).flatMap((v) => v.vizArray ?? []).flatMap((v) => v.charts ?? []).map((c) => c.id)))
    : chunk([...accepted.keys()].filter((c) => drawnBy(c) === c), 16).map((ids, i) => board(`charts_${i + 1}`, `DSS charts ${i + 1}`, ids));

  const packYaml = YAML.stringify(JSON.parse(JSON.stringify(rawPack)), { lineWidth: 0 });
  return { pack, packYaml, boards: boards.filter((b) => b.ops.length > filterDims.size), outcomes, assumptions: [...new Set(assumptions)], report: report(charts, pack, outcomes, [...new Set(assumptions)], leafCount) };
}

function renameKeys(e: MeasureExpr, to: (key: string) => string): MeasureExpr {
  if (e.t === "measure") return { t: "measure", key: to(e.key) };
  if (e.t === "neg") return { t: "neg", arg: renameKeys(e.arg, to) };
  if (e.t === "op") return { ...e, l: renameKeys(e.l, to), r: renameKeys(e.r, to) };
  return e;
}

function reason(e: unknown): string {
  if (e && typeof e === "object" && "issues" in e) return (e as { issues: { path: unknown[]; message: string }[] }).issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return e instanceof ResolveError || e instanceof Error ? e.message : String(e);
}

/** The hierarchy level an `exists A` + `missing B` pair selects: A's name. */
function levelOf(where: Where[]): string | null {
  const has = where.filter((w) => w.op === "exists");
  if (has.length !== 1 || !where.some((w) => w.op === "missing")) return null;
  return slug(has[0]!.field.split(".").pop()!);
}

/** A few words for how one set of predicates differs from another. */
function distinguish(mine: Where[], theirs: Where[]): string {
  const sig = (w: Where) => JSON.stringify([w.field, w.op, w.value ?? null]);
  const other = new Set(theirs.map(sig));
  const words = mine
    .filter((w) => !other.has(sig(w)))
    .slice(0, 2)
    .map((w) => {
      const f = w.field.split(".").pop()!;
      if (w.op === "exists") return `has_${f}`;
      if (w.op === "missing") return `no_${f}`;
      if (w.op === "eq") return String(w.value);
      if (w.op === "neq") return `not_${w.value}`;
      return `${f}_${w.op}`;
    });
  return words.join("_") || "alt";
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function report(charts: Record<string, DssChart>, pack: Pack, outcomes: ChartOutcome[], assumptions: string[], leaves: number): string {
  const by = (s: ChartOutcome["status"]) => outcomes.filter((o) => o.status === s);
  const lines = Object.values(charts)
    .filter((c) => c && Array.isArray(c.queries))
    .reduce((n, c) => n + c.queries.reduce((m, q) => m + String(q.aggrQuery ?? "").split("\n").length, 0), 0);
  // Measures that differ only by the hierarchy level they read.
  const families = new Map<string, string[]>();
  const inLevels = new Set(pack.measures.flatMap((m) => Object.values(m.levels ?? {})));
  for (const m of pack.measures) {
    if (m.derived || inLevels.has(m.key) || !levelOf(m.where ?? [])) continue;
    const rest = JSON.stringify([m.entity, m.agg, m.field ?? null, m.scale ?? null, (m.where ?? []).filter((w) => w.op !== "exists" && w.op !== "missing")]);
    families.set(rest, [...(families.get(rest) ?? []), m.key]);
  }
  const perLevel = [...families.values()].filter((f) => f.length > 1);
  const out = [
    "# DSS → lenspack",
    "",
    `- charts: ${outcomes.length} — converted ${by("converted").length}, partial ${by("partial").length}, skipped ${by("skipped").length}`,
    `- source: ${lines} lines of aggregation JSON, ${leaves} numbers drawn`,
    `- pack: ${Object.keys(pack.entities).length} entities, ${pack.dimensions.length} dimensions, ${pack.measures.length} measures (${pack.measures.filter((m) => m.derived).length} ratios)`,
    "",
    "## Assumptions to check",
    "",
    ...assumptions.map((a) => `- ${a}`),
    "- every dimension is typed string; mark enums, numbers and booleans by hand",
    "- measure keys come from DSS labels; rename them to what people call them",
    "",
    "## Hierarchies and drill-down",
    "",
    ...Object.entries(pack.hierarchies ?? {}).map(([n, ls]) => `- ${n}: ${ls.join(" › ")}`),
    `- ${outcomes.filter((o) => o.drilledFrom).length} charts are the same number one level down: drawn by drilling into the widget they are reached from`,
    `- ${pack.measures.filter((m) => m.levels).length} measures are kept per level (${pack.measures.filter((m) => m.levels).map((m) => m.key).join(", ") || "none"})`,
    "",
    "## Per-level copies left as they are",
    "",
    perLevel.length ? `${perLevel.length} families read a level that is not in a hierarchy; each member stays its own measure:` : "None.",
    "",
    ...perLevel.map((f) => `- ${f.join(", ")}`),
    "",
    "## Partial",
    "",
    ...by("partial").flatMap((o) => [`- **${o.chart}** → \`${o.widget}\``, ...o.notes.map((n) => `  - ${n}`)]),
    "",
    "## Skipped",
    "",
    ...by("skipped").flatMap((o) => [`- **${o.chart}**`, ...o.notes.map((n) => `  - ${n}`)]),
    "",
  ];
  return out.join("\n");
}
