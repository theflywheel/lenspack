import type { Catalogue, Grain } from "./catalogue";
import { type Compute, type ComputeStep, type MeasuredQuery, type Query, measured } from "./schema";

// The rules a compute obeys whatever the data: which steps go where, and what
// the grain is. What depends on the measures themselves (whether a number adds
// up over time) is checked by the engine, which has the pack.

type Problem = { error: string; hint?: string };

/** Steps that read the time buckets: everything but a ratio. */
export const overTime = (step: ComputeStep) => step.op !== "ratio";

/** The time buckets a query's steps run over: a series' own grain, or the one its compute names. */
export function computeGrain(query: MeasuredQuery): Grain | undefined {
  return query.kind === "series" ? query.grain : query.compute?.grain;
}

const ADJECTIVE: Record<Grain, string> = { hour: "hourly", day: "daily", week: "weekly", month: "monthly", quarter: "quarterly", year: "yearly" };
const ON: Record<Grain, string> = { hour: "hour-on-hour", day: "day-on-day", week: "week-on-week", month: "month-on-month", quarter: "quarter-on-quarter", year: "year-on-year" };
export const grainWords = (grain: Grain) => ({ adjective: ADJECTIVE[grain], on: ON[grain], plural: `${grain}s` });

/**
 * What is wrong with a query's compute, in words that say what would work, or
 * null. Structural only, plus what the catalogue tells (keys, percentages).
 */
export function computeProblem(query: Query, catalogue?: Catalogue): Problem | null {
  if (!measured(query) || !query.compute) return null;
  const { steps } = query.compute;
  const timed = steps.some(overTime);
  const kind = query.kind;
  if (kind === "breakdown" && (query.compare || query.share || query.other))
    return { error: "A computed breakdown has no previous period, share or Other row; for a change over time, use the change step", hint: "change" };
  if (kind === "value" && query.compare) return { error: "A computed value has no previous-period comparison; for a change over time, use a series with the change step", hint: "change" };
  if (query.measures?.length) return { error: "Steps apply to one measure; put further measures in a widget of their own", hint: "measures" };
  for (const [i, s] of steps.entries()) {
    if (s.op === "ratio" && i > 0) return { error: "A ratio comes first: it divides the two measures at the query's own grain, before any step over time", hint: "ratio" };
    if (s.op === "over_time" && i < steps.length - 1) return { error: `"${s.fn}" over time collapses the time buckets into one number, so it is the last step`, hint: s.fn };
  }
  const ratio = steps.find((s) => s.op === "ratio");
  if (ratio) {
    if (ratio.to === query.measure) return { error: `A ratio of "${query.measure}" to itself is always 1; name another measure` };
  }
  const last = steps.at(-1)!;
  if (kind === "series") {
    if (last.op === "over_time")
      return { error: `A series keeps its time buckets. For the ${last.fn} of each group over time, ask a breakdown by that dimension (or a value for one number) with the same steps and grain "${query.grain}"`, hint: "breakdown" };
    if (query.compute.grain && query.compute.grain !== query.grain) return { error: `The steps run over the series' own buckets: grain "${query.grain}", not "${query.compute.grain}"`, hint: query.grain };
  } else if (timed) {
    if (!query.compute.grain) return { error: "Steps over time need a grain: the time buckets they run over, e.g. day for a daily average", hint: "day" };
    if (last.op !== "over_time")
      return { error: `A ${kind} shows one number${kind === "breakdown" ? " per group" : ""}, so steps over time end with a summary of the buckets: mean, sum, min, max, median or last. For the buckets themselves, ask a series`, hint: "mean" };
    if (kind === "breakdown" && query.by) return { error: "A breakdown with steps over time groups by one dimension; drop the split, or ask a series split by it", hint: "series" };
  } else if (query.compute.grain) {
    return { error: "A ratio alone is computed per group, not per time bucket, so it takes no grain; drop the grain, or add a step over time" };
  }
  // A percentage is never added up: not over time, not into a running total.
  if (catalogue?.measures.find((m) => m.key === query.measure)?.format === "percent" && !ratio) {
    const adds = steps.find((s) => s.op === "running_total" || (s.op === "rolling" && s.fn === "sum") || (s.op === "over_time" && s.fn === "sum"));
    if (adds) return { error: `"${query.measure}" is a percentage, and percentages are never added up; use mean instead`, hint: "mean" };
  }
  return null;
}

/** The steps in a few words, for the board summary: "→ % change per day, then mean". */
export function describeCompute(query: MeasuredQuery): string {
  const c: Compute | undefined = query.compute;
  if (!c) return "";
  const grain = computeGrain(query);
  const words = c.steps.map((s) => {
    switch (s.op) {
      case "ratio":
        return `over ${s.to}${s.percent ? " (%)" : ""}`;
      case "change":
        return `${s.percent ? "% " : ""}change${grain ? ` per ${grain}` : ""}`;
      case "rolling":
        return `rolling ${s.fn} of ${s.window} ${grain ? `${grain}s` : "buckets"}`;
      case "running_total":
        return "running total";
      case "over_time":
        return `${s.fn} over ${grain ? `${grain}s` : "time"}`;
    }
  });
  return ` → ${words.join(", then ")}`;
}
