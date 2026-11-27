import type { Grain, Query } from "@lenspack/core";
import type { Pack } from "@lenspack/pack";

import { type QuerySafety, coarserLevel, limitsFor } from "./query-safety";

// The checks around query safety that run before any question: risky definitions in a pack (at start-up, and each
// time the pack changes), and the dry run's reading of the SQL Superset would run for each shape the pack allows.
// Pure; hosts gather the facts (a dataset's columns, the compiled SQL) and show the findings.

const matches = (list: string[] | undefined, g: { key: string; column?: string }) => !!list?.some((c) => c === g.key || (g.column !== undefined && c.toLowerCase() === g.column.toLowerCase()));


/** What a host knows about a dataset without asking its database: its columns and types. */
export type DatasetFacts = {
  entity: string;
  /** The dataset's name, as people know it. */
  label: string;
  timeColumn: string | null;
  /** The time column holds calendar dates (one row per day or coarser), not times of day. */
  dated: boolean;
  /** Coordinates: one row per place visited, which summaries rarely have. */
  geo: boolean;
  columns: { name: string; type?: string | null; groupable: boolean }[];
};

export type PackRisk = { level: "warning" | "info"; entity?: string; key?: string; message: string };

/** A column name that reads as one value per record: an id, a uuid, a phone number, coordinates. */
export const ID_LIKE = /(^|_)(id|uuid|guid|key|hash|token|phone|mobile|msisdn|email|lat|lng|lon|latitude|longitude)$|^(id|uuid|guid)_|identifier$/i;

/**
 * A guess at what one row of a dataset is, from its columns alone (no query): "rows" (one row per record: times of
 * day, coordinates, ids) or "summary" (calendar dates, no ids), with why. Shown to the operator as a hint to mark a
 * dataset heavy; never applied by itself.
 */
export function sizeHint(d: DatasetFacts): { hint: "rows" | "summary" | "unknown"; why: string[] } {
  const why: string[] = [];
  const ids = d.columns.filter((c) => c.groupable && ID_LIKE.test(c.name)).map((c) => c.name);
  if (d.timeColumn && !d.dated) why.push(`its time column "${d.timeColumn}" has a time of day`);
  if (d.geo) why.push("it has coordinates");
  if (ids.length) why.push(`it has record-level columns (${ids.slice(0, 4).join(", ")}${ids.length > 4 ? ", …" : ""})`);
  if (why.length >= 2) return { hint: "rows", why };
  if (d.timeColumn && d.dated && !ids.length) return { hint: "summary", why: [`its time column "${d.timeColumn}" holds dates`, "it has no record-level columns"] };
  return { hint: "unknown", why };
}

/**
 * Risky definitions in a pack, under the deployment's limits: a dimension that reads as one value per record offered
 * for grouping, a distinct count on a large dataset, a large dataset that no time range can narrow, a hierarchy that
 * steps through a column the deployment says is never grouped. Warnings for the log and the settings API; nothing is
 * changed by them.
 */
export function packRisks(pack: Pack, s: QuerySafety, datasets: DatasetFacts[]): PackRisk[] {
  const out: PackRisk[] = [];
  const facts = new Map(datasets.map((d) => [d.entity, d]));
  for (const [entity] of Object.entries(pack.entities)) {
    const d = facts.get(entity);
    const own = s.datasets[entity] ?? {};
    const name = d?.label ?? entity;
    if (own.heavy && !d?.timeColumn && !pack.entities[entity]?.time)
      out.push({ level: "warning", entity, message: `${name} is marked heavy but has no time column, so no time range can narrow it: every question reads all of it. Give it a time column in Superset (Main datetime column), or exclude it.` });
    if (!own.heavy && d) {
      const h = sizeHint(d);
      if (h.hint === "rows") out.push({ level: "info", entity, message: `${name} looks like one row per record (${h.why.join("; ")}). If it is large, mark it heavy (querySafety.datasets.${entity}.heavy: true) so questions on it need a time range.` });
    }
  }
  for (const dim of pack.dimensions) {
    const entities = [dim.entity, ...Object.keys(dim.also ?? {})];
    for (const entity of entities) {
      const own = s.datasets[entity] ?? {};
      const column = entity === dim.entity ? dim.field : (dim.also?.[entity] as { field?: string } | undefined)?.field;
      const g = { key: dim.key, ...(column ? { column } : {}) };
      if (matches(own.highCardinality, g))
        out.push({ level: "warning", entity, key: dim.key, message: `"${dim.key}" is a dimension of ${facts.get(entity)?.label ?? entity}, but the deployment says it has a value for almost every record: grouping by it is refused. List it in overlay.notDimensions so it is not offered at all.` });
      else if (ID_LIKE.test(column ?? dim.key) && dim.type !== "number")
        out.push({ level: "info", entity, key: dim.key, message: `"${dim.key}" reads like one value per record (an id or a contact). If it is, list it in querySafety.datasets.${entity}.highCardinality (grouping by it is then refused) or in overlay.notDimensions.` });
    }
  }
  for (const m of pack.measures) {
    if (m.agg !== "count_distinct" || !m.entity) continue;
    const own = s.datasets[m.entity] ?? {};
    if (!own.heavy) continue;
    const l = limitsFor(s, m.entity);
    if (!l.requireTime) out.push({ level: "warning", entity: m.entity, key: m.key, message: `"${m.key}" counts distinct values over ${facts.get(m.entity)?.label ?? m.entity}, which is marked heavy, without a time range required: a distinct count over every record holds them all in memory. Keep requireTime on for it.` });
  }
  for (const [name, levels] of Object.entries(pack.hierarchies ?? {}))
    for (const key of levels) {
      const dim = pack.dimensions.find((d) => d.key === key);
      if (dim && matches(s.datasets[dim.entity]?.highCardinality, { key, ...(dim.field ? { column: dim.field } : {}) }))
        out.push({ level: "warning", key, message: `The hierarchy "${name}" drills down to "${key}", which is never grouped by (highCardinality): its last step is refused. End the hierarchy one level higher.` });
    }
  for (const [e] of Object.entries(s.datasets)) if (!pack.entities[e]) out.push({ level: "warning", entity: e, message: `querySafety.datasets names "${e}", which is not a dataset of the pack; nothing is limited by it.` });
  return out;
}


// ---- the dry run: what SQL each shape would be, read without running it ------------------------------------------

export type SqlFinding = { level: "danger" | "warning"; message: string };

/**
 * What is risky in one statement Superset compiled for a query (chart-data with result_type "query", which compiles
 * without running): no LIMIT, a GROUP BY over many columns or over a per-record column, no time condition on a
 * large dataset. A text check over the SQL Superset wrote; it reads, it does not parse.
 */
export function sqlRisks(sql: string, o: { timeColumn: string | null; heavy: boolean; highCardinality?: string[]; maxGroupColumns?: number }): SqlFinding[] {
  const out: SqlFinding[] = [];
  const flat = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
  const upper = flat.toUpperCase();
  if (!/\bLIMIT\s+\d+/.test(upper)) out.push({ level: "danger", message: "no LIMIT: the database would return every row" });
  const group = /\bGROUP BY\s+(.+?)(?:\bHAVING\b|\bORDER BY\b|\bLIMIT\b|\)\s*(?:AS\b|$)|$)/i.exec(flat)?.[1];
  if (group) {
    const cols = splitTop(group);
    const many = o.maxGroupColumns ?? 3;
    if (cols.length > many) out.push({ level: "warning", message: `GROUP BY over ${cols.length} columns: groups multiply` });
    const per = (o.highCardinality ?? []).filter((c) => cols.some((g) => new RegExp(`(^|[^A-Za-z0-9_])${c.replace(/[^A-Za-z0-9_]/g, "")}([^A-Za-z0-9_]|$)`, "i").test(g)));
    if (per.length) out.push({ level: "danger", message: `GROUP BY ${per.join(", ")}, which has a value for almost every record` });
  }
  if (o.heavy && o.timeColumn) {
    const where = /\bWHERE\b(.+?)(?:\bGROUP BY\b|\bORDER BY\b|\bLIMIT\b|$)/i.exec(flat)?.[1] ?? "";
    const t = o.timeColumn.replace(/[^A-Za-z0-9_]/g, "");
    if (!new RegExp(`(^|[^A-Za-z0-9_])${t}([^A-Za-z0-9_]|$)`, "i").test(where)) out.push({ level: "danger", message: `no condition on the time column "${o.timeColumn}" on a heavy dataset: it reads every row` });
  }
  return out;
}

// Commas at the top level of an expression list (not inside parentheses or quotes).
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * The query shapes a pack allows, for the dry run: per dataset, each measure as one value, by each of the dataset's
 * dimensions (and each split by its hierarchy's next level), and over time at each grain; a list and a map of its
 * rows. At most `cap` queries, the plain ones first. Each comes with what it is, in words.
 */
export function dryRunQueries(pack: Pack, cap = 300, grains: Grain[] = ["hour", "day", "week", "month"]): { what: string; query: Query }[] {
  const out: { what: string; query: Query }[] = [];
  const later: { what: string; query: Query }[] = [];
  const time = { last: "90d" } as const;
  for (const [entity, e] of Object.entries(pack.entities)) {
    const measures = pack.measures.filter((m) => m.entity === entity && !m.derived && !m.levels);
    const dims = pack.dimensions.filter((d) => (d.entity === entity || d.also?.[entity]) && d.type !== "time");
    for (const m of measures) {
      out.push({ what: `${m.key}, one value, no time range`, query: { kind: "value", measure: m.key } });
      for (const d of dims) out.push({ what: `${m.key} by ${d.key}`, query: { kind: "breakdown", dimension: d.key, measure: m.key, limit: 12, sort: "desc" } });
      if (e.time) for (const g of grains) out.push({ what: `${m.key} by ${g}, last 90 days`, query: { kind: "series", measure: m.key, grain: g, time } });
      if (e.time) later.push({ what: `${m.key} by day, no time range`, query: { kind: "series", measure: m.key, grain: "day" } });
      for (const d of dims) {
        const next = coarserChild(pack, d.key);
        if (next) later.push({ what: `${m.key} by ${d.key} split by ${next}`, query: { kind: "breakdown", dimension: d.key, by: next, measure: m.key, limit: 12, sort: "desc" } });
      }
    }
    if (dims.length) later.push({ what: `a list of ${entity} rows`, query: { kind: "rows", entity, columns: dims.slice(0, 5).map((d) => d.key), limit: 50 } });
    if (e.geo) later.push({ what: `a map of ${entity}`, query: { kind: "points", entity, limit: 5000 } });
  }
  return [...out, ...later].slice(0, cap);
}

// The next finer level under a key in a hierarchy: a split a person is likely to ask for.
function coarserChild(pack: Pack, key: string): string | undefined {
  for (const levels of Object.values(pack.hierarchies ?? {})) {
    const i = levels.indexOf(key);
    if (i >= 0 && i < levels.length - 1) return levels[i + 1];
  }
  return undefined;
}
