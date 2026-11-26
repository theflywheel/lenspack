#!/usr/bin/env node
// pnpm demo [<data-dir>]   — serves every example with a <name>.duckdb in data-dir (default: the folder you ran it from)
import { spawn } from "node:child_process";
import { resolve } from "node:path";
// The demo server runs inside examples/demo, so a relative folder is resolved here, against the caller's.
const [dataDir = "."] = process.argv.slice(2);
const env = { ...process.env, LENSPACK_DATA_DIR: resolve(dataDir) };
const child = spawn("pnpm", ["--filter", "@lenspack/example-demo", "dev"], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
