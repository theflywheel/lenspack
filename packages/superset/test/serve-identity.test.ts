// The signed identity through the real board API: createApp given supersetAccess, as bin/serve.ts
// gives it. Sign-in adapters (password, oidc, proxy, tokens) are another way to say who is asking;
// Superset mode takes none of them, and nothing of theirs may stand in for the signed header.
import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, openConfig, readConfig, seedBoards } from "@lenspack/serve";
import { catalogueFrom } from "@lenspack/spec";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seed } from "../../../examples/campaign/seed";
import { IDENTITY_HEADER, type Identity, READ_ONLY_MESSAGE, signIdentity, supersetAccess } from "../src/identity";

const campaign = fileURLToPath(new URL("../../../examples/campaign/", import.meta.url));
const KEY = "k".repeat(64);
const now = () => Math.floor(Date.now() / 1000);

describe("Superset mode's board API", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-superset-identity-"));
  let server: Server;
  let api: string;
  let close: () => Promise<void>;
  let hosts: Awaited<ReturnType<typeof openConfig>>["hosts"];

  const signed = (id: Partial<Identity>) => signIdentity({ u: "someone", a: false, t: now(), ...id }, KEY);
  const call = async (header: string | null, path: string, init: RequestInit = {}) => {
    const r = await fetch(`${api}${path}`, { ...init, headers: { ...(header ? { [IDENTITY_HEADER]: header } : {}), "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: r.status, body: (await r.json()) as any };
  };

  beforeAll(async () => {
    const db = await openDuckdb(join(dir, "campaign.duckdb"));
    await seed(db.writer, "duckdb", { households: 300 });
    await db.close();
    const file = join(dir, "lenspack.yaml");
    writeFileSync(file, `sources:\n  data: { kind: duckdb, path: ${join(dir, "campaign.duckdb")} }\npacks:\n  - pack: ${campaign}pack.yaml\n    source: data\n    boards: ${campaign}boards\n    now: "2026-09-01T00:00:00Z"\nstore: { kind: memory }\n`);
    const { config, dir: base } = readConfig(file);
    const opened = await openConfig(config, base);
    for (const h of opened.hosts) await seedBoards(h);
    hosts = opened.hosts;
    close = opened.close;
    server = createServer(createApp(opened.hosts, { access: supersetAccess(() => KEY, "superset") }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(async () => {
    server.close();
    await close();
  });

  it("is not signed in without a valid, fresh signature, and offers no sign-in of its own", async () => {
    expect((await call(null, "")).status).toBe(401);
    expect((await call(signIdentity({ u: "x", a: true, t: now() }, "z".repeat(64)), "")).status).toBe(401);
    expect((await call(signed({ t: now() - 3600 }), "/campaign/overview/data")).status).toBe(401);
    // The sign-in adapters' routes are not there: no sign-in form, no session cookie to stand in for the header.
    const login = await fetch(`${api.replace(/\/api$/, "")}/auth/login`, { redirect: "manual" });
    expect(login.status).toBe(404);
    expect(login.headers.get("set-cookie")).toBeNull();
  });

  it("names the signed user, with Superset's rights, and opens the pack in full without any roles", async () => {
    const owner = await call(signed({ u: "owner", d: 1, e: true, v: true }), "");
    expect(owner.status).toBe(200);
    expect(owner.body.me).toMatchObject({ user: "owner", edit: true, maintain: true, usage: true });
    expect(owner.body.me.signOut).toBeUndefined();
    const pack = await call(signed({ u: "viewer", d: 1, e: false, v: true }), "/campaign");
    expect(pack.status).toBe(200);
    expect(pack.body.catalogue.dimensions.length).toBe(catalogueFrom(hosts[0]!.pack).dimensions.length);
    expect((await call(signed({ u: "viewer" }), "/campaign/pack")).status).toBe(200);
  });

  it("lets a viewer ask the chat but change nothing, with Superset's message", async () => {
    const viewer = signed({ u: "viewer", d: 1, e: false, v: true });
    expect((await call(viewer, "")).body.me).toMatchObject({ user: "viewer", edit: false, maintain: false, usage: false });
    const ops = await call(viewer, "/campaign/overview/ops", { method: "POST", body: JSON.stringify({ ops: [{ op: "set_title", title: "Mine" }] }) });
    expect(ops).toMatchObject({ status: 403, body: { error: READ_ONLY_MESSAGE } });
    // No model here, so the chat answers 503: not the 403 a caller without the read-only path gets.
    const chat = { method: "POST", body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: "how many?" }] }] }) };
    expect((await call(viewer, "/campaign/overview/chat", chat)).status).toBe(503);
  });

  it("refuses a sign-in adapter alongside the signed identity", () => {
    expect(() => createApp(hosts, { access: supersetAccess(() => KEY, "superset"), auth: {} as never })).toThrow(/auth or access, not both/);
  });
});
