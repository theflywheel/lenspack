#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

import { compileDss } from "@lenspack/dss";
import { resolveBoard } from "@lenspack/engine";

import { buildBoard, createApp, seedBoards } from "./app";
import { accessFrom, fileAudit } from "./auth";
import { openConfig, readConfig, resolveSecrets } from "./config";
import { buildProvider, probe, providersFromEnv } from "./llm";

const USAGE = `lenspack <command>

  serve  --config lenspack.yaml [--port 8787]   the board API (and --ui dir, or ui: in the config)
  check  --config lenspack.yaml                 draw every board against its source; exit 1 on any error
  sources --config lenspack.yaml [--source s]   what each source holds: tables or indexes, fields, types, rows
  dss    ChartApiConfig.json [--dashboards MasterDashboardConfig.json]
         [--placeholders PVAR,…] [--pack name] --out dir
                                                DIGIT DSS chart configs → pack.yaml, boards/, report.md
`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const command = args[0];

async function main() {
  switch (command) {
    case "serve": {
      const { config, dir } = readConfig(flag("config") ?? "lenspack.yaml");
      const { hosts } = await openConfig(config, dir);
      for (const h of hosts) await seedBoards(h);
      const providers = providersFromEnv().map(buildProvider);
      void Promise.all(providers.map((p) => probe(p))).then((probed) => probed.forEach((p, i) => (providers[i] = p)));
      const roles = process.env.LENSPACK_LLM_ROLES ? JSON.parse(process.env.LENSPACK_LLM_ROLES) : undefined;
      const ui = flag("ui") ?? (config.ui ? resolve(dir, config.ui) : undefined);
      const port = Number(flag("port") ?? config.port ?? process.env.PORT ?? 8787);
      const access = config.auth ? accessFrom(resolveSecrets(config.auth)) : undefined;
      // No auth block: local use only. An open API on the network is a choice
      // the config has to spell out (auth: { kind: none }).
      const host = flag("host") ?? config.host ?? (config.auth ? "0.0.0.0" : "127.0.0.1");
      if (!access) console.warn(config.auth ? "lenspack: auth is `none` — anyone who reaches this port may read and edit every board" : "lenspack: no auth configured — listening on 127.0.0.1 only");
      const audit = config.audit ? fileAudit(resolve(dir, config.audit)) : undefined;
      createServer(createApp(hosts, { ui, providers, roles, access, audit })).listen(port, host, () => {
        console.log(`lenspack: ${hosts.map((h) => `${h.name} (${h.connector.kind})`).join(", ")} on http://${host}:${port}/api${ui ? `, ui from ${ui}` : ""}${access ? `, sign-in by ${config.auth!.kind}` : ""}`);
      });
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
      const { config, dir } = readConfig(flag("config") ?? "lenspack.yaml");
      const { sources, close } = await openConfig(config, dir);
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
