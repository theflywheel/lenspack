import { defineConfig } from "tsup";

// board.js: the renderer with React and the SVG charts in one script, for pages with no build of their
// own. It is written next to the admin panel that serves it (@lenspack/serve's web/admin), with the styles.
export default defineConfig({
  entry: { board: "src/embed.tsx" },
  format: ["iife"],
  platform: "browser",
  target: "es2020",
  outDir: "../serve/web/admin",
  outExtension: () => ({ js: ".js" }),
  noExternal: [/.*/],
  minify: true,
  dts: false,
  clean: false,
  sourcemap: false,
  tsconfig: "tsconfig.build.json",
  env: { NODE_ENV: "production" },
  esbuildOptions(o) {
    o.jsx = "automatic";
    // From source, so the bundle builds whatever order the workspace builds in.
    o.alias = { "@lenspack/core": "../../kernel/core/src/index.ts" };
  },
  onSuccess: "cp src/styles.css ../serve/web/admin/board.css",
});
