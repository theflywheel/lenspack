import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const pkg = (name: string, sub = "index.ts") => fileURLToPath(new URL(`./packages/${name}/src/${sub}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Workspace packages resolve to source so tests never need a build.
    alias: [
      { find: "@lenspack/sql/pg", replacement: pkg("sources/sql", "executors/pg.ts") },
      { find: "@lenspack/sql/duckdb", replacement: pkg("sources/sql", "executors/duckdb.ts") },
      { find: "@lenspack/sql/mysql", replacement: pkg("sources/sql", "executors/mysql.ts") },
      { find: "@lenspack/sql/sqlite", replacement: pkg("sources/sql", "executors/sqlite.ts") },
      { find: "@lenspack/sql/clickhouse", replacement: pkg("sources/sql", "executors/clickhouse.ts") },
      { find: "@lenspack/core", replacement: pkg("kernel/core") },
      { find: "@lenspack/pack", replacement: pkg("kernel/pack") },
      { find: "@lenspack/policy", replacement: pkg("kernel/policy") },
      { find: "@lenspack/engine", replacement: pkg("kernel/engine") },
      { find: "@lenspack/elasticsearch", replacement: pkg("sources/elasticsearch") },
      { find: "@lenspack/superset", replacement: pkg("hosts/superset") },
      { find: "@lenspack/dss", replacement: pkg("packs/dss") },
      { find: "@lenspack/ccrs", replacement: pkg("packs/ccrs") },
      { find: "@lenspack/serve", replacement: pkg("hosts/serve") },
      { find: "@lenspack/sql", replacement: pkg("sources/sql") },
      { find: "@lenspack/agent", replacement: pkg("kernel/agent") },
      { find: "@lenspack/mcp", replacement: pkg("hosts/mcp") },
      { find: /^@lenspack\/react\/adapters\/(.*)$/, replacement: pkg("hosts/react", "adapters/$1.tsx") },
      { find: "@lenspack/react/styles.css", replacement: pkg("hosts/react", "styles.css") },
      { find: "@lenspack/react", replacement: pkg("hosts/react", "index.tsx") },
    ],
  },
  test: {
    include: ["packages/*/*/test/**/*.test.{ts,tsx}", "examples/test/**/*.test.ts", "examples/demo/test/**/*.test.ts", "scripts/**/*.test.ts", "evals/test/**/*.test.ts"],
    environmentMatchGlobs: [["packages/hosts/react/**", "jsdom"]],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
