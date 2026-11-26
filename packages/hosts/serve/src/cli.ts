#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cacheSettings, localTurnGate, queueSettings, reuseLayer } from "@lenspack/agent";
import { compileDss } from "@lenspack/dss";
import { resolveBoard } from "@lenspack/engine";

import { buildBoard, seedBoards } from "./app";
import { type AuditEvent, auditFileSince, fileAudit, rotatingAudit } from "./audit";
import { authFrom, effectiveAuth, principalOf } from "./auth";
import { adminSettings } from "./admin";
import { brandSettings } from "./brand";
import { cacheRoutes } from "./reuse";
import { fileTelemetry, staticItems } from "./telemetry";
import { explainFrom, openConfig, openSources, readConfig, readSourcesConfig, resolveSecrets } from "./config";
import { hashPassword } from "./password";
import { startRuntime } from "./runtime";

const USAGE = `lenspack <command>

  serve  --config lenspack.yaml [--port 8787]   the board API (and --ui dir, LENSPACK_UI, or ui: in the config);
                                                the command may be left out: lenspack --config lenspack.yaml
  superset --config superset.yaml               the chat inside Apache Superset (@lenspack/superset)
  check  --config lenspack.yaml                 draw every board against its source; exit 1 on any error
  sources --config lenspack.yaml [--source s]   what each source holds: tables or indexes, fields, types, rows
  hash-password                                 a scrypt hash of the password on stdin, for LENSPACK_ADMIN_PASSWORD_HASH
  dss    ChartApiConfig.json [--dashboards MasterDashboardConfig.json]
         [--placeholders PVAR,…] [--pack name] --out dir
                                                DIGIT DSS chart configs → pack.yaml, boards/, report.md
`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// Flags first and no command is serve, so `docker run lenspack --config …` works as before.
const command = /^--(config|port|ui|host)$/.test(args[0] ?? "") ? "serve" : args[0];

async function main() {
  switch (command) {
    case "serve": {
      const { config, dir } = readConfig(flag("config") ?? "lenspack.yaml");
      const { hosts, close } = await openConfig(config, dir);
      for (const h of hosts) await seedBoards(h);
      const uiDir = typeof config.ui === "string" ? config.ui : config.ui?.dir;
      const ui = flag("ui") ?? process.env.LENSPACK_UI ?? (uiDir ? resolve(dir, uiDir) : undefined);
      const page = typeof config.ui === "object" ? { ...(config.ui.title ? { title: config.ui.title } : {}), ...(config.ui.home ? { home: config.ui.home } : {}), ...(config.ui.intro ? { intro: config.ui.intro } : {}) } : undefined;
      const port = Number(flag("port") ?? config.port ?? process.env.PORT ?? 8787);
      // Sign-in: auth.kind (or LENSPACK_AUTH); with neither, the built-in admin and a password.
      const auth = effectiveAuth(config.auth ? resolveSecrets(config.auth) : undefined);
      const { adapter, rights } = authFrom(auth, { dir, log: (m) => console.log(`lenspack: ${m}`) });
      // Open (none) is for a local demo: 127.0.0.1 unless the host is given on purpose.
      // Opened by LENSPACK_AUTH over a config's sign-in, only --host moves it off loopback.
      const openedByEnv = !adapter && config.auth?.kind !== "none";
      const host = flag("host") ?? (openedByEnv ? "127.0.0.1" : (config.host ?? (adapter ? "0.0.0.0" : "127.0.0.1")));
      if (!adapter) console.warn(`lenspack: auth is \`none\`: anyone who reaches ${host}:${port} may read and edit every board`);
      // Saved answers, when the config asks for them (docs/caching.md).
      const { file: cacheFile, ...cacheConfig } = typeof config.cache === "object" ? config.cache : {};
      // With state: the server's switches, the admins' definitions, open questions and the daily review, and the admin
      // panel at /_lenspack/admin/ for admins (with the saved answers' routes at /_lenspack/cache). The audit log goes
      // there by month unless audit: names a file.
      const stateDir = config.state ? resolve(dir, config.state) : undefined;
      const auditFile = config.audit ? resolve(dir, config.audit) : undefined;
      const monthly = stateDir && !auditFile ? rotatingAudit(stateDir) : null;
      const audit = auditFile ? fileAudit(auditFile) : monthly?.audit;
      const auditLog = audit ? { audit } : null;
      const events: ((from: Date) => AuditEvent[]) | undefined = auditFile ? auditFileSince(auditFile) : monthly ? (from) => monthly.since(from) : undefined;
      const admin = stateDir ? adminSettings(stateDir, { features: config.features as never, cache: cacheConfig as never, queue: config.queue, brand: config.brand }) : null;
      // What the assistant is called: with state, the admin panel may change it; without, the config and LENSPACK_BRAND_* alone.
      const brand = admin ? admin.brand : brandSettings({ config: config.brand, settings: null });
      const log = (m: string) => console.error(`lenspack: ${m}`);
      const review = admin && stateDir ? admin.review({ stateDir, hosts, events, audit, prefix: "/_lenspack", adminName: "admin", title: config.ui && typeof config.ui === "object" ? config.ui.title : undefined, log }) : null;
      // With state, saved answers follow the panel's switch and settings; without, the config's settings alone.
      const cache = cacheSettings(null, cacheConfig);
      const reuse = config.cache ? (admin ? admin.reuse : reuseLayer({ store: resolve(dir, cacheFile ?? "reuse.json"), settings: () => ({ ...cache.get(), on: true }), log })) : undefined;
      const gate = admin ? admin.gate : localTurnGate(queueSettings(null, config.queue).get);
      const cachePage = reuse ? cacheRoutes({ prefix: "/_lenspack", reuse, queue: gate, audit: auditLog ?? null, adminName: "admin" }) : null;
      // Usage telemetry, when the config has a telemetry: section (docs/telemetry.md).
      const tc = config.telemetry;
      const telemetry = tc ? fileTelemetry(resolve(dir, tc.dir), { retentionDays: () => tc.retentionDays, items: staticItems(tc), context: () => config.context ?? {} }).telemetry : undefined;
      const open = principalOf({ user: "local", roles: ["admin"], edit: true, maintain: true, usage: true });
      startRuntime({
        hosts,
        close,
        port,
        host,
        // With usage: in the config, every model call is also kept in a file that outlives the process.
        usageFile: config.usage ? resolve(dir, config.usage) : undefined,
        budget: config.budget,
        app: { ui, page, auth: adapter, rights, audit, historyTurns: config.historyTurns, reuse, queue: gate, explain: () => explainFrom(config.explain), brand: brand.get, ...(telemetry ? { telemetry } : {}), ...(admin && review ? { review: admin.app.review, definitions: review.turn } : {}) },
        log,
        routes: (rt) => {
          if (!review && !cachePage) return () => {};
          const panel = review?.routes(rt);
          return async (req, res, url, signedIn) => {
            const inPanel = url.pathname === "/_lenspack/admin" || url.pathname.startsWith("/_lenspack/admin/");
            const inCache = url.pathname === "/_lenspack/cache" || url.pathname.startsWith("/_lenspack/cache/");
            if (!(inPanel && panel) && !(inCache && cachePage)) return;
            // An open server (auth: none) has one local user, who may do everything.
            const who = adapter ? await signedIn() : open;
            if (!who) {
              if (adapter?.signInPath && inPanel && !url.pathname.startsWith("/_lenspack/admin/api/")) {
                res.writeHead(302, { location: adapter.signInPath(url), "cache-control": "no-store" });
                return void res.end();
              }
              res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
              return void res.end(JSON.stringify({ error: "sign in to use the admin panel" }));
            }
            if (inPanel && panel) await panel(req, res, url, who);
            else if (cachePage) await cachePage(req, res, url, who);
          };
        },
        onListening: () => {
          console.log(`lenspack: ${hosts.map((h) => `${h.name} (${h.connector.kind})`).join(", ")} on http://${host}:${port}/api${ui ? `, ui from ${ui}` : ""}${adapter ? `, sign-in by ${adapter.kind}` : ", open"}${review ? `; admin panel at /_lenspack/admin/` : ""}`);
          void review?.start();
        },
      });
      return;
    }
    case "superset": {
      // Superset mode lives in @lenspack/superset, which builds on this package, so it is loaded only when asked for.
      const superset = "@lenspack/superset/server";
      const { serveSuperset } = (await import(superset)) as { serveSuperset(file: string): Promise<void> };
      await serveSuperset(flag("config") ?? args[1] ?? "superset.yaml");
      return;
    }
    case "check": {
      const { config, dir } = readConfig(flag("config") ?? "lenspack.yaml");
      const { hosts, close } = await openConfig(config, dir);
      let failed = 0;
      for (const h of hosts) {
        for (const b of h.boards) {
          const data = await resolveBoard(buildBoard(h.pack, b), { pack: h.pack, connector: h.connector, ctx: h.ctx });
          for (const [id, d] of Object.entries(data)) {
            if (d.error) {
              failed++;
              console.log(`✗ ${h.name}/${b.id}/${id}: ${d.error}`);
            }
          }
          console.log(`${h.name}/${b.id}: ${Object.keys(data).length} widgets drawn on ${h.connector.kind}`);
        }
      }
      await close();
      console.log(failed ? `${failed} widget(s) failed` : "every widget drew");
      process.exit(failed ? 1 : 0);
    }
    case "sources": {
      // Only the connections: this is the step before a pack exists.
      const { config, dir } = readSourcesConfig(flag("config") ?? "lenspack.yaml");
      const { sources, close } = await openSources(config, dir);
      const only = flag("source");
      for (const [name, connector] of sources) {
        if (only && name !== only) continue;
        if (!connector.introspect) {
          console.log(`${name} (${connector.kind}) does not describe itself yet`);
          continue;
        }
        const schema = await connector.introspect();
        console.log(`${name} (${connector.kind})`);
        for (const c of schema.collections) console.log(`  ${c.name}${c.rows !== undefined ? ` (~${c.rows} rows)` : ""}\n${c.fields.map((f) => `    ${f.path}: ${f.type}`).join("\n")}`);
      }
      await close();
      return;
    }
    case "hash-password": {
      // Read from stdin, so the password is never an argument in the process list or shell history.
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const password = input.replace(/\r?\n$/, "");
      if (password.length < 12) throw new Error("the password must be at least 12 characters");
      console.log(hashPassword(password));
      return;
    }
    case "dss": {
      const input = args[1];
      const out = flag("out");
      if (!input || !out) throw new Error(USAGE);
      const dashboards = flag("dashboards");
      const r = compileDss(JSON.parse(readFileSync(input, "utf8")), dashboards ? JSON.parse(readFileSync(dashboards, "utf8")) : undefined, {
        pack: flag("pack"),
        placeholders: flag("placeholders")?.split(","),
      });
      mkdirSync(join(out, "boards"), { recursive: true });
      writeFileSync(join(out, "pack.yaml"), r.packYaml);
      for (const b of r.boards) writeFileSync(join(out, "boards", `${b.id}.json`), `${JSON.stringify({ title: b.title, ops: b.ops }, null, 2)}\n`);
      writeFileSync(join(out, "report.md"), r.report);
      console.log(r.report.split("\n").slice(2, 5).join("\n"));
      console.log(`wrote ${out}/pack.yaml, ${r.boards.length} board(s), report.md`);
      return;
    }
    default:
      console.log(USAGE);
      process.exit(command ? 2 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
