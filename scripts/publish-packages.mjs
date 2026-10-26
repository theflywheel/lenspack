#!/usr/bin/env node
// Publishes the public packages under packages/* to GitHub Packages.
//
// The source keeps the @lenspack/* names, so code, tests and docs never change.
// GitHub Packages only takes npm packages scoped to the repository owner, so at
// publish time each package is staged into its own directory with a rewritten
// package.json:
//
//   name                      @lenspack/core       -> @theflywheel/lenspack-core
//   version                   from --version (the release tag)
//   workspace dependencies    "@lenspack/spec": "workspace:*"
//                          -> "@lenspack/spec": "npm:@theflywheel/lenspack-spec@<version>"
//
// The dependency keeps its @lenspack/* key as an npm alias, so the built code,
// which imports "@lenspack/spec", resolves inside every package's own
// node_modules without any change to dist, while the package it installs is the
// published @theflywheel/lenspack-spec.
//
// Usage:
//   node scripts/publish-packages.mjs --version 0.1.0 --dry-run   # npm publish --dry-run per package
//   node scripts/publish-packages.mjs --version 0.1.0 --pack DIR  # pnpm pack each package into DIR
//   node scripts/publish-packages.mjs --version 0.1.0             # publish for real (CI only)
//
// Run `pnpm build` first. Packages marked "private" are skipped.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_SCOPE = "@lenspack/";
const PUBLISH_SCOPE = "@theflywheel";
const PREFIX = "lenspack-";
const DEFAULT_REGISTRY = "https://npm.pkg.github.com";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { dryRun: false, out: join(root, ".publish"), registry: DEFAULT_REGISTRY };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--version") args.version = next();
    else if (a === "--pack") args.pack = resolve(next());
    else if (a === "--out") args.out = resolve(next());
    else if (a === "--registry") args.registry = next();
    else if (a === "--tag") args.tag = next();
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const publishedName = (sourceName) => `${PUBLISH_SCOPE}/${PREFIX}${sourceName.slice(SOURCE_SCOPE.length)}`;

function readPackages() {
  const dir = join(root, "packages");
  return readdirSync(dir)
    .map((d) => join(dir, d))
    .filter((d) => existsSync(join(d, "package.json")))
    .map((d) => ({ dir: d, manifest: JSON.parse(readFileSync(join(d, "package.json"), "utf8")) }))
    .filter((p) => !p.manifest.private);
}

// Every path an export map, main, types or bin points at must exist in the stage.
function exportTargets(m) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(m.exports);
  walk(m.main);
  walk(m.types);
  walk(m.bin);
  return out;
}

function rewriteDeps(deps, names, version, owner) {
  if (!deps) return deps;
  const out = {};
  for (const [key, range] of Object.entries(deps)) {
    if (key.startsWith(SOURCE_SCOPE)) {
      if (!names.has(key)) throw new Error(`${owner} depends on ${key}, which is not a public package`);
      out[key] = `npm:${publishedName(key)}@${version}`;
    } else if (String(range).startsWith("workspace:")) {
      throw new Error(`${owner} has a workspace dependency on ${key} that is not under ${SOURCE_SCOPE}`);
    } else out[key] = range;
  }
  return out;
}

function stage(pkg, names, version, outDir, registry) {
  const m = pkg.manifest;
  const short = m.name.slice(SOURCE_SCOPE.length);
  const dest = join(outDir, short);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  for (const f of m.files ?? []) {
    const src = join(pkg.dir, f);
    if (!existsSync(src)) throw new Error(`${m.name}: "${f}" is in files but missing. Run pnpm build first.`);
    cpSync(src, join(dest, f), { recursive: true });
  }
  if (existsSync(join(pkg.dir, "README.md"))) cpSync(join(pkg.dir, "README.md"), join(dest, "README.md"));
  cpSync(join(root, "LICENSE"), join(dest, "LICENSE"));

  const { devDependencies, scripts, ...rest } = m;
  const manifest = {
    ...rest,
    name: publishedName(m.name),
    version,
    dependencies: rewriteDeps(m.dependencies, names, version, m.name),
    peerDependencies: rewriteDeps(m.peerDependencies, names, version, m.name),
    optionalDependencies: rewriteDeps(m.optionalDependencies, names, version, m.name),
    publishConfig: { registry },
  };
  // The shapes npm would otherwise "auto-correct" with a warning on publish.
  if (manifest.repository?.url?.startsWith("https://")) manifest.repository.url = `git+${manifest.repository.url}.git`;
  if (manifest.bin) manifest.bin = Object.fromEntries(Object.entries(manifest.bin).map(([k, v]) => [k, v.replace(/^\.\//, "")]));
  for (const k of ["dependencies", "peerDependencies", "optionalDependencies"]) if (!manifest[k]) delete manifest[k];

  const missing = exportTargets(manifest).filter((t) => !existsSync(join(dest, t)));
  if (missing.length) throw new Error(`${m.name}: exports point at missing files: ${missing.join(", ")}`);
  if (JSON.stringify(manifest).includes("workspace:")) throw new Error(`${m.name}: workspace: range left after rewrite`);

  writeFileSync(join(dest, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { source: m.name, name: manifest.name, dir: dest, deps: Object.keys(m.dependencies ?? {}).filter((d) => names.has(d)) };
}

// Dependencies first, so a publish that stops halfway never leaves a package
// pointing at a sibling version that does not exist yet.
function topoSort(staged) {
  const byName = new Map(staged.map((s) => [s.source, s]));
  const done = new Set();
  const order = [];
  const visit = (s, seen = new Set()) => {
    if (done.has(s.source)) return;
    if (seen.has(s.source)) throw new Error(`dependency cycle at ${s.source}`);
    seen.add(s.source);
    for (const d of s.deps) visit(byName.get(d), seen);
    done.add(s.source);
    order.push(s);
  };
  staged.forEach((s) => visit(s));
  return order;
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
}

const args = parseArgs(process.argv.slice(2));
const packages = readPackages();
const version = (args.version ?? packages[0].manifest.version).replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a semver version: ${version}`);
const tag = args.tag ?? (version.includes("-") ? "next" : "latest");
const names = new Set(packages.map((p) => p.manifest.name));

mkdirSync(args.out, { recursive: true });
const order = topoSort(packages.map((p) => stage(p, names, version, args.out, args.registry)));

console.log(`\n${order.length} packages at ${version} (dist-tag ${tag}), staged in ${args.out}:`);
for (const s of order) console.log(`  ${s.source.padEnd(26)} -> ${s.name}`);

if (args.pack) {
  mkdirSync(args.pack, { recursive: true });
  for (const s of order) run("pnpm", ["pack", "--pack-destination", args.pack], s.dir);
} else {
  for (const s of order) {
    console.log(`\n== ${s.name}@${version}`);
    run("npm", ["publish", "--registry", args.registry, "--tag", tag, ...(args.dryRun ? ["--dry-run"] : [])], s.dir);
  }
}
