// The access suite: real Superset 6.1 and 5.0 containers, Postgres and Lenspack (packages/hosts/superset/test-access).
// Run with `pnpm test:access`; one version with `pnpm test:access superset-6.1`. Needs Linux and Docker.
import { defineConfig } from "vitest/config";

import base from "./vitest.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Only the suite (mergeConfig would add these to the unit tests' list instead of replacing it).
    include: ["packages/hosts/superset/test-access/**/*.access.test.ts"],
    environmentMatchGlobs: [],
    testTimeout: 180_000,
    hookTimeout: 900_000,
    // One file per Superset version, each with its own stack, side by side.
    fileParallelism: true,
    reporters: ["verbose"],
  },
});
