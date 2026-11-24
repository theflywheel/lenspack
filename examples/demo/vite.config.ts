import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

// The board page's critical path was HTML → main chunk → API → paint, each
// waiting for the one before. This starts the board request from the HTML
// itself, so it runs alongside the main chunk instead of after it.
function bootstrapApp(): Plugin {
  return {
    name: "lenspack-bootstrap-app",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const script = `<script>
(function () {
  var ui = window.__lenspackUi || {};
  var q = new URLSearchParams(location.search), home = (ui.home || "/").split("/");
  var ex = q.get("example") || (q.get("board") ? null : home[0]), b = q.get("board") || (q.get("example") ? null : home[1]);
  var get = function (u) { return fetch(u).then(function (r) { return r.json(); }); };
  window.__lenspackBoot = { index: get("/api/"), board: ex && b ? get("/api/" + ex + "/" + b + "?include=data,options") : null, path: ex && b ? "/" + ex + "/" + b : null };
})();
</script>`;
        return html.replace("</head>", `${script}\n  </head>`);
      },
    },
  };
}

const pkg = (name: string, sub = "index.ts") => fileURLToPath(new URL(`../../packages/${name}/src/${sub}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss(), bootstrapApp()],
  resolve: {
    alias: [
      { find: "@lenspack/react/styles.css", replacement: pkg("react", "styles.css") },
      { find: /^@lenspack\/react\/adapters\/(.*)$/, replacement: pkg("react", "adapters/$1.tsx") },
      { find: "@lenspack/core", replacement: pkg("core") },
      { find: "@lenspack/react", replacement: pkg("react", "index.tsx") },
    ],
  },
  server: { proxy: { "/api": "http://localhost:8787" } },
  preview: { proxy: { "/api": "http://localhost:8787" } },
});
