import { readFile } from "node:fs/promises";

import YAML from "yaml";

import { type Pack, type PackProblem, checkPack, packSchema } from "./pack";

export class PackError extends Error {
  constructor(
    message: string,
    public readonly problems: PackProblem[],
  ) {
    super(message);
    this.name = "PackError";
  }
}

/** Parses and fully validates a pack from an object (already parsed YAML/JSON). */
export function parsePack(input: unknown): Pack {
  const parsed = packSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    throw new PackError(`Invalid pack: ${problems.map((p) => `${p.path}: ${p.message}`).join("; ")}`, problems);
  }
  const problems = checkPack(parsed.data);
  if (problems.length > 0)
    throw new PackError(`Invalid pack: ${problems.map((p) => `${p.path}: ${p.message}`).join("; ")}`, problems);
  return parsed.data;
}

export function parsePackText(text: string): Pack {
  return parsePack(YAML.parse(text));
}

export async function loadPack(path: string): Promise<Pack> {
  return parsePackText(await readFile(path, "utf8"));
}
