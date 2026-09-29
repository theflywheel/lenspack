// The catalogue is the model's entire vocabulary and the validator's only
// input. It is derived from a pack at runtime by @lenspack/spec; core never
// knows where it came from, which is what keeps this package domain-free.

export type MeasureFormat = "number" | "percent" | "currency" | "compact" | "duration";
export type DimensionType = "string" | "number" | "boolean" | "time" | "enum";
export type Grain = "hour" | "day" | "week" | "month" | "quarter" | "year";

export type CatalogueDimension = {
  key: string;
  label: string;
  entity: string;
  type: DimensionType;
  grains?: Grain[];
  hint?: string;
  synonyms?: string[];
  verified: boolean;
};

export type CatalogueMeasure = {
  key: string;
  label: string;
  entity: string;
  format: MeasureFormat;
  hint?: string;
  synonyms?: string[];
  verified: boolean;
};

export type CatalogueEntity = {
  key: string;
  grain?: string;
  hasTime: boolean;
  hasTenant: boolean;
};

export type Catalogue = {
  pack: string;
  version: number;
  dimensions: CatalogueDimension[];
  measures: CatalogueMeasure[];
  entities: CatalogueEntity[];
  /** Dimensions that nest, coarse to fine: what a click drills through. */
  hierarchies?: Record<string, string[]>;
};

export function dimension(catalogue: Catalogue, key: string) {
  return catalogue.dimensions.find((d) => d.key === key) ?? null;
}

export function measure(catalogue: Catalogue, key: string) {
  return catalogue.measures.find((m) => m.key === key) ?? null;
}

export function entity(catalogue: Catalogue, key: string) {
  return catalogue.entities.find((e) => e.key === key) ?? null;
}

// A rate is a share of something; a pie of one implies parts of a whole, which
// a rate is not. The catalogue says so through the measure's format.
export function isRate(catalogue: Catalogue, key: string) {
  return measure(catalogue, key)?.format === "percent";
}

/** Only what the model is allowed to see and name. */
export function verifiedOnly(catalogue: Catalogue): Catalogue {
  return {
    ...catalogue,
    dimensions: catalogue.dimensions.filter((d) => d.verified),
    measures: catalogue.measures.filter((m) => m.verified),
  };
}

/**
 * Where a grouping stands under the current selections: a grouping at or above
 * the deepest selected level of its hierarchy steps one level below it (or
 * stays at the finest level). Used by the engine to build the drilled query
 * and by a renderer to know what a click on a drilled bar selects.
 */
export function drilledDimension(dimension: string, selections: Record<string, string>, hierarchies: Record<string, string[]> = {}): string {
  for (const levels of Object.values(hierarchies)) {
    const index = levels.indexOf(dimension);
    if (index < 0) continue;
    const deepest = Math.max(-1, ...levels.map((l, i) => (selections[l] ? i : -1)));
    return index > deepest ? dimension : levels[Math.min(deepest + 1, levels.length - 1)]!;
  }
  return dimension;
}

/** The next level below a dimension, if it is a level with one. */
export function nextLevel(dimension: string, hierarchies: Record<string, string[]> = {}): string | null {
  for (const levels of Object.values(hierarchies)) {
    const index = levels.indexOf(dimension);
    if (index >= 0) return levels[index + 1] ?? null;
  }
  return null;
}

/** Selecting a level clears the finer levels below it in the same hierarchy. */
export function selectLevel(selections: Record<string, string>, dimension: string, value: string, hierarchies: Record<string, string[]> = {}): Record<string, string> {
  const next = { ...selections };
  const levels = Object.values(hierarchies).find((ls) => ls.includes(dimension));
  if (levels) for (const finer of levels.slice(levels.indexOf(dimension) + 1)) delete next[finer];
  if (value) next[dimension] = value;
  else delete next[dimension];
  return next;
}
