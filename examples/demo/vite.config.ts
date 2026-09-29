import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

// The board page's critical path was HTML → main chunk → app chunk → API →
// paint, each waiting for the one before. On /app this starts the app and
// default chart chunks and the board request from the HTML itself, so they
// run alongside the main chunk instead of after it.
function bootstrapApp(): Plugin {
  return {
    name: "lenspack-bootstrap-app",
    apply: "build",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle ?? {};
        const chunks = Object.values(bundle).filter((c): c is Extract<typeof c, { type: "chunk" }> => c.type === "chunk");
        // A chunk that merged several modules has no facade: match on what it contains.
        const entryOf = (suffix: string) => chunks.find((c) => c.isDynamicEntry && (c.facadeModuleId ?? "").endsWith(suffix)) ?? chunks.find((c) => c.moduleIds.some((m) => m.endsWith(suffix)));
        const closure = (start: ReturnType<typeof entryOf>) => {
          const seen = new Set<string>();
          const walk = (name: string) => {
            if (seen.has(name)) return;
            seen.add(name);
            const c = bundle[name];
            if (c && c.type === "chunk") c.imports.forEach(walk);
          };
          if (start) walk(start.fileName);
          return [...seen];
        };
        const files = [...new Set([...closure(entryOf("src/app.tsx")), ...closure(entryOf("adapters/recharts.tsx"))])];
        const script = `<script>
(function () {
  if (location.pathname.indexOf("/app") !== 0) return;
  var files = ${JSON.stringify(files)};
  for (var i = 0; i < files.length; i++) {
    var l = document.createElement("link");
    l.rel = "modulepreload";
    l.href = "/" + files[i];
    document.head.appendChild(l);
  }
  var q = new URLSearchParams(location.search), ex = q.get("example"), b = q.get("board");
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
