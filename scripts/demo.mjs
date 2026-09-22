#!/usr/bin/env node
// pnpm demo [<data-dir>]   — serves every example with a <name>.duckdb in data-dir (default .)
import { spawn } from "node:child_process";
const [dataDir = "."] = process.argv.slice(2);
const env = { ...process.env, LENSPACK_DATA_DIR: dataDir };
const child = spawn("pnpm", ["--filter", "@lenspack/example-demo", "dev"], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
