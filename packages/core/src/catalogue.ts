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
