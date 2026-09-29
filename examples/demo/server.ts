// The demo host: every example with a seeded database, served by
// @lenspack/serve. A real deployment uses `lenspack serve --config` instead;
// this file only knows where the examples keep their data.
//   LENSPACK_DATA_DIR=./data PORT=8787 tsx server.ts        (files: <example>.duckdb)
//   LENSPACK_PG_URL=postgres://…                              (one Postgres for all)
//   LENSPACK_ES_URL=http://…                                  (campaign on Elasticsearch)
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { elasticsearchConnector } from "@lenspack/elasticsearch";
import { fileProposals } from "@lenspack/mcp";
import { type Host, buildProvider, createApp, probe, providersFromEnv, seedBoards } from "@lenspack/serve";
import { sqlConnector, sqlStore } from "@lenspack/sql";

import { type ExampleName, contextFor, examples } from "../index";

const dataDir = process.env.LENSPACK_DATA_DIR ?? ".";
const port = Number(process.env.PORT ?? 8787);

// Chat is optional. Providers come from the environment (see llm.ts); each
// is probed at startup and the first that answers is the default.
const providers = providersFromEnv().map(buildProvider);
void Promise.all(providers.map((p) => probe(p))).then((probed) => {
  probed.forEach((p, i) => (providers[i] = p));
  console.log(`[demo] chat providers: ${probed.map((p) => `${p.name}${p.available ? ` ok ${p.latencyMs}ms` : ` unavailable (${p.error})`}`).join("; ") || "(none)"}`);
});

const hosts: Host[] = [];
for (const name of Object.keys(examples) as ExampleName[]) {
  const ex = examples[name];
  let db;
  if (process.env.LENSPACK_PG_URL) db = await (await import("@lenspack/sql/pg")).openPostgres(process.env.LENSPACK_PG_URL);
  else {
    const file = join(dataDir, `${name}.duckdb`);
    if (!existsSync(file)) {
      console.warn(`[demo] no ${file}; run: pnpm seed ${name} ${file}`);
      continue;
    }
    db = await (await import("@lenspack/sql/duckdb")).openDuckdb(file);
  }
  const store = sqlStore(db);
  await store.migrate();
  // The campaign example reads a search index when one is configured; its
  // boards still live in the example's own database.
  const connector = name === "campaign" && process.env.LENSPACK_ES_URL ? elasticsearchConnector({ url: process.env.LENSPACK_ES_URL }) : sqlConnector(db.executor);
  const host: Host = {
    name,
    pack: ex.pack,
    packYaml: ex.packYaml,
    connector,
    store,
    ctx: contextFor[name],
    boards: ex.boards as Host["boards"],
    proposals: fileProposals(join(dataDir, `${name}.proposals.json`)),
  };
  await seedBoards(host);
  hosts.push(host);
}

const roles = process.env.LENSPACK_LLM_ROLES ? JSON.parse(process.env.LENSPACK_LLM_ROLES) : undefined;
createServer(createApp(hosts, { providers, roles })).listen(port, () =>
  console.log(`lenspack demo api: ${hosts.map((h) => `${h.name} (${h.connector.kind})`).join(", ") || "(no examples seeded)"} on http://localhost:${port}/api`),
);
