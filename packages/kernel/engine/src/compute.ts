import { type ComputeStep, type Grain, type MeasureNature as Nature, type MeasuredQuery, type Query, computeGrain, computeProblem, grainWords, overTime } from "@lenspack/core";
import { type Pack, natureOf } from "@lenspack/pack";

import { bucketZone, localWallClock } from "./calendar";
import { type DataRow, type Format, MAX_SERIES, SPLIT_ROWS, type WidgetData, limitGroups, sortGroups, sortSeries } from "./data";
import { ResolveError, type TimeWindow } from "./resolve";

// Arithmetic on aggregated answers. The source answers the query at its base
// grain (a measure per group and time bucket); the steps here turn those
// numbers into changes, rolling windows, running totals, ratios and averages.
// Plain arithmetic in one place, so every source gets the same answer, and the
// rules for zeros and gaps are written once (docs/compute.md).

/** Numbers a source may return for one computed query: groups × time buckets. */
export const COMPUTE_ROWS = 20_000;
// Time buckets × groups the steps run over, gaps included.
const GRID_CELLS = 200_000;

const labelOf = (pack: Pack, key: string) => (pack.measures.find((m) => m.key === key)?.label ?? key.replace(/_/g, " ")).toLowerCase();

/** The refusal for a compute that cannot be done on this pack, or null: core's rules, told the measure's nature. */
export function computeRefusal(query: Query, pack: Pack): ResolveError | null {
  if (!("compute" in query) || !query.compute) return null;
  const format = pack.measures.find((m) => m.key === query.measure)?.format;
  const problem = computeProblem(query, { format: format ?? "number", nature: natureOf(pack, query.measure) });
  return problem ? new ResolveError("NOT_SUPPORTED", problem.error, query.measure, problem.hint) : null;
}

type Breakdown = Extract<Query, { kind: "breakdown" }>;

/**
 * The query the source answers for a computed one: the same measure, window
 * and filters at the base grain. A ratio brings its second measure along.
 * Every group comes back (the steps decide which groups are shown). `read` is
 * the window to read when it is wider than the query's own (readWindow).
 */
export function computeBase(query: MeasuredQuery, read?: TimeWindow | null): Query {
  const steps = query.compute!.steps;
  const ratio = steps.find((s) => s.op === "ratio");
  const time = read ? { time: { from: read.from.toISOString(), to: read.to.toISOString() } } : query.time ? { time: query.time } : {};
  const common = { measure: query.measure, ...(ratio ? { measures: [ratio.to] } : {}), ...time, ...(query.filters ? { filters: query.filters } : {}) };
  const grain = computeGrain(query);
  if (!steps.some(overTime) || !grain) {
    if (query.kind === "breakdown") return { kind: "breakdown", dimension: query.dimension, ...(query.by ? { by: query.by } : {}), limit: SPLIT_ROWS, sort: "desc", ...common };
    if (query.kind === "value") return { kind: "value", ...common };
  }
  const by = query.kind === "breakdown" ? query.dimension : query.kind === "series" ? query.by : undefined;
  return { kind: "series", grain: grain ?? "day", ...(by ? { by } : {}), ...common };
}

// ---- time buckets -------------------------------------------------------------

const label = (ms: number, grain: Grain) => (grain === "hour" ? `${new Date(ms).toISOString().slice(0, 13)}:00` : new Date(ms).toISOString().slice(0, 10));

/** The start of the bucket holding a wall-clock instant (written as UTC), weeks from Monday. */
function bucketStart(ms: number, grain: Grain): number {
  const d = new Date(ms);
  const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  switch (grain) {
    case "hour":
      return Math.floor(ms / 3600e3) * 3600e3;
    case "day":
      return Date.UTC(y, m, day);
    case "week":
      return Date.UTC(y, m, day - ((d.getUTCDay() + 6) % 7));
    case "month":
      return Date.UTC(y, m, 1);
    case "quarter":
      return Date.UTC(y, m - (m % 3), 1);
    case "year":
      return Date.UTC(y, 0, 1);
  }
}

function nextBucket(ms: number, grain: Grain): number {
  const d = new Date(ms);
  if (grain === "hour") return ms + 3600e3;
  if (grain === "day" || grain === "week") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (grain === "week" ? 7 : 1));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + { month: 1, quarter: 3, year: 12 }[grain], 1);
}

/** The same instant one bucket earlier, on the local calendar: a month back from 31 March is 28 or 29 February. */
function bucketBack(ms: number, grain: Grain, timeZone?: string): number {
  const zone = bucketZone(timeZone);
  const wall = zone ? localWallClock(ms, zone) : ms;
  const d = new Date(wall);
  const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  const clock = wall - Date.UTC(y, m, day);
  let back: number;
  if (grain === "hour") back = wall - 3600e3;
  else if (grain === "day" || grain === "week") back = Date.UTC(y, m, day - (grain === "week" ? 7 : 1)) + clock;
  else {
    const to = m - { month: 1, quarter: 3, year: 12 }[grain];
    back = Date.UTC(y, to, Math.min(day, new Date(Date.UTC(y, to + 1, 0)).getUTCDate())) + clock;
  }
  if (!zone) return back;
  // From local wall-clock time back to the instant; twice, to settle a daylight-saving change.
  let at = back;
  for (let i = 0; i < 2; i++) at -= localWallClock(at, zone) - back;
  return at;
}

/**
 * A wider window for the source to read, or null for the query's own: when a
 * step changes from the bucket before, the window starts one bucket earlier,
 * so its first bucket has a bucket to change from, as Superset's time
 * comparison reads it.
 */
export function readWindow(query: MeasuredQuery, own: TimeWindow | null, timeZone?: string): TimeWindow | null {
  const grain = computeGrain(query);
  if (!own || !grain || !query.compute?.steps.some((s) => s.op === "change")) return null;
  return { from: new Date(bucketBack(own.from.getTime(), grain, timeZone)), to: own.to };
}

const parseLabel = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s.replace(":00", ":00:00")}Z`);

/**
 * Every bucket from the window's first to its last, in the pack's time zone,
 * as the sources label them; with no window, from the first bucket answered
 * to the last. A bucket with no records is in the list all the same.
 */
export function bucketsOf(seen: string[], grain: Grain, window: TimeWindow | null, timeZone?: string): string[] {
  const zone = bucketZone(timeZone);
  const wall = (d: Date) => (zone ? localWallClock(d.getTime(), zone) : d.getTime());
  const known = seen.map(parseLabel).filter((n) => Number.isFinite(n));
  const ends = window ? [bucketStart(wall(window.from), grain), bucketStart(wall(new Date(window.to.getTime() - 1)), grain)] : [];
  const all = [...ends, ...known];
  if (!all.length) return [];
  const [from, to] = [Math.min(...all), Math.max(...all)];
  const out: string[] = [];
  for (let t = from; t <= to; t = nextBucket(t, grain)) {
    out.push(label(t, grain));
    if (out.length > GRID_CELLS) break;
  }
  return out;
}

// ---- the steps ------------------------------------------------------------------

type Cell = number | null;

const divide = (a: Cell, b: Cell): Cell => (a === null || b === null || b === 0 ? null : a / b);

/**
 * One step over one group's buckets. `start` is the first bucket still shown;
 * `lead` is 1 when the first bucket was read only for a change to start from.
 */
function step(s: ComputeStep, values: Cell[], start: number, lead: number): { values: Cell[]; start: number } {
  switch (s.op) {
    case "change":
      // Against the bucket just before (for the first one shown, the bucket read before the
      // window, if any); none from a gap, none from 0 as a percentage.
      return {
        start,
        values: values.map((v, i) => {
          const prev = i > start || (lead > 0 && i === lead) ? values[i - 1]! : null;
          if (v === null || prev === null) return null;
          return s.percent ? divide(v - prev, Math.abs(prev)) : v - prev;
        }),
      };
    case "rolling": {
      // A full window of buckets, all with a value, or nothing; the first window-1 are left out.
      const out = values.map((_, i) => {
        if (i < start + s.window - 1) return null;
        const w = values.slice(i - s.window + 1, i + 1);
        if (w.some((v) => v === null)) return null;
        const total = (w as number[]).reduce((a, b) => a + b, 0);
        return s.fn === "mean" ? total / s.window : total;
      });
      return { values: out, start: start + s.window - 1 };
    }
    case "running_total": {
      let total: number | null = null;
      return { start, values: values.map((v, i) => (i < start ? null : v === null ? total : (total = (total ?? 0) + v))) };
    }
    default:
      return { values, start };
  }
}

/** A group's buckets as one number; buckets without a value are skipped. */
function summary(fn: Extract<ComputeStep, { op: "over_time" }>["fn"], values: Cell[]): Cell {
  const vs = values.filter((v): v is number => v !== null);
  if (!vs.length) return null;
  switch (fn) {
    case "mean":
      return vs.reduce((a, b) => a + b, 0) / vs.length;
    case "sum":
      return vs.reduce((a, b) => a + b, 0);
    case "min":
      return Math.min(...vs);
    case "max":
      return Math.max(...vs);
    case "last":
      return vs.at(-1)!;
    case "median": {
      const sorted = [...vs].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    }
  }
}

const too = (what: string, grain: Grain | undefined) =>
  new ResolveError(
    "NOT_SUPPORTED",
    `This needs ${what}: more than ${COMPUTE_ROWS.toLocaleString("en")} numbers from the source. Narrow the time range, use a coarser grain${grain === "day" || grain === "hour" ? ` (${grain === "hour" ? "day" : "week"} instead of ${grain})` : ""}, or filter to fewer groups`,
  );

/**
 * The computed answer from the base query's answer, over the window the base
 * read (readWindow). Throws ResolveError when the base was cut at the row
 * limit, or holds too few buckets for a window.
 */
export function applyCompute(query: MeasuredQuery, base: WidgetData, pack: Pack, window: TimeWindow | null): WidgetData {
  const steps = query.compute!.steps;
  const grain = computeGrain(query);
  const ratio = steps.find((s): s is Extract<ComputeStep, { op: "ratio" }> => s.op === "ratio");
  const timed = steps.some(overTime) && !!grain;
  const nature = natureOf(pack, query.measure);
  const empty = (n: Nature) => (n === "level" ? null : 0);
  // A count or sum the source left empty (SQL's SUM of no rows) is 0, as a search engine says.
  const cell = (v: number | null | undefined, n: Nature): Cell => (v === null || v === undefined ? empty(n) : v);
  const toNature = ratio ? natureOf(pack, ratio.to) : "level";
  const first = (r: DataRow): Cell => (ratio ? divide(cell(r.value, nature), cell(r.values?.[ratio.to], toNature)) : r.value);
  const { label: name, text } = describeComputed(query, pack);
  const format: Format = ratio ? (ratio.percent ? "percent" : "number") : base.format;
  const outFormat: Format = steps.some((s) => s.op === "change" && s.percent) ? "percent" : format;
  const out = (rows: DataRow[], notes?: string[]): WidgetData => ({
    rows,
    total: rows.reduce((n, r) => n + r.count, 0),
    format: outFormat,
    label: name,
    computed: text,
    ...(base.approximate ? { approximate: true } : {}),
    ...(notes?.length || base.notes?.length ? { notes: [...(base.notes ?? []), ...(notes ?? [])] } : {}),
  });

  if (!timed) {
    // A ratio alone: per row, as the source grouped it.
    if (query.kind === "breakdown" ? base.rows.length >= SPLIT_ROWS : base.rows.length > COMPUTE_ROWS) throw too(`every ${query.kind === "breakdown" ? query.dimension : "group"}`, grain);
    const rows = base.rows.map((r): DataRow => {
      const { values: _values, compare: _compare, ...rest } = r;
      return { ...rest, value: first(r) };
    });
    if (query.kind === "breakdown") return out(limitGroups(sortGroups(rows, query as Breakdown), query as Breakdown));
    if (query.kind === "series") return topSeries(query, out, rows, base.rows);
    return out(rows.slice(0, 1).map((r) => ({ ...r, group: query.measure })));
  }

  if (base.rows.length > COMPUTE_ROWS) throw too(`the measure for every ${query.kind === "breakdown" ? `${query.dimension} and ` : query.kind === "series" && query.by ? `${query.by} and ` : ""}${grain}`, grain);
  const buckets = bucketsOf(base.rows.map((r) => r.group), grain!, window, pack.timeZone);
  // The bucket read before the window for a change is not shown, counted or ranked.
  const lead = window && steps.some((s) => s.op === "change") ? 1 : 0;
  const keys = [...new Set(base.rows.map((r) => r.series ?? ""))];
  if (buckets.length * Math.max(1, keys.length) > GRID_CELLS) throw too(`${buckets.length.toLocaleString("en")} ${grain}s for each of ${keys.length} groups`, grain);
  const rolling = steps.find((s): s is Extract<ComputeStep, { op: "rolling" }> => s.op === "rolling");
  if (rolling && buckets.length - lead < rolling.window)
    throw new ResolveError("NOT_SUPPORTED", `A ${rolling.window}-${grain} rolling ${rolling.fn === "mean" ? "average" : "sum"} needs at least ${rolling.window} ${grain}s, and this window has ${buckets.length - lead}. Widen the time range or shorten the window`, query.measure);
  const index = new Map(buckets.map((b, i) => [b, i]));
  const shown = base.rows.filter((r) => (index.get(r.group) ?? lead) >= lead);
  const byKey = new Map<string, DataRow[]>();
  for (const r of base.rows) byKey.set(r.series ?? "", [...(byKey.get(r.series ?? "") ?? []), r]);

  const groups = keys.map((key) => {
    const rows = byKey.get(key)!;
    const counts = buckets.map(() => 0);
    // Every bucket of the window: an empty one is 0 for a count or a sum, no value otherwise.
    let values: Cell[] = buckets.map(() => (ratio ? divide(empty(nature), empty(toNature)) : empty(nature)));
    for (const r of rows) {
      const i = index.get(r.group);
      if (i === undefined) continue;
      values[i] = ratio ? first(r) : cell(r.value, nature);
      counts[i] = r.count;
    }
    let start = lead;
    for (const s of steps) ({ values, start } = step(s, values, start, lead));
    return { key, values, counts, start };
  });

  const last = steps.at(-1)!;
  if (last.op === "over_time") {
    const rows: DataRow[] = groups.map((g) => ({ group: g.key, value: summary(last.fn, g.values.slice(g.start)), count: g.counts.slice(lead).reduce((a, b) => a + b, 0) }));
    if (query.kind === "value") return out([{ group: query.measure, value: rows[0]?.value ?? null, count: rows[0]?.count ?? 0 }]);
    return out(limitGroups(sortGroups(rows, query as Breakdown), query as Breakdown));
  }
  // A series: each group's buckets from the first one still shown.
  const split = query.kind === "series" && !!query.by;
  const rows: DataRow[] = groups.flatMap((g) =>
    buckets.slice(g.start).map((b, j) => ({ group: b, ...(split ? { series: g.key } : {}), value: g.values[g.start + j]!, count: g.counts[g.start + j]! })),
  );
  return topSeries(query, out, sortSeries(rows), shown);
}

// A split series keeps its top series, ranked by the base measure's total (the
// groups with the most of it), as a plain series would be.
function topSeries(query: MeasuredQuery, out: (rows: DataRow[], notes?: string[]) => WidgetData, rows: DataRow[], base: DataRow[]): WidgetData {
  if (query.kind !== "series" || !query.by) return out(rows);
  const totals = new Map<string, number>();
  for (const r of base) totals.set(r.series!, (totals.get(r.series!) ?? 0) + (r.value ?? 0));
  const keep = new Set([...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_SERIES).map(([k]) => k));
  const shown = rows.filter((r) => keep.has(r.series!));
  return out(shown, totals.size > keep.size ? [`top ${keep.size} of ${totals.size} series by total ${query.measure}; ${totals.size - keep.size} left out`] : undefined);
}

// ---- in words -----------------------------------------------------------------------

const SUMMARY_WORD = { mean: "average", sum: "total", min: "lowest", max: "highest", median: "median", last: "latest" } as const;

/**
 * What a computed query shows, as a name ("average day-on-day % change in
 * units dispatched") and the rules it followed in plain words, for the chart
 * label, the tool output and explain.
 */
export function describeComputed(query: MeasuredQuery, pack: Pack): { label: string; text: string } {
  const steps = query.compute?.steps ?? [];
  const grain = computeGrain(query) ?? "day";
  const { adjective, on, plural } = grainWords(grain);
  const nature = natureOf(pack, query.measure);
  let name = labelOf(pack, query.measure);
  let plain = true;
  const rules: string[] = [];
  if (steps.some(overTime)) rules.push(nature === "level" ? `a ${grain} with no records has no value and is skipped` : `a ${grain} with no records counts as 0`);
  let gaps = nature === "level";
  for (const s of steps) {
    switch (s.op) {
      case "ratio":
        name = s.percent ? `${name} as a share of ${labelOf(pack, s.to)}` : `${name} per ${labelOf(pack, s.to)}`;
        rules.push(`where ${labelOf(pack, s.to)} is 0 or missing, the ratio is skipped`);
        gaps = true;
        break;
      case "change":
        name = `${on} ${s.percent ? "% " : ""}change in ${name}`;
        rules.push(query.time ? `the first ${grain} changes from the ${grain} before the time range` : `the first ${grain} has no ${grain} before it, so it has no change`);
        if (s.percent) rules.push(`a change from 0 has no percentage and is skipped`);
        gaps = true;
        break;
      case "rolling":
        name = `${s.window}-${grain} rolling ${s.fn === "mean" ? "average" : "sum"} of ${name}`;
        rules.push(`the first ${s.window - 1} ${s.window === 2 ? grain : plural} are left out (no full window)${gaps ? `, as is a window with a ${grain} missing` : ""}`);
        break;
      case "running_total":
        name = `running total of ${name}`;
        rules.push(`counted from the first ${grain} shown${gaps ? `; a ${grain} without a value adds nothing` : ""}`);
        gaps = false;
        break;
      case "over_time":
        name = s.fn === "sum" ? `${name}, added up over the ${plural}` : plain ? `${SUMMARY_WORD[s.fn]} ${adjective} ${name}` : `${SUMMARY_WORD[s.fn]} ${name}`;
        if (gaps) rules.push(`${plural} without a value are skipped in the ${SUMMARY_WORD[s.fn] === "total" ? "total" : SUMMARY_WORD[s.fn]}`);
        break;
    }
    if (s.op !== "ratio") plain = false;
  }
  return { label: name, text: `${name}${rules.length ? `: ${rules.join("; ")}` : ""}` };
}
