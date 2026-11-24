import type { Catalogue, MeasureNature } from "@lenspack/core";

import type { MeasureExpr } from "./expr";
import { type Pack, expandedExpr } from "./pack";

function titleCase(key: string) {
  return key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** The model's vocabulary and the validator's input, derived from a pack. */
export function catalogueFrom(pack: Pack): Catalogue {
  return {
    pack: pack.pack,
    version: pack.version,
    ...(Object.keys(pack.hierarchies ?? {}).length ? { hierarchies: pack.hierarchies } : {}),
    entities: Object.entries(pack.entities).map(([key, e]) => ({
      key,
      grain: e.grain,
      hasTime: !!e.time,
      hasTenant: !!e.tenant,
      ...(e.geo ? { hasLocation: true } : {}),
    })),
    dimensions: pack.dimensions.map((d) => ({
      key: d.key,
      label: d.label ?? titleCase(d.key),
      entity: d.entity,
      type: d.type,
      grains: d.grains,
      hint: d.hint,
      synonyms: d.synonyms,
      verified: d.verified,
    })),
    measures: pack.measures.map((m) => ({
      key: m.key,
      label: m.label ?? titleCase(m.key),
      entity: m.entity,
      format: m.format,
      nature: natureOf(pack, m.key),
      hint: m.hint,
      synonyms: m.synonyms,
      verified: m.verified,
    })),
  };
}

/** How a measure's numbers behave across time buckets (MeasureNature), from its aggregate and expression. */
export function natureOf(pack: Pack, key: string): MeasureNature {
  const m = pack.measures.find((x) => x.key === key);
  if (!m || m.format === "percent") return "level";
  if (m.levels) return natureOf(pack, Object.values(m.levels)[0]!);
  if (m.derived) {
    // Sums and differences of measures that add up add up; any other arithmetic is a level.
    const adds = (e: MeasureExpr): boolean =>
      e.t === "measure" ? natureOf(pack, e.key) === "adds" : e.t === "neg" ? adds(e.arg) : e.t === "op" ? (e.op === "+" || e.op === "-") && adds(e.l) && adds(e.r) : false;
    const expr = expandedExpr(pack, m.key);
    return expr.t === "measure" ? natureOf(pack, expr.key) : adds(expr) ? "adds" : "level";
  }
  return m.agg === "count" || m.agg === "sum" ? "adds" : m.agg === "count_distinct" ? "distinct" : "level";
}
