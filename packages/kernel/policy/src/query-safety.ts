import type { Grain, Query } from "@lenspack/core";
import type { Pack } from "@lenspack/pack";

// Query safety: which queries are too heavy to send to the database, as pure functions of the query's shape and the
// deployment's limits. The model never writes SQL, but the queries it can ask for still differ in cost a thousandfold:
// a breakdown by a per-record column makes the database build one group per record, an hourly series over
// a year draws 8,760 points, and a question with no time range over a table of visits reads every visit ever made.
// These limits refuse such a query with a message the assistant can act on ("pick a coarser level"), before
// anything reaches the database. Hosts apply them (the engine's guardedConnector); the database user's own limits
// remain the guarantee (docs/operating/query-safety.md).

/** The limits on one query. Each dataset may have its own (a large one marked heavy gets HEAVY_LIMITS). */
export type QueryLimits = {
  /** The most rows one query may return. A series or a split breakdown is cut to it (and says so); a list or top N asking for more is refused. */
  maxRows: number;
  /** The most groups a breakdown may make, as far as the groups' counts are known (cardinality): a breakdown times its split. */
  maxGroups: number;
  /** The most points a series may draw: its time buckets (the range over the grain) times its series, when known. */
  maxSeriesPoints: number;
  /** The longest time range one query may read, in days. null: any. */
  maxWindowDays: number | null;
  /** Every query must have a time range (on a dataset with a time column). */
  requireTime: boolean;
  /** With requireTime, a question with no time range reads this many days up to now (and says so) instead of being refused. null: refused. */
  defaultWindowDays: number | null;
};

/** What applies to the whole server, not to one dataset. */
export type ServerLimits = {
  /** The most queries one chat turn may send: one question cannot fan out into hundreds. */
  maxQueriesPerTurn: number;
  /** How long Lenspack waits for one query's answer, in seconds. Superset's chart-data API takes no timeout of its own, so the database user's limit is what stops the query itself. */
  timeoutSeconds: number;
  /** Queries this server sends at once, across every user (per copy of the server). More wait their turn. */
  maxConcurrent: number;
};

/** One dataset's own settings, by entity key. */
export type DatasetSafety = Partial<QueryLimits> & {
  /** A large, row-level dataset (one row per visit, per record): HEAVY_LIMITS apply, then this entry's own. */
  heavy?: boolean;
  /** Columns or dimension keys with a value for (almost) every record: never grouped by. */
  highCardinality?: string[];
  /** About how many values a dimension has (by key or column), for the group and point counts. */
  cardinality?: Record<string, number>;
};

/** The settings as a deployment writes them (superset.yaml querySafety:) and as an admin changes them. */
export type QuerySafetyConfig = Partial<QueryLimits> &
  Partial<ServerLimits> & {
    /** The limits a dataset marked heavy starts from, over HEAVY_LIMITS. */
    heavy?: Partial<QueryLimits>;
    /** Per dataset, by entity key (the host maps a dataset's id or table name to it). */
    datasets?: Record<string, DatasetSafety>;
  };

/** The settings in force: every field set. */
export type QuerySafety = { limits: QueryLimits; server: ServerLimits; heavy: QueryLimits; datasets: Record<string, DatasetSafety> };

/**
 * The defaults: on, and chosen so no answer changes. 20,000 rows is the engine's own largest cap (a series), and a
 * series past 20,000 points was already cut to its latest buckets. Groups are counted only where a deployment says
 * how many values a dimension has, so nothing is refused until it does. 100 queries a turn is several times what a
 * long answer sends; 30 seconds is how long Lenspack already waited for Superset.
 */
export const QUERY_LIMITS: QueryLimits = { maxRows: 20_000, maxGroups: 100_000, maxSeriesPoints: 20_000, maxWindowDays: null, requireTime: false, defaultWindowDays: null };
export const SERVER_LIMITS: ServerLimits = { maxQueriesPerTurn: 100, timeoutSeconds: 30, maxConcurrent: 8 };
/** A heavy dataset's defaults: a time range always (the last 90 days when none is asked), at most 400 days, and smaller answers. */
export const HEAVY_LIMITS: QueryLimits = { maxRows: 10_000, maxGroups: 10_000, maxSeriesPoints: 5_000, maxWindowDays: 400, requireTime: true, defaultWindowDays: 90 };

const RANGES: Record<Exclude<keyof QueryLimits | keyof ServerLimits, "requireTime">, [number, number]> = {
  maxRows: [100, 1_000_000],
  maxGroups: [10, 10_000_000],
  maxSeriesPoints: [10, 1_000_000],
  maxWindowDays: [1, 36_600],
  defaultWindowDays: [1, 36_600],
  maxQueriesPerTurn: [1, 10_000],
  timeoutSeconds: [1, 3_600],
  maxConcurrent: [1, 500],
};
const LIMIT_KEYS = ["maxRows", "maxGroups", "maxSeriesPoints", "maxWindowDays", "requireTime", "defaultWindowDays"] as const;
const SERVER_KEYS = ["maxQueriesPerTurn", "timeoutSeconds", "maxConcurrent"] as const;
const NULLABLE = new Set(["maxWindowDays", "defaultWindowDays"]);

function limitsFrom(input: unknown, where: string, keys: readonly string[], extra: readonly string[] = []): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error(`${where} must be a map`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (extra.includes(k)) continue;
    if (!keys.includes(k)) throw new Error(`${where}: unknown setting "${k}" (${[...keys, ...extra].join(", ")})`);
    if (k === "requireTime") {
      if (typeof v !== "boolean") throw new Error(`${where}.requireTime is true or false`);
      out[k] = v;
      continue;
    }
    if (v === null && NULLABLE.has(k)) {
      out[k] = null;
      continue;
    }
    const [min, max] = RANGES[k as keyof typeof RANGES];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${where}.${k} is a whole number from ${min} to ${max}${NULLABLE.has(k) ? ", or null for none" : ""}`);
    out[k] = v;
  }
  return out;
}

function datasetFrom(input: unknown, where: string): DatasetSafety {
  const out = limitsFrom(input, where, LIMIT_KEYS, ["heavy", "highCardinality", "cardinality"]) as DatasetSafety;
  const o = input as Record<string, unknown>;
  if (o.heavy !== undefined) {
    if (typeof o.heavy !== "boolean") throw new Error(`${where}.heavy is true or false`);
    out.heavy = o.heavy;
  }
  if (o.highCardinality !== undefined) {
    if (!Array.isArray(o.highCardinality) || o.highCardinality.some((c) => typeof c !== "string" || !c.trim()) || o.highCardinality.length > 500) throw new Error(`${where}.highCardinality is a list of column names or dimension keys`);
    out.highCardinality = [...new Set((o.highCardinality as string[]).map((c) => c.trim()))];
  }
  if (o.cardinality !== undefined) {
    if (!o.cardinality || typeof o.cardinality !== "object" || Array.isArray(o.cardinality)) throw new Error(`${where}.cardinality is a map of a column or dimension key to about how many values it has`);
    const c: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.cardinality as Record<string, unknown>)) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1e12) throw new Error(`${where}.cardinality.${k} is a whole number of values, at least 1`);
      c[k] = v;
    }
    out.cardinality = c;
  }
  return out;
}

/** superset.yaml's querySafety: (or an admin's change), checked. Throws with the key at fault. */
export function querySafetyFrom(input: unknown, where = "querySafety"): QuerySafetyConfig {
  if (input === undefined || input === null) return {};
  const out = limitsFrom(input, where, [...LIMIT_KEYS, ...SERVER_KEYS], ["heavy", "datasets"]) as QuerySafetyConfig;
  const o = input as Record<string, unknown>;
  if (o.heavy !== undefined && o.heavy !== null) out.heavy = limitsFrom(o.heavy, `${where}.heavy`, LIMIT_KEYS) as Partial<QueryLimits>;
  if (o.datasets !== undefined && o.datasets !== null) {
    if (typeof o.datasets !== "object" || Array.isArray(o.datasets)) throw new Error(`${where}.datasets is a map of a dataset (id, table name or key) to its settings`);
    out.datasets = Object.fromEntries(Object.entries(o.datasets as Record<string, unknown>).map(([k, v]) => [k, datasetFrom(v ?? {}, `${where}.datasets.${k}`)]));
  }
  return out;
}

/** The environment's overrides (they win over the file): LENSPACK_QUERY_* and LENSPACK_HEAVY_DATASETS. */
export function querySafetyEnv(env: Record<string, string | undefined>): QuerySafetyConfig {
  const names: Record<string, keyof QueryLimits | keyof ServerLimits> = {
    LENSPACK_QUERY_MAX_ROWS: "maxRows",
    LENSPACK_QUERY_MAX_GROUPS: "maxGroups",
    LENSPACK_QUERY_MAX_SERIES_POINTS: "maxSeriesPoints",
    LENSPACK_QUERY_MAX_WINDOW_DAYS: "maxWindowDays",
    LENSPACK_QUERY_MAX_PER_TURN: "maxQueriesPerTurn",
    LENSPACK_QUERY_TIMEOUT_SECONDS: "timeoutSeconds",
    LENSPACK_QUERY_MAX_CONCURRENT: "maxConcurrent",
  };
  const raw: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(names)) {
    const v = env[name]?.trim();
    if (!v) continue;
    raw[key] = v === "none" && NULLABLE.has(key) ? null : Number(v);
  }
  let out: QuerySafetyConfig;
  try {
    out = querySafetyFrom(raw, "environment");
  } catch (e) {
    const msg = (e as Error).message.replace(/environment\.(\w+)/, (_, k) => Object.entries(names).find(([, v]) => v === k)?.[0] ?? k);
    throw new Error(msg);
  }
  const heavy = env.LENSPACK_HEAVY_DATASETS?.trim();
  if (heavy) out.datasets = Object.fromEntries(heavy.split(",").map((d) => d.trim()).filter(Boolean).map((d) => [d, { heavy: true }]));
  return out;
}

/** Two layers as one: `over`'s fields win; datasets merge field by field. */
export function mergeQuerySafety(base: QuerySafetyConfig, over: QuerySafetyConfig): QuerySafetyConfig {
  const datasets: Record<string, DatasetSafety> = { ...base.datasets };
  for (const [k, v] of Object.entries(over.datasets ?? {})) datasets[k] = { ...datasets[k], ...v };
  const { heavy: _bh, datasets: _bd, ...b } = base;
  const { heavy: _oh, datasets: _od, ...o } = over;
  const heavy = base.heavy || over.heavy ? { ...base.heavy, ...over.heavy } : undefined;
  return { ...b, ...o, ...(heavy ? { heavy } : {}), ...(Object.keys(datasets).length ? { datasets } : {}) };
}

/** The settings in force, every field set, from a deployment's layers (merged). */
export function querySafety(config: QuerySafetyConfig = {}): QuerySafety {
  const pick = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.filter((k) => (config as Record<string, unknown>)[k] !== undefined).map((k) => [k, (config as Record<string, unknown>)[k]]));
  return {
    limits: { ...QUERY_LIMITS, ...pick(LIMIT_KEYS) },
    server: { ...SERVER_LIMITS, ...pick(SERVER_KEYS) },
    heavy: { ...HEAVY_LIMITS, ...config.heavy },
    datasets: config.datasets ?? {},
  };
}

/** One dataset's limits: the server's, a heavy dataset's, then its own entry's. */
export function limitsFor(s: QuerySafety, entity: string): QueryLimits {
  const own = s.datasets[entity] ?? {};
  const base = own.heavy ? s.heavy : s.limits;
  const fields = Object.fromEntries(LIMIT_KEYS.filter((k) => own[k] !== undefined).map((k) => [k, own[k]]));
  return { ...base, ...fields };
}

// ---- the shape of one query ----------------------------------------------------------------------------------

/** What a query costs the database, in the terms the limits use. */
export type QueryShape = {
  entity: string;
  kind: Query["kind"];
  /** Dimension keys grouped by: a breakdown's dimension and its split, a series' `by`. */
  groupBy: { key: string; column?: string }[];
  /** A breakdown's, a list's or a map's own limit; null for a value or a series. */
  limit: number | null;
  split: boolean;
  grain: Grain | null;
  window: { from: Date; to: Date } | null;
  /** The dataset has a time column (so a range can narrow it). */
  hasTime: boolean;
  /** Rows skipped first: a later page of a list. */
  offset: number;
};

/** The part of the engine's bound plan a shape is read from (structural, so policy does not depend on the engine). */
export type BoundLike = {
  root: string;
  rootEntity: { time?: unknown };
  query: Query;
  dimension: { def: { key: string; field?: string } } | null;
  split: { def: { key: string; field?: string } } | null;
  time: { from: Date; to: Date } | null;
  base?: { rows: number };
};

export function shapeOf(bound: BoundLike): QueryShape {
  const q = bound.query;
  const groupBy = [bound.dimension, bound.split].filter((d): d is NonNullable<typeof d> => !!d).map((d) => ({ key: d.def.key, ...(d.def.field ? { column: d.def.field } : {}) }));
  return {
    entity: bound.root,
    kind: q.kind,
    groupBy: q.kind === "rows" || q.kind === "points" ? [] : groupBy,
    limit: q.kind === "breakdown" || q.kind === "rows" || q.kind === "points" ? q.limit : null,
    split: q.kind === "breakdown" && !!bound.split,
    grain: q.kind === "series" ? q.grain : null,
    window: bound.time,
    hasTime: !!bound.rootEntity.time,
    offset: q.kind === "rows" ? (q.offset ?? 0) : 0,
  };
}

// ---- the check -----------------------------------------------------------------------------------------------

const DAY = 86_400_000;
export const GRAIN_MS: Record<Grain, number> = { hour: 3_600_000, day: DAY, week: 7 * DAY, month: 30.44 * DAY, quarter: 91.31 * DAY, year: 365.25 * DAY };
const COARSER: Record<Grain, Grain | null> = { hour: "day", day: "week", week: "month", month: "quarter", quarter: "year", year: null };
const fmt = (n: number) => Math.round(n).toLocaleString("en");

/** What the deployment knows about a dataset's columns, for the check: its own entry, and the hierarchy above a key. */
export type ShapeFacts = {
  /** The dataset's name as people know it, in a refusal. */
  label?: string;
  /** The next coarser level of a dimension, from the pack's hierarchies: what to group by instead. */
  coarser?: (key: string) => string | undefined;
  now?: Date;
};

export type QueryVerdict =
  | { ok: false; message: string; key?: string; nearest?: string }
  | {
      ok: true;
      /** The most rows to return: a series or a split breakdown is cut to it. */
      rowLimit: number;
      /** A time range put on a question that had none (a heavy dataset's default window). */
      window?: { from: Date; to: Date };
      /** Said with the answer: why its range is not the one asked for. */
      note?: string;
    };

const matches = (list: string[] | undefined, g: { key: string; column?: string }) => !!list?.some((c) => c === g.key || (g.column !== undefined && c.toLowerCase() === g.column.toLowerCase()));
const countOf = (own: DatasetSafety, g: { key: string; column?: string }) => own.cardinality?.[g.key] ?? (g.column !== undefined ? own.cardinality?.[g.column] : undefined);

/**
 * Whether a query may go to the database, and what is changed on the way (a default window, a row cap). A refusal's
 * message says what to ask instead, for the assistant to relay or act on. Pure.
 */
export function checkQuery(shape: QueryShape, s: QuerySafety, facts: ShapeFacts = {}): QueryVerdict {
  const limits = limitsFor(s, shape.entity);
  const own = s.datasets[shape.entity] ?? {};
  const label = facts.label ?? shape.entity;
  // A column with a value for every record: grouping by it makes the database build a group per record.
  for (const g of shape.groupBy)
    if (matches(own.highCardinality, g)) {
      const up = facts.coarser?.(g.key);
      return {
        ok: false,
        key: g.key,
        ...(up ? { nearest: up } : {}),
        message: `"${g.key}" has a different value for almost every record of ${label}, so grouping by it would make the database build one group per record. Group by a coarser level${up ? ` (${up})` : ""}, or filter to a few values and list the rows instead.`,
      };
    }
  let window = shape.window;
  let note: string | undefined;
  let defaulted: { from: Date; to: Date } | undefined;
  if (limits.requireTime && !window && shape.hasTime) {
    if (limits.defaultWindowDays) {
      const now = facts.now ?? new Date();
      window = defaulted = { from: new Date(now.getTime() - limits.defaultWindowDays * DAY), to: now };
      note = `${label} is large, so this reads the last ${fmt(limits.defaultWindowDays)} days only; ask for a time range to see another period${limits.maxWindowDays ? ` (up to ${fmt(limits.maxWindowDays)} days at once)` : ""}`;
    } else
      return {
        ok: false,
        message: `${label} is large, so a question about it needs a time range, for example the last 30 days${limits.maxWindowDays ? `; the longest allowed at once is ${fmt(limits.maxWindowDays)} days` : ""}.`,
      };
  }
  const span = window ? Math.max(0, window.to.getTime() - window.from.getTime()) : null;
  if (limits.maxWindowDays && span !== null && span > limits.maxWindowDays * DAY + DAY)
    return { ok: false, message: `This asks for ${fmt(span / DAY)} days of ${label}; the most allowed at once is ${fmt(limits.maxWindowDays)} days. Use a shorter time range, or split it into periods.` };
  if (shape.kind === "series" && shape.grain && span !== null) {
    const buckets = Math.max(1, Math.ceil(span / GRAIN_MS[shape.grain]));
    const series = shape.groupBy.reduce((n, g) => n * (countOf(own, g) ?? 1), 1);
    if (buckets * series > limits.maxSeriesPoints) {
      const coarser = COARSER[shape.grain];
      return {
        ok: false,
        message: `This series would draw about ${fmt(buckets * series)} points (${fmt(buckets)} ${shape.grain}s${series > 1 ? ` for each of about ${fmt(series)} series` : ""}); the most is ${fmt(limits.maxSeriesPoints)}. Use a coarser grain${coarser ? ` (${coarser} instead of ${shape.grain})` : ""} or a shorter time range.`,
      };
    }
  }
  if (shape.kind === "breakdown" && shape.groupBy.length) {
    const counts = shape.groupBy.map((g) => countOf(own, g));
    if (counts.every((c) => c !== undefined)) {
      const groups = counts.reduce((n, c) => n! * c!, 1)!;
      if (groups > limits.maxGroups) {
        const names = shape.groupBy.map((g) => g.key).join(" × ");
        const up = shape.groupBy.map((g) => facts.coarser?.(g.key)).find(Boolean);
        return {
          ok: false,
          ...(up ? { nearest: up } : {}),
          message: `This would make about ${fmt(groups)} groups (${names}); the most is ${fmt(limits.maxGroups)}. Pick a coarser level${up ? ` (${up})` : ""}${shape.split ? ", drop the split" : ""}, or filter to fewer values.`,
        };
      }
    }
  }
  // A list, a map or a top N is its own limit; a series or a split breakdown is cut to the row cap and says so.
  if (shape.limit !== null && !shape.split && shape.limit > limits.maxRows)
    return { ok: false, message: `This asks for ${fmt(shape.limit)} rows at once; the most is ${fmt(limits.maxRows)}. Ask for fewer (the top ${fmt(Math.min(limits.maxRows, 500))}), or narrow it with a filter.` };
  return { ok: true, rowLimit: limits.maxRows, ...(defaulted ? { window: defaulted } : {}), ...(note ? { note } : {}) };
}

/** The refusal when one turn has sent as many queries as it may. */
export const turnLimitMessage = (max: number) =>
  `This answer has already sent ${fmt(max)} queries to the database, the most one question may. Answer with what you have, or ask the person to narrow the question (one place, one period).`;

// ---- an admin's changes: tighter freely, looser only on purpose ---------------------------------------------------

type Looser = { field: string; from: unknown; to: unknown };
const looserNumber = (field: string, base: number | null, next: number | null): Looser | null => {
  // null is "none": no limit, the loosest.
  const b = base === null ? Infinity : base;
  const n = next === null ? Infinity : next;
  return n > b ? { field, from: base, to: next } : null;
};

/** Each way `next` lets more through than `base`. A default window larger, or put in place of a refusal, counts as looser. */
export function looserThan(base: QuerySafety, next: QuerySafety, entities: string[]): Looser[] {
  const out: Looser[] = [];
  const limitsDiff = (where: string, b: QueryLimits, n: QueryLimits) => {
    for (const k of ["maxRows", "maxGroups", "maxSeriesPoints", "maxWindowDays"] as const) {
      const l = looserNumber(`${where}${k}`, b[k], n[k]);
      if (l) out.push(l);
    }
    if (b.requireTime && !n.requireTime) out.push({ field: `${where}requireTime`, from: true, to: false });
    // With a time range required, a default window lets a question through that would be refused; a longer one reads more.
    if (n.requireTime && b.requireTime && n.defaultWindowDays !== null && (b.defaultWindowDays === null || n.defaultWindowDays > b.defaultWindowDays))
      out.push({ field: `${where}defaultWindowDays`, from: b.defaultWindowDays, to: n.defaultWindowDays });
  };
  limitsDiff("", base.limits, next.limits);
  limitsDiff("heavy.", base.heavy, next.heavy);
  for (const k of SERVER_KEYS) if (next.server[k] > base.server[k]) out.push({ field: k, from: base.server[k], to: next.server[k] });
  for (const e of new Set([...entities, ...Object.keys(base.datasets), ...Object.keys(next.datasets)])) {
    // A dataset with no entry of its own on either side follows the server's limits, already compared above.
    if (base.datasets[e] || next.datasets[e]) limitsDiff(`datasets.${e}.`, limitsFor(base, e), limitsFor(next, e));
    const b = base.datasets[e] ?? {};
    const n = next.datasets[e] ?? {};
    const dropped = (b.highCardinality ?? []).filter((c) => !(n.highCardinality ?? []).includes(c));
    if (dropped.length) out.push({ field: `datasets.${e}.highCardinality`, from: b.highCardinality, to: n.highCardinality ?? [] });
    for (const [k, v] of Object.entries(b.cardinality ?? {})) if ((n.cardinality?.[k] ?? 0) < v) out.push({ field: `datasets.${e}.cardinality.${k}`, from: v, to: n.cardinality?.[k] ?? null });
  }
  return out;
}

/**
 * An admin's change to the saved settings (settings.json "querySafety"): a field set, a field null to put back the
 * deployment's value, a dataset null to drop the admin's entry for it. Tighter than the deployment's own settings
 * (the config and the environment) is always allowed; looser needs `confirm: true` in the same request, and the
 * answer lists what would loosen. Pure: returns the new saved section, or why not.
 */
export function updateQuerySafety(
  saved: QuerySafetyConfig,
  body: Record<string, unknown>,
  deployment: QuerySafetyConfig,
  entities: string[],
): { ok: true; saved: QuerySafetyConfig; looser: Looser[] } | { ok: false; status: 400 | 409; error: string; looser?: Looser[] } {
  const { confirm, ...change } = body;
  if (confirm !== undefined && typeof confirm !== "boolean") return { ok: false, status: 400, error: "confirm is true or false" };
  const next: Record<string, unknown> = structuredClone(saved) as Record<string, unknown>;
  try {
    for (const [k, v] of Object.entries(change)) {
      if (k === "datasets") {
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("datasets is a map of a dataset to its settings, or to null to drop them");
        const ds = { ...((next.datasets as Record<string, DatasetSafety>) ?? {}) };
        for (const [d, entry] of Object.entries(v as Record<string, unknown>)) {
          if (entry === null) {
            delete ds[d];
            continue;
          }
          if (typeof entry !== "object" || Array.isArray(entry)) throw new Error(`datasets.${d} is a map, or null`);
          const merged: Record<string, unknown> = { ...ds[d] };
          for (const [f, x] of Object.entries(entry as Record<string, unknown>)) {
            if (x === null) delete merged[f];
            else merged[f] = x;
          }
          ds[d] = datasetFrom(merged, `datasets.${d}`);
          if (!Object.keys(ds[d]!).length) delete ds[d];
        }
        if (Object.keys(ds).length) next.datasets = ds;
        else delete next.datasets;
      } else if (k === "heavy") {
        if (v === null) delete next.heavy;
        else {
          const merged: Record<string, unknown> = { ...(next.heavy as object) };
          if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("heavy is a map of limits, or null");
          for (const [f, x] of Object.entries(v as Record<string, unknown>)) {
            if (x === null) delete merged[f];
            else merged[f] = x;
          }
          next.heavy = limitsFrom(merged, "heavy", LIMIT_KEYS);
          if (!Object.keys(next.heavy as object).length) delete next.heavy;
        }
      } else if (v === null && !NULLABLE.has(k)) delete next[k];
      else next[k] = v;
    }
    // A nullable limit set to null means "none"; to put back the deployment's value, send "default".
    for (const k of NULLABLE) if (next[k] === "default") delete next[k];
    const parsed = querySafetyFrom(next, "querySafety");
    const base = querySafety(deployment);
    const after = querySafety(mergeQuerySafety(deployment, parsed));
    const looser = looserThan(base, after, entities);
    if (looser.length && confirm !== true)
      return {
        ok: false,
        status: 409,
        looser,
        error: `This loosens the deployment's own limits (${looser.map((l) => l.field).join(", ")}). Send the same change with "confirm": true to apply it anyway; tightening needs no confirm.`,
      };
    return { ok: true, saved: parsed, looser };
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The coarser level above a key in the pack's hierarchies, if any: what a refusal suggests grouping by instead. */
export function coarserLevel(pack: Pack, key: string): string | undefined {
  for (const levels of Object.values(pack.hierarchies ?? {})) {
    const i = levels.indexOf(key);
    if (i > 0) return levels[i - 1];
  }
  return undefined;
}

