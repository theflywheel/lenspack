#!/usr/bin/env node
// pnpm demo <example> [<./file.duckdb | postgres://…>]
import { spawn } from "node:child_process";
const [name = "commerce", db = `./${name}.duckdb`] = process.argv.slice(2);
const env = { ...process.env, LENSPACK_EXAMPLE: name, LENSPACK_DB: db };
const child = spawn("pnpm", ["--filter", "@lenspack/example-demo", "dev"], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
