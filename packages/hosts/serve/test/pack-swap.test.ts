// A hosted pack swapped while the server runs (createApp's setHost, used when an admin changes the pack): the next
// request reads the new pack, a request already running finishes on the pack it began with, and saved answers kept
// under the old pack are dropped.
import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { type BoardStore, memoryStore } from "@lenspack/core";
import type { Connector } from "@lenspack/engine";
import { parsePackText } from "@lenspack/pack";
import { afterAll, describe, expect, it } from "vitest";

import { type Host, type Reuse, createApp } from "../src";

const pack = parsePackText(readFileSync(fileURLToPath(new URL("../../../../examples/campaign/pack.yaml", import.meta.url)), "utf8"));
const connector = (kind: string) => ({ kind, capabilities: {} }) as unknown as Connector;

describe("swapping a hosted pack", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("serves the new pack from the next request on, finishes a running one on the old, and drops old saved answers", async () => {
    // A board list that waits until told: a request in the middle of it has already picked its host.
    let release!: () => void;
    let gate: Promise<void> | null = null;
    const inner = memoryStore();
    const store: BoardStore = { ...inner, list: async () => (gate && (await gate), inner.list()) };
    const pruned: Record<string, { pack: { description?: string } }>[] = [];
    const reuse = { attach: () => {}, prune: async (b: never) => (pruned.push(b), 0) } as unknown as Reuse;
    const host: Host = { name: "campaign", pack, packYaml: "pack: campaign # old\n", connector: connector("old"), store, ctx: {}, boards: [] };
    const app = createApp([host], { reuse });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/campaign`;
    const get = async (path = "") => (await fetch(`${base}${path}`)).json() as Promise<Record<string, unknown>>;

    expect(await get()).toMatchObject({ description: pack.description, source: "old" });

    gate = new Promise<void>((r) => (release = r));
    const running = get();
    await new Promise((r) => setTimeout(r, 100));
    await app.setHost("campaign", { pack: { ...pack, description: "Visits, in new words." }, packYaml: "pack: campaign # new\n", connector: connector("new") });
    gate = null;
    release();
    expect(await running).toMatchObject({ description: pack.description, source: "old" });

    expect(await get()).toMatchObject({ description: "Visits, in new words.", source: "new" });
    expect(await get("/pack")).toEqual({ yaml: "pack: campaign # new\n" });
    // Once at start, once for the swap, with the new pack as the base.
    expect(pruned.at(-1)!.campaign!.pack.description).toBe("Visits, in new words.");
    await expect(app.setHost("other", { pack, packYaml: "", connector: connector("x") })).rejects.toThrow("no pack other");
  });
});
