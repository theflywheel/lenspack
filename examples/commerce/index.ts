import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePackText } from "@lenspack/spec";

export { seed } from "./seed";

const here = dirname(fileURLToPath(import.meta.url));
export const pack = parsePackText(readFileSync(join(here, "pack.yaml"), "utf8"));
export const boards = readdirSync(join(here, "boards"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ id: f.replace(/\.json$/, ""), ...(JSON.parse(readFileSync(join(here, "boards", f), "utf8")) as { title: string; ops: unknown[] }) }));
