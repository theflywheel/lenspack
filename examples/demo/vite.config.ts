import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkg = (name: string, sub = "index.ts") => fileURLToPath(new URL(`../../packages/${name}/src/${sub}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@lenspack/react/styles.css", replacement: pkg("react", "styles.css") },
      { find: /^@lenspack\/react\/adapters\/(.*)$/, replacement: pkg("react", "adapters/$1.tsx") },
      { find: "@lenspack/core", replacement: pkg("core") },
      { find: "@lenspack/react", replacement: pkg("react", "index.tsx") },
    ],
  },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
