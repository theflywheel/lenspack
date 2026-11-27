import type { QueryGuard } from "@lenspack/engine";
import {
  type QuerySafety,
  type QuerySafetyConfig,
  checkQuery,
  coarserLevel,
  limitsFor,
  mergeQuerySafety,
  querySafety,
  querySafetyEnv,
  querySafetyFrom,
  shapeOf,
  turnLimitMessage,
  updateQuerySafety,
} from "@lenspack/policy";

import type { Binding } from "./catalogue";

// Query safety in Superset (docs/operating/query-safety.md): superset.yaml's querySafety:, the environment over it,
// and an admin's changes on a running server over both (settings.json "querySafety", tighter freely, looser only with
// confirm). Policy decides which query is too heavy (checkQuery); this reads the settings, names datasets the way
// the deployment does (id, table name or entity key), and hands the engine its guard.

type Settings = { get<T>(section: string): T | undefined; set(section: string, value: unknown): void };

/** A dataset reference in the settings (an id, a table name, schema.table or an entity key) as the pack's entity key, or null. */
export function entityFor(ref: string, binding: Binding): string | null {
  if (binding.datasets.has(ref)) return ref;
  const lower = ref.trim().toLowerCase();
  for (const [entity, ds] of binding.datasets) if (String(ds.id) === lower || ds.table.toLowerCase() === lower || lower.endsWith(`.${ds.table.toLowerCase()}`)) return entity;
  return null;
}

/** Datasets named by id or table name, keyed by entity instead; any not in the pack stays as written (and is warned about). */
function byEntity(c: QuerySafetyConfig, binding: Binding, warn: (s: string) => void): QuerySafetyConfig {
  if (!c.datasets) return c;
  const datasets: NonNullable<QuerySafetyConfig["datasets"]> = {};
  for (const [ref, v] of Object.entries(c.datasets)) {
    const e = entityFor(ref, binding);
    if (!e) warn(`querySafety.datasets names "${ref}", which is not a dataset of the pack; nothing is limited by it`);
    const key = e ?? ref;
    datasets[key] = { ...datasets[key], ...v };
  }
  return { ...c, datasets };
}

/**
 * `binding` is read on every use: the pack can change while the server runs (pack-runtime.ts), and datasets named by
 * table name or id are matched to its entities again.
 */
export function supersetQuerySafety(o: { config: unknown; env: NodeJS.ProcessEnv; binding: () => Binding; settings: Settings; log: (s: string) => void }) {
  // The deployment's own settings, as written: the file, then the environment over it. A mistake stops the start.
  const file = querySafetyFrom(o.config);
  const fromEnv = querySafetyEnv(o.env);
  const keyed = () => {
    const warnings: string[] = [];
    const warn = (s: string) => warnings.push(s);
    return { deployment: mergeQuerySafety(byEntity(file, o.binding(), warn), byEntity(fromEnv, o.binding(), warn)), warnings };
  };
  const deploymentNow = () => keyed().deployment;
  const entitiesNow = () => [...o.binding().datasets.keys()];
  const saved = (): QuerySafetyConfig => {
    try {
      return querySafetyFrom(o.settings.get("querySafety") ?? {});
    } catch (e) {
      // A settings file edited by hand into something invalid: the deployment's settings stand, and it is said.
      o.log(`warning: settings.json querySafety is not valid (${(e as Error).message}); the deployment's own limits apply`);
      return {};
    }
  };
  const current = (): QuerySafety => querySafety(mergeQuerySafety(deploymentNow(), saved()));
  const label = (entity: string) => {
    const ds = o.binding().datasets.get(entity);
    return ds ? `the dataset "${ds.table}"` : `"${entity}"`;
  };
  const guard: QueryGuard = (bound, pack) => {
    const s = current();
    const v = checkQuery(shapeOf(bound), s, { label: label(bound.root), coarser: (k) => coarserLevel(pack, k), now: new Date() });
    if (!v.ok) return { refuse: { message: v.message, ...(v.key ? { key: v.key } : {}), ...(v.nearest ? { nearest: v.nearest } : {}) } };
    return { rowLimit: v.rowLimit, ...(v.window ? { time: v.window } : {}), ...(v.note ? { note: v.note } : {}), timeoutMs: s.server.timeoutSeconds * 1000 };
  };
  const heavy = () => Object.entries(current().datasets).filter(([, d]) => d.heavy).map(([e]) => e);
  const line = () => {
    const s = current();
    const l = s.limits;
    const h = heavy();
    return `query safety: at most ${l.maxRows} rows, ${l.maxSeriesPoints} series points and ${l.maxGroups} known groups a query; ${s.server.maxQueriesPerTurn} queries a turn, ${s.server.maxConcurrent} at once, ${s.server.timeoutSeconds} s each; heavy datasets: ${h.length ? h.map((e) => o.binding().datasets.get(e)?.table ?? e).join(", ") : "none"}`;
  };
  return {
    guard,
    current,
    /** Datasets named in the settings that the pack does not have. */
    warnings: () => keyed().warnings,
    line,
    /** The chat's limit on queries per turn, read each turn. */
    perTurn: () => {
      const max = current().server.maxQueriesPerTurn;
      return { max, message: turnLimitMessage(max) };
    },
    /** For GET <prefix>/settings: what is in force, the deployment's own values, each dataset's limits, and where they came from. */
    view: (writable: boolean) => {
      const s = current();
      const own = saved();
      const binding = o.binding();
      const { deployment, warnings } = keyed();
      return {
        limits: s.limits,
        server: s.server,
        heavy: s.heavy,
        datasets: Object.fromEntries(
          [...binding.datasets.keys()].map((e) => {
            const d = s.datasets[e] ?? {};
            return [e, { table: binding.datasets.get(e)?.table ?? null, id: binding.datasets.get(e)?.id ?? null, heavy: !!d.heavy, highCardinality: d.highCardinality ?? [], cardinality: d.cardinality ?? {}, limits: limitsFor(s, e) }];
          }),
        ),
        deployment: querySafety(deployment),
        saved: own,
        source: Object.keys(own).length ? "settings" : "deployment",
        warnings,
        writable,
      };
    },
    /** PUT <prefix>/settings/query-safety: an admin's change, tighter freely, looser only with confirm: true. */
    update(body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
      const binding = o.binding();
      const change = body.datasets && typeof body.datasets === "object" && !Array.isArray(body.datasets) ? { ...body, datasets: Object.fromEntries(Object.entries(body.datasets as Record<string, unknown>).map(([k, v]) => [entityFor(k, binding) ?? k, v])) } : body;
      const unknown = Object.keys((change.datasets as Record<string, unknown>) ?? {}).filter((k) => !binding.datasets.has(k));
      if (unknown.length) return { status: 400, body: { error: `not a dataset of the pack: ${unknown.join(", ")}` } };
      const r = updateQuerySafety(saved(), change, deploymentNow(), entitiesNow());
      if (!r.ok) return { status: r.status, body: { error: r.error, ...(r.looser ? { looser: r.looser } : {}) } };
      o.settings.set("querySafety", Object.keys(r.saved).length ? r.saved : undefined);
      o.log(line());
      return { status: 200, body: { ok: true, ...(r.looser.length ? { loosened: r.looser } : {}) } };
    },
  };
}
export type SupersetQuerySafety = ReturnType<typeof supersetQuerySafety>;
