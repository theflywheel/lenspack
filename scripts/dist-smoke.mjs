#!/usr/bin/env node
// Imports every built package entry (each "exports" path of each
// packages/*/package.json) and checks that it exports at runtime every value
// its .d.ts promises. Tests run against source, so a bundler that drops a
// re-export (tsup's code splitting once lost @lenspack/mcp's
// `export * from "@lenspack/agent"`) passes them and breaks only the published
// package. Run after `pnpm build`.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

// A few names per entry that must be there whatever the .d.ts says, so an
// unresolved `export *` in a declaration file cannot hide a hole.
const KEY = {
  "@lenspack/mcp": ["createMcpServer", "sqlRawSql", "boardTools", "toVercelAI", "fileProposals", "memoryProposals", "assembleQuery", "defineTool"],
  "@lenspack/sql": ["sqlConnector", "compile", "runSql", "resolve", "run", "explain"],
  "@lenspack/agent": ["boardTools", "toVercelAI", "fileProposals"],
  "@lenspack/serve": ["createApp", "configSchema", "buildProvider"],
};

const entries = [];
for (const dir of readdirSync(join(root, "packages")).sort()) {
  const pkgFile = join(root, "packages", dir, "package.json");
  if (!existsSync(pkgFile)) continue;
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== "object" || !target.import) continue;
    const js = join(root, "packages", dir, target.import);
    const dts = target.types ? join(root, "packages", dir, target.types) : undefined;
    entries.push({ name: pkg.name + sub.slice(1), js, dts });
  }
}

const missingBuild = entries.filter((e) => !existsSync(e.js) || (e.dts && !existsSync(e.dts)));
if (missingBuild.length) {
  console.error(`dist-smoke: not built (run pnpm build): ${missingBuild.map((e) => e.name).join(", ")}`);
  process.exit(1);
}

// Resolve declarations the way a consumer would: through node_modules and each
// package's "types", not the monorepo's source paths.
const program = ts.createProgram(
  entries.flatMap((e) => (e.dts ? [e.dts] : [])),
  { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, skipLibCheck: true, noEmit: true, jsx: ts.JsxEmit.ReactJSX },
);
const checker = program.getTypeChecker();
const declaredValues = (dts) => {
  const source = program.getSourceFile(dts);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return [];
  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((s) => {
      const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
      return (target.flags & ts.SymbolFlags.Value) !== 0;
    })
    .map((s) => s.name);
};

// A declaration file importing a lenspack package it cannot resolve would hide its exports.
const unresolved = new Set();
for (const e of entries) {
  if (!e.dts) continue;
  for (const m of program.getSourceFile(e.dts)?.imports ?? []) {
    const spec = m.text;
    if (!spec.startsWith("@lenspack/")) continue;
    const r = ts.resolveModuleName(spec, e.dts, program.getCompilerOptions(), ts.sys);
    if (!r.resolvedModule) unresolved.add(`${e.name} -> ${spec}`);
  }
}

let failed = unresolved.size > 0;
for (const u of unresolved) console.error(`✗ cannot resolve declarations: ${u}`);
for (const e of entries) {
  let mod;
  try {
    mod = await import(pathToFileURL(e.js).href);
  } catch (err) {
    console.error(`✗ ${e.name}: import failed: ${err.message}`);
    failed = true;
    continue;
  }
  const want = new Set([...(e.dts ? declaredValues(e.dts) : []), ...(KEY[e.name] ?? [])]);
  const missing = [...want].filter((n) => !(n in mod)).sort();
  if (missing.length) {
    console.error(`✗ ${e.name}: declared but not exported at runtime: ${missing.join(", ")}`);
    failed = true;
  } else {
    console.log(`✓ ${e.name}: ${want.size} values`);
  }
}
process.exit(failed ? 1 : 0);
