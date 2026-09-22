import type { Catalogue } from "@lenspack/core";

import type { Pack } from "./pack";

function titleCase(key: string) {
  return key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** The model's vocabulary and the validator's input, derived from a pack. */
export function catalogueFrom(pack: Pack): Catalogue {
  return {
    pack: pack.pack,
    version: pack.version,
    entities: Object.entries(pack.entities).map(([key, e]) => ({
      key,
      grain: e.grain,
      hasTime: !!e.time,
      hasTenant: !!e.tenant,
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
      hint: m.hint,
      synonyms: m.synonyms,
      verified: m.verified,
    })),
  };
}
