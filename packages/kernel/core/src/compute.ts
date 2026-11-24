import type { CatalogueMeasure, Grain } from "./catalogue";
import { type Compute, type ComputeStep, type MeasuredQuery, type Problem, type Query, measured } from "./schema";

// The rules a compute obeys: which steps go where, what the grain is, and what
// may be added up. A board check and the engine both ask computeProblem, each
// passing what it knows of the measure (the catalogue's entry, or the pack's).

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
 * null. `measure` is the query's measure as the catalogue or the pack describes
 * it; without its nature, only what the steps themselves make of it is checked.
 */
export function computeProblem(query: Query, measure?: Pick<CatalogueMeasure, "format" | "nature"> | null): Problem | null {
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
  return addingProblem(query, measure);
}

/**
 * The never-add-up rule (docs/compute.md): a sum over time, a rolling sum or a
 * running total only of numbers that add up. A count or a sum does, and so does
 * a plain change of one; a percentage, an average, a distinct count, a ratio, a
 * % change, a rolling window or a running total does not.
 */
function addingProblem(query: MeasuredQuery, measure?: Pick<CatalogueMeasure, "format" | "nature"> | null): Problem | null {
  const name = `"${query.measure}"`;
  // What the numbers are before each step, and why they stopped adding up. Unknown: no refusal on the measure's own account.
  let nature = measure?.format === "percent" ? "percent" : measure?.nature;
  let why = "";
  for (const s of query.compute!.steps) {
    const adding = s.op === "running_total" || (s.op === "rolling" && s.fn === "sum") || (s.op === "over_time" && s.fn === "sum");
    if (adding && nature !== undefined && nature !== "adds") {
      const alternative = s.op === "running_total" ? "Use last for the latest value, or mean for the average" : "Use mean (or min, max, median) instead";
      const reason =
        why ||
        (nature === "distinct"
          ? `${name} is a distinct count: one key seen on two ${grainWords(computeGrain(query) ?? "day").plural} would count twice, so it is not added up over time (ask for it over the whole window, without steps, for the distinct count of the period)`
          : nature === "percent"
            ? `${name} is a percentage, and a percentage is never added up`
            : `${name} is an average or another level (not a count or a sum), which does not add up over time`);
      return { error: `${reason}. ${alternative}`, hint: "mean" };
    }
    if (s.op === "ratio") [nature, why] = ["level", "A ratio is never added up"];
    else if (s.op === "change") [nature, why] = s.percent ? ["level", "A percentage change is never added up"] : ["adds", ""];
    else if (s.op === "rolling") [nature, why] = ["level", s.fn === "mean" ? "A rolling average is never added up" : "A rolling sum is not added up again: every record would count several times"];
    else if (s.op === "running_total") [nature, why] = ["level", "A running total is not added up again"];
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
