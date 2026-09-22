#!/usr/bin/env tsx
// pnpm seed <commerce|events|consultation|tickets> <./file.duckdb | postgres://…>
import { type ExampleName, examples } from "../examples/index";

const [name, target] = process.argv.slice(2) as [ExampleName | undefined, string | undefined];
if (!name || !examples[name] || !target) {
  console.error(`usage: pnpm seed <${Object.keys(examples).join("|")}> <./file.duckdb | postgres://…>`);
  process.exit(2);
}

const db = target.startsWith("postgres") ? await (await import("@lenspack/sql/pg")).openPostgres(target) : await (await import("@lenspack/sql/duckdb")).openDuckdb(target);
const started = Date.now();
await examples[name].seed(db.writer, db.dialect);
console.log(`seeded ${name} into ${target} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
await db.close();
