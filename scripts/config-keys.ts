#!/usr/bin/env tsx
// pnpm docs:keys — writes the "Every key" tables in docs/reference from the zod schemas, so the reference lists
// every key of lenspack.yaml and of a pack with its type, whether it is required, and its default. Each table sits
// between <!-- keys:<name> --> and <!-- /keys:<name> --> in its page; the text around it is written by hand.
// With --check it changes nothing and exits 1 when a table is out of date (for CI or a pre-commit hook).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { configSchema } from "../packages/hosts/serve/src/config";
import { packSchema } from "../packages/kernel/pack/src/pack";

type Row = { path: string; type: string; def?: string; required: boolean };
// zod's internals are not typed for walking; these are the few fields read.
type Def = { typeName: string; [k: string]: unknown };
type Schema = { _def: Def; shape?: Record<string, Schema> };

const def = (s: Schema) => s._def as Def & Record<string, any>;

function unwrap(s: Schema): { s: Schema; optional: boolean; value?: unknown } {
  let optional = false;
  let value: unknown;
  for (;;) {
    const d = def(s);
    if (d.typeName === "ZodOptional" || d.typeName === "ZodNullable") {
      optional = true;
      s = d.innerType;
    } else if (d.typeName === "ZodDefault") {
      optional = true;
      value = d.defaultValue();
      s = d.innerType;
    } else if (d.typeName === "ZodEffects") s = d.schema;
    else if (d.typeName === "ZodLazy") s = d.getter();
    else return { s, optional, value };
  }
}

const shapeOf = (s: Schema): Record<string, Schema> => (typeof (s as any).shape === "function" ? (s as any).shape() : (s.shape ?? {}));
const optionsOf = (s: Schema): Schema[] => {
  const o = def(s).options;
  return Array.isArray(o) ? o : [...(o as Map<string, Schema>).values()];
};

// A SQL fragment: text, or a map with one entry per database. Shown as one type, not expanded.
const isFragment = (s: Schema) => {
  const d = def(s);
  if (d.typeName !== "ZodUnion") return false;
  const o = optionsOf(s).map((x) => unwrap(x).s);
  return o.some((x) => def(x).typeName === "ZodString") && o.some((x) => def(x).typeName === "ZodObject" && "default" in shapeOf(x) && "postgres" in shapeOf(x));
};

function typeName(s: Schema): string {
  const d = def(s);
  if (isFragment(s)) return "SQL fragment (text, or one per database)";
  switch (d.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodLiteral":
      return `\`${JSON.stringify(d.value)}\``;
    case "ZodEnum":
      return (d.values as string[]).map((v) => `\`${v}\``).join(", ");
    case "ZodArray":
      return `list of ${typeName(unwrap(d.type).s)}`;
    case "ZodRecord":
      return `map of ${typeName(unwrap(d.valueType).s)}`;
    case "ZodObject":
      return "object";
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const names = [...new Set(optionsOf(s).map((o) => typeName(unwrap(o).s)))];
      return names.length === 1 ? names[0]! : names.join(" or ");
    }
    case "ZodUnknown":
    case "ZodAny":
      return "any";
    default:
      return d.typeName.replace(/^Zod/, "").toLowerCase();
  }
}

// Keys documented on a page of their own: one row, not expanded.
const ELSEWHERE: Record<string, string> = { "pack.examples[].query": "a query: see [Query format](query.md)" };

function walk(s0: Schema, path: string, rows: Row[]) {
  const { s, optional, value } = unwrap(s0);
  const d = def(s);
  if (ELSEWHERE[path]) return void rows.push({ path, type: ELSEWHERE[path]!, required: !optional });
  rows.push({ path, type: typeName(s), def: value === undefined ? undefined : JSON.stringify(value), required: !optional });
  const into = (inner: Schema, prefix: string) => {
    const u = unwrap(inner).s;
    if (def(u).typeName === "ZodObject") for (const [k, v] of Object.entries(shapeOf(u))) walk(v, `${prefix}.${k}`, rows);
    if ((def(u).typeName === "ZodUnion" || def(u).typeName === "ZodDiscriminatedUnion") && !isFragment(u)) forms(u, prefix);
  };
  const forms = (u: Schema, prefix: string) =>
    optionsOf(u).forEach((o, i) => {
      const x = unwrap(o).s;
      if (def(x).typeName !== "ZodObject") return;
      const shape = shapeOf(x);
      const kind = shape.kind ? unwrap(shape.kind).s : null;
      const tag = kind ? (def(kind).value ?? (def(kind).values as string[] | undefined)?.join("|")) : undefined;
      const label = tag !== undefined ? `kind: ${tag}` : `form ${i + 1}`;
      for (const [k, v] of Object.entries(shape)) walk(v, `${prefix} (${label}).${k}`, rows);
    });
  if (d.typeName === "ZodObject") for (const [k, v] of Object.entries(shapeOf(s))) walk(v, `${path}.${k}`, rows);
  if (d.typeName === "ZodArray") into(d.type, `${path}[]`);
  if (d.typeName === "ZodRecord") into(d.valueType, `${path}.<name>`);
  if ((d.typeName === "ZodUnion" || d.typeName === "ZodDiscriminatedUnion") && !isFragment(s)) forms(s, path);
}

function table(name: string, schema: Schema): string {
  const rows: Row[] = [];
  walk(schema, name, rows);
  const lines = ["| key | type | required | default |", "|---|---|---|---|"];
  for (const r of rows.slice(1)) lines.push(`| \`${r.path.slice(name.length + 1).replace(/\|/g, "\\|")}\` | ${ELSEWHERE[r.path] ? r.type : r.type.replace(/\|/g, "\\|")} | ${r.required ? "yes" : ""} | ${r.def ? `\`${r.def}\`` : ""} |`);
  return lines.join("\n");
}

const root = join(import.meta.dirname, "..");
const targets: { file: string; name: string; schema: Schema }[] = [
  { file: "docs/reference/config.md", name: "lenspack.yaml", schema: configSchema as unknown as Schema },
  { file: "docs/reference/pack.md", name: "pack", schema: packSchema as unknown as Schema },
];
const check = process.argv.includes("--check");
let stale = 0;
for (const t of targets) {
  const path = join(root, t.file);
  const text = readFileSync(path, "utf8");
  const open = `<!-- keys:${t.name} -->`;
  const close = `<!-- /keys:${t.name} -->`;
  const a = text.indexOf(open);
  const b = text.indexOf(close);
  if (a < 0 || b < a) throw new Error(`${t.file} has no ${open} … ${close} block`);
  const next = `${text.slice(0, a + open.length)}\n\n${table(t.name, t.schema)}\n\n${text.slice(b)}`;
  if (next === text) continue;
  stale++;
  if (check) console.error(`${t.file}: the ${t.name} keys table is out of date; run pnpm docs:keys`);
  else writeFileSync(path, next);
}
if (check && stale) process.exit(1);
