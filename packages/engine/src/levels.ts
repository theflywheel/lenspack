import { type BoardConfig, type Query, type Widget, drilledDimension } from "@lenspack/core";
import type { Pack } from "@lenspack/spec";

import { type Capabilities, type Ctx, ResolveError } from "./resolve";
import { check } from "./run";

// Hierarchies: dimensions that nest, coarse to fine. Two things follow from
// them. A measure kept per level (a target row per region and per sub-region)
// is read at the level a query views. And picking a value on a level narrows a
// board to it and moves anything grouped at or above it one level down — the
// drill-down, as a pure function of the pack and the selections.

export function hierarchyOf(pack: Pack, dimension: string): { name: string; levels: string[]; index: number } | null {
  for (const [name, levels] of Object.entries(pack.hierarchies ?? {})) {
    const index = levels.indexOf(dimension);
    if (index >= 0) return { name, levels, index };
  }
  return null;
}

/** The hierarchy level a query views: what it groups by, else its deepest filter, else none. */
export function viewedLevel(query: Query, pack: Pack): string | null {
  const group = query.kind === "breakdown" ? query.dimension : query.kind === "series" ? query.by : undefined;
  if (group && hierarchyOf(pack, group)) return group;
  let deepest: { key: string; index: number } | null = null;
  for (const f of query.filters ?? []) {
    const h = f.op === "eq" ? hierarchyOf(pack, f.dimension) : null;
    if (h && (!deepest || h.index > deepest.index)) deepest = { key: f.dimension, index: h.index };
  }
  return deepest?.key ?? null;
}

const views = new WeakMap<Pack, Map<string, Pack>>();

/**
 * The pack as seen from one level: every per-level measure becomes an alias
 * (a one-operand derived measure) for its measure at that level, or at its
 * coarsest level when it has none there.
 */
export function packAtLevel(pack: Pack, level: string | null): Pack {
  if (!pack.measures.some((m) => m.levels)) return pack;
  let cache = views.get(pack);
  if (!cache) views.set(pack, (cache = new Map()));
  const key = level ?? "";
  const hit = cache.get(key);
  if (hit) return hit;
  const view: Pack = {
    ...pack,
    measures: pack.measures.map((m) => {
      if (!m.levels) return m;
      const order = Object.values(pack.hierarchies ?? {}).find((ls) => Object.keys(m.levels!).some((l) => ls.includes(l))) ?? [];
      const coarsest = order.find((l) => m.levels![l]) ?? Object.keys(m.levels)[0]!;
      const chosen = m.levels[level ?? ""] ?? m.levels[coarsest]!;
      const { levels: _levels, ...rest } = m;
      return { ...rest, entity: pack.measures.find((x) => x.key === chosen)?.entity ?? m.entity, derived: chosen };
    }),
  };
  cache.set(key, view);
  return view;
}

/**
 * A widget's query under the board's selections. A selection on a hierarchy
 * level applies to every widget that can be narrowed by it (and quietly not to
 * one that cannot: a target set per region is not narrowed by a street), and a
 * grouping at or above the deepest selected level steps one level down.
 * Selections on other dimensions apply only through the board's own filters.
 */
export function drilledQuery(
  config: BoardConfig,
  id: string,
  widget: Widget,
  selections: Record<string, string>,
  pack: Pack,
  opts: { ctx?: Ctx; capabilities?: Capabilities } = {},
): Query | null {
  if (widget.kind === "text") return null;
  let q: Query = widget.query;
  const explicit = config.filters.filter((f) => selections[f.field] && (f.applies.includes("*") || f.applies.includes(id)));
  const drill = Object.keys(selections).filter((k) => selections[k] && hierarchyOf(pack, k) && !explicit.some((f) => f.field === k));
  const add = [...explicit.map((f) => f.field), ...drill];
  const accepts = (candidate: Query) => {
    try {
      check(candidate, pack, opts);
      return true;
    } catch (e) {
      if (e instanceof ResolveError) return false;
      throw e;
    }
  };
  for (const field of add) {
    const next = { ...q, filters: [...(q.filters ?? []), { dimension: field, op: "eq" as const, value: selections[field]! }] } as Query;
    // Board filters always apply (the author said so); a drill only where it can.
    if (explicit.some((f) => f.field === field) || accepts(next)) q = next;
  }
  // Step groupings down past the deepest selected level of their hierarchy.
  const step = (dim: string | undefined) => (dim ? drilledDimension(dim, selections, pack.hierarchies) : dim);
  if (q.kind === "breakdown") {
    const d = step(q.dimension)!;
    if (d !== q.dimension && accepts({ ...q, dimension: d })) q = { ...q, dimension: d };
  } else if (q.kind === "series" && q.by) {
    const d = step(q.by)!;
    if (d !== q.by && accepts({ ...q, by: d })) q = { ...q, by: d };
  }
  return q;
}
