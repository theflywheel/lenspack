import type { Catalogue } from "../src/catalogue";

// A deliberately abstract catalogue: the core must not care what the words mean.
export const catalogue: Catalogue = {
  pack: "fixture",
  version: 1,
  entities: [
    { key: "items", grain: "one row per item", hasTime: true, hasTenant: false },
    { key: "owners", grain: "one row per owner", hasTime: false, hasTenant: false },
  ],
  dimensions: [
    { key: "region", label: "Region", entity: "items", type: "string", verified: true },
    { key: "channel", label: "Channel", entity: "items", type: "string", verified: true },
    { key: "kind", label: "Kind", entity: "items", type: "enum", verified: true },
    { key: "owner_tier", label: "Owner tier", entity: "owners", type: "string", verified: true },
    { key: "created", label: "Created", entity: "items", type: "time", grains: ["day", "month"], verified: true },
  ],
  measures: [
    { key: "count", label: "Count", entity: "items", format: "number", verified: true },
    { key: "share_rate", label: "Share rate", entity: "items", format: "percent", verified: true },
    { key: "amount", label: "Amount", entity: "items", format: "currency", verified: true },
    { key: "owner_count", label: "Owners", entity: "owners", format: "number", verified: true },
  ],
};

export const packRef = { pack: "fixture", version: 1 };
