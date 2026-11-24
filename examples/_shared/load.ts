import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePackText } from "@lenspack/spec";

/** An example's pack.yaml (text and parsed) and boards/*.json, read from the directory of the module at `url`. */
export function loadExample(url: string) {
  const here = dirname(fileURLToPath(url));
  const packYaml = readFileSync(join(here, "pack.yaml"), "utf8");
  const boards = readdirSync(join(here, "boards"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ id: f.replace(/\.json$/, ""), ...(JSON.parse(readFileSync(join(here, "boards", f), "utf8")) as { title: string; ops: unknown[] }) }));
  return { packYaml, pack: parsePackText(packYaml), boards };
}
