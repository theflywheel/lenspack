import { readFile, writeFile } from "node:fs/promises";

// A measure the model drafted. It is written here, not into the pack: a human
// promotes it by editing the pack file, which is what "verified" means.
export type Proposal = {
  key: string;
  entity: string;
  agg: string;
  sql: string;
  filter?: string;
  format: string;
  label?: string;
  rationale: string;
  verified: false;
  proposedAt: string;
};

export interface ProposalStore {
  list(): Promise<Proposal[]>;
  add(p: Proposal): Promise<void>;
}

export function memoryProposals(): ProposalStore {
  const items: Proposal[] = [];
  return { list: async () => [...items], add: async (p) => void items.push(p) };
}

export function fileProposals(path: string): ProposalStore {
  const read = async (): Promise<Proposal[]> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Proposal[];
    } catch {
      return [];
    }
  };
  return {
    list: read,
    async add(p) {
      const items = await read();
      items.push(p);
      await writeFile(path, JSON.stringify(items, null, 2));
    },
  };
}
