import { type BoardOp, type Query, applyOps, emptyBoard, opSchema } from "@lenspack/core";
import { type Capabilities, ResolveError, check } from "@lenspack/engine";
import { type Pack, type PackDimension, type PackMeasure, type Where, catalogueFrom, parsePack } from "@lenspack/spec";
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
};
export type DssMaster = { dashboards: { name?: string; id?: string; title?: string; visualizations?: { vizArray?: { name?: string; charts?: { id: string }[] }[] }[] }[] };

export type DssOptions = {
  pack?: string;
  /** Values DSS substitutes from the request (e.g. "PVAR"); each becomes a board filter. */
  placeholders?: string[];
  /** The engine the boards are checked against. Defaults to a search index: no joins. */
  capabilities?: Capabilities;
};

export type ChartOutcome = { chart: string; status: "converted" | "partial" | "skipped"; notes: string[]; widget?: string };

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

  const ratio = (num: string, den: string, label: string, percent: boolean): string => {
    const sig = JSON.stringify(["ratio", num, den]);
    const known = measureBySig.get(sig);
    if (known) return known;
    let key = slug(label);
    for (let i = 2; measures.has(key) || dimensions.has(key); i++) key = `${slug(label)}_${i}`;
    measures.set(key, { key, entity: measures.get(num)!.entity, derived: `${num} / ${den}`, label, format: percent ? "percent" : "number", synonyms: [], verified: true });
    measureBySig.set(sig, key);
    return key;
  };

  type Planned = { id: string; chartId: string; widget: BoardOp; notes: string[] };
  let leafCount = 0;
  const planned = new Map<string, Planned>();

  for (const [chartId, chart] of Object.entries(charts)) {
    const notes: string[] = [];
    const chartName = chart.chartName ?? chartId;
    try {
      const perQuery = chart.queries.map((q) => {
        const entity = entityFor(q);
        try {
          for (const [k, f] of Object.entries(JSON.parse(q.requestQueryMap || "{}") as Record<string, string>)) dimension(entity, f, k);
        } catch {
          notes.push("requestQueryMap is not JSON");
        }
        const walked = walk(q.aggrQuery, placeholders);
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
      if (drawn.length === 0) {
        outcomes.push({ chart: chartId, status: "skipped", notes: notes.length ? notes : ["no aggregation lenspack can read"] });
        continue;
      }

      const keyOf = ({ entity, leaf }: { entity: string; leaf: Leaf }): string => {
        if (!leaf.ratio) return measure(entity, leaf, chartName);
        const n = measure(entity, leaf.ratio.numerator, chartName);
        const d = measure(entity, leaf.ratio.denominator, chartName);
        return ratio(n, d, name(leaf, chartName), leaf.ratio.percent);
      };

      // A two-number percentage (action: percentage, or a percentage computed
      // field) is a ratio; its operands may live on two indexes.
      const pct = chart.computedFields?.find((c) => c.actionName === "PercentageComputedField" && c.fields?.length === 2);
      // Percentages name their operands by the aliases additive fields create.
      const alias = new Map((chart.computedFields ?? []).filter((c) => c.actionName === "AdditiveComputedField" && c.fields?.length === 1).map((c) => [c.newField!, c.fields![0]!]));
      if ((chart.action === "percentage" || pct) && drawn.length < 2) {
        outcomes.push({ chart: chartId, status: "skipped", notes: [...notes, "a percentage whose operands did not both translate; drawing one of them alone would mislabel it"] });
        continue;
      }
      let measureKey: string;
      let bucketLeaf = drawn[0]!.leaf;
      if ((chart.action === "percentage" || pct) && drawn.length >= 2) {
        const pick = (label?: string) => (label ? drawn.find((d) => d.leaf.path.includes(alias.get(label) ?? label)) : undefined);
        const num = pick(pct?.fields?.[0]) ?? drawn[0]!;
        const den = pick(pct?.fields?.[1]) ?? drawn[1]!;
        measureKey = ratio(keyOf(num), keyOf(den), pct?.newField ?? readable(chartName).replace(/ (province|district|national|locality|village)$/i, ""), true);
        bucketLeaf = num.leaf;
        if (drawn.length > 2) notes.push(`${drawn.length - 2} more column(s) not drawn: ${drawn.slice(2).map((d) => keyOf(d)).join(", ")}`);
      } else {
        // One number per widget; a multi-column table keeps its first column
        // and the rest become measures the board can add.
        const extra = drawn.slice(1).map(keyOf);
        measureKey = keyOf(drawn[0]!);
        if (extra.length) notes.push(`${extra.length} more column(s) available as measures: ${extra.join(", ")}`);
      }
      for (const c of chart.computedFields ?? []) if (c.actionName && !["AdditiveComputedField", "PercentageComputedField"].includes(c.actionName)) notes.push(`computed field ${c.actionName} not translated`);
      if (chart.action && !["", "percentage"].includes(chart.action)) notes.push(`action "${chart.action}" not translated`);

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
        query = { kind: "series", measure: measureKey, grain, ...(by ? { by } : {}), ...base };
      } else if (termBuckets.length) {
        const dim = dimension(entity, termBuckets[termBuckets.length - 1]!.field);
        if (termBuckets.length > 1) notes.push(`nested terms: grouped by the innermost (${dim}) only`);
        query = { kind: "breakdown", dimension: dim, measure: measureKey, limit: Math.max(2, Math.min(50, termBuckets.at(-1)!.size ?? 12)), sort: "desc", ...base };
      } else {
        const compare = chart.insight?.action === "differenceOfNumbers" && chart.filterForCurrentDay;
        query = { kind: "value", measure: measureKey, ...(compare ? { compare: "previous_period" } : {}), ...base };
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

  const rawPack = {
    pack: slug(opts.pack ?? "dss"),
    version: 1,
    description: `Compiled from DIGIT DSS chart configs (${Object.keys(charts).length} charts).`,
    entities,
    dimensions: [...dimensions.values()],
    measures: [...measures.values()],
  };
  const pack = parsePack(rawPack);
  const catalogue = catalogueFrom(pack);

  // Every widget is checked the way an edit is: vocabulary, then resolution
  // against the source's capabilities. What fails is reported, not shipped.
  const accepted = new Map<string, Planned>();
  for (const p of planned.values()) {
    const w = (p.widget as { widget: { query: Query } }).widget;
    try {
      check(w.query, pack, { capabilities: caps });
      const probe = applyOps(emptyBoard(pack, "probe"), [opSchema.parse(p.widget) as BoardOp], catalogue);
      if (!probe.ok) throw new Error(probe.error);
      accepted.set(p.chartId, p);
      outcomes.push({ chart: p.chartId, status: p.notes.length ? "partial" : "converted", notes: p.notes, widget: p.id });
    } catch (e) {
      outcomes.push({ chart: p.chartId, status: "skipped", notes: [...p.notes, reason(e)] });
    }
  }

  const filterOps = (): BoardOp[] =>
    [...filterDims].map((field) => ({ op: "add_filter", filter: { id: `filter_${field}`, type: "select", label: readable(field), field, applies: ["*"] } }) as unknown as BoardOp);
  const board = (id: string, title: string, chartIds: string[]) => {
    const seen = new Set<string>();
    const ops = chartIds
      .map((c) => accepted.get(c))
      .filter((p): p is Planned => !!p && !seen.has(p.id) && !!seen.add(p.id))
      .map((p) => p.widget);
    return { id: slug(id), title, ops: [...ops, ...filterOps()] };
  };

  const boards = master
    ? master.dashboards.map((d) => board(d.id ?? d.name ?? "board", readable(d.title ?? d.name ?? d.id ?? "Dashboard"), (d.visualizations ?? []).flatMap((v) => v.vizArray ?? []).flatMap((v) => v.charts ?? []).map((c) => c.id)))
    : chunk([...accepted.keys()], 16).map((ids, i) => board(`charts_${i + 1}`, `DSS charts ${i + 1}`, ids));

  const packYaml = YAML.stringify(JSON.parse(JSON.stringify(rawPack)), { lineWidth: 0 });
  return { pack, packYaml, boards: boards.filter((b) => b.ops.length > filterDims.size), outcomes, assumptions: [...new Set(assumptions)], report: report(charts, pack, outcomes, [...new Set(assumptions)], leafCount) };
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
  const lines = Object.values(charts).reduce((n, c) => n + c.queries.reduce((m, q) => m + q.aggrQuery.split("\n").length, 0), 0);
  // Measures that differ only by the hierarchy level they read.
  const families = new Map<string, string[]>();
  for (const m of pack.measures) {
    if (m.derived || !levelOf(m.where ?? [])) continue;
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
    "## Per-level copies",
    "",
    perLevel.length
      ? `${perLevel.reduce((n, f) => n + f.length, 0)} measures are ${perLevel.length} numbers read at different hierarchy levels. If the finest level is complete, one entity filtered to it (and grouped upward by dimension) replaces each family with a single measure — a modelling decision, so it is left to you:`
      : "None.",
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
