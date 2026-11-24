import YAML from "yaml";

import { parsePack } from "./load";
import type { Pack, PackDimension, PackMeasure, Where } from "./pack";

// Shared by the pack sources that compile another system's catalogue into a
// pack (CCRS KPIs, DSS charts, Superset datasets): keys, measure dedup,
// conformed dimensions, and the parsed pack with its YAML.

/** What every pack source produces: the parsed pack and the YAML a deployment keeps. */
export type BuiltPack = { pack: Pack; packYaml: string };

/**
 * A pack key from any name: lowercase words joined by "_". `camel` splits camelCase first, `digit` prefixes a
 * leading digit (default "n_"), `max` cuts to a length, `empty` is the key for a name with no letters or digits.
 */
export function slug(s: string, o: { camel?: boolean; digit?: string; max?: number; empty?: string } = {}): string {
  const k = (o.camel ? s.replace(/([a-z0-9])([A-Z])/g, "$1_$2") : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, `${o.digit ?? "n_"}$1`);
  return (o.max ? k.slice(0, o.max).replace(/_+$/, "") : k) || (o.empty ?? "k");
}

/** A predicate list as a string that ignores order: two measures with the same filters, in any order, match. */
export const whereSig = (w: Where[]) => JSON.stringify([...w].map((x) => [x.field, x.op, x.value ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

type Source = NonNullable<PackDimension["also"]>[string];

export function packBuilder() {
  const dimensions = new Map<string, PackDimension>();
  const measures = new Map<string, PackMeasure>();
  const bySig = new Map<string, string>();
  return {
    dimensions,
    measures,
    /** The first key free among measures and dimensions: `first`, then stem_2, stem_3, … */
    key(stem: string, first = stem, sep = "_") {
      let key = first;
      for (let i = 2; measures.has(key) || dimensions.has(key); i++) key = `${stem}${sep}${i}`;
      return key;
    },
    /** The measure with this signature, made once. */
    measure(sig: string, make: () => PackMeasure): string {
      const known = bySig.get(sig);
      if (known) return known;
      const m = make();
      measures.set(m.key, m);
      bySig.set(sig, m.key);
      return m.key;
    },
    /** Records that `dim` also reads on `entity`; false when it already did. */
    conform(dim: PackDimension, entity: string, source: Source): boolean {
      if (dim.entity === entity || dim.also?.[entity]) return false;
      dim.also = { ...(dim.also ?? {}), [entity]: source };
      return true;
    },
  };
}

/** A raw pack object (undefined values dropped), parsed and as YAML. */
export function emitPack(raw: Record<string, unknown>): BuiltPack {
  const clean = JSON.parse(JSON.stringify(raw));
  return { pack: parsePack(clean), packYaml: YAML.stringify(clean, { lineWidth: 0 }) };
}
