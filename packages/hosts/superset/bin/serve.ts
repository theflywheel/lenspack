#!/usr/bin/env -S npx tsx
// Lenspack over Superset from the source tree, the same as `lenspack superset --config superset.yaml`:
//   npx tsx --tsconfig tsconfig.base.json packages/hosts/superset/bin/serve.ts superset.yaml
import { serveSuperset } from "../src/server";

await serveSuperset(process.argv[2] ?? "superset.yaml");
