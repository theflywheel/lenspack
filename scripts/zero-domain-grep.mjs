#!/usr/bin/env node
// The genericity proof, part three. The core and the compiler must not know
// what any example is about. If a word from an example domain appears in
// their source, the abstraction has leaked and CI fails.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["packages/core/src", "packages/spec/src", "packages/sql/src", "packages/mcp/src", "packages/react/src"];
const WORDS = [
  "orders", "order_items", "revenue", "customers?", "products?", "refund(ed)?", "aov", "cart",
  "pageviews?", "session_id", "referrer", "bounced?", "visitors?",
  "districts?", "submissions?", "signals?", "themes?", "moderation", "redact(ed|ion)?", "consultation", "respondent", "initiative", "crop",
  "tickets?", "sla", "resolved_at", "escalated?", "priority",
  "iffy", "clerk",
];
const pattern = new RegExp(`\\b(${WORDS.join("|")})\\b`, "i");

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(p);
  }
};
for (const root of ROOTS) {
  try { walk(root); } catch { /* package may not exist yet */ }
}

let failures = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = pattern.exec(line);
    if (m) {
      failures++;
      console.log(`${file}:${i + 1}: "${m[1]}" — ${line.trim().slice(0, 100)}`);
    }
  });
}
if (failures) {
  console.error(`\nzero-domain grep: ${failures} domain word(s) found in ${ROOTS.join(", ")}`);
  process.exit(1);
}
console.log(`zero-domain grep: ${files.length} files clean`);
