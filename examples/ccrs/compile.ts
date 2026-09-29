#!/usr/bin/env tsx
// Compile a CCRS KPI catalog into this example's pack, boards and skin map.
//   tsx examples/ccrs/compile.ts <dir with KpiDefinition.json, DashboardPack.json>
// Defaults to the catalog seeded in the CCRS repo (MIT), vendored under
// packages/ccrs/test/fixtures. A deployment passes the live MDMS export.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileCcrs } from "@lenspack/ccrs";

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] ?? join(here, "../../packages/ccrs/test/fixtures");
const read = (f: string) => JSON.parse(readFileSync(join(src, f), "utf8"));
const config = (() => {
  try {
    const c = read("DashboardConfig.json");
    return (Array.isArray(c) ? c.map((x: { data?: unknown }) => x.data ?? x) : [c]).find((x: { id?: string }) => x.id === "default") ?? {};
  } catch {
    return {};
  }
})() as { timeZone?: string };
const r = compileCcrs(read("KpiDefinition.json"), read("DashboardPack.json"), { timeZone: config.timeZone ?? "Africa/Nairobi" });
mkdirSync(join(here, "boards"), { recursive: true });
writeFileSync(join(here, "pack.yaml"), r.packYaml);
for (const b of r.boards) writeFileSync(join(here, "boards", `${b.id}.json`), `${JSON.stringify({ title: b.title, ops: b.ops, layout: b.layout, tiles: b.tiles, grid: { cols: 12, rowHeight: 52 } }, null, 2)}\n`);
writeFileSync(join(here, "skin.json"), `${JSON.stringify(r.skin, null, 2)}\n`);
console.log(`pack: ${r.pack.measures.length} measures, ${r.pack.dimensions.length} dimensions; boards: ${r.boards.map((b) => `${b.id} (${b.layout.length})`).join(", ")}`);
for (const n of r.notes) console.log(`note ${n.kpi}: ${n.note}`);
