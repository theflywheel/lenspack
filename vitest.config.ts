import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const pkg = (name: string, sub = "index.ts") => fileURLToPath(new URL(`./packages/${name}/src/${sub}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Workspace packages resolve to source so tests never need a build.
    alias: [
      { find: "@lenspack/sql/pg", replacement: pkg("sql", "executors/pg.ts") },
      { find: "@lenspack/sql/duckdb", replacement: pkg("sql", "executors/duckdb.ts") },
      { find: "@lenspack/core", replacement: pkg("core") },
      { find: "@lenspack/spec", replacement: pkg("spec") },
      { find: "@lenspack/sql", replacement: pkg("sql") },
      { find: "@lenspack/mcp", replacement: pkg("mcp") },
      { find: "@lenspack/react", replacement: pkg("react", "index.tsx") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}", "examples/test/**/*.test.ts", "scripts/**/*.test.ts"],
    environmentMatchGlobs: [["packages/react/**", "jsdom"]],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
