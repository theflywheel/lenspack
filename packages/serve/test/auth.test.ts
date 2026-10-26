import { mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seed } from "../../../examples/campaign/seed";
import { type AuditEvent, type Principal, accessFrom, authSchema, createApp, openConfig, readConfig, seedBoards } from "../src";

// Who may see and change what: the access hook, the row scope it carries into
// every query, and the audit trail of changes and denials.

const campaign = fileURLToPath(new URL("../../../examples/campaign/", import.meta.url));

describe("serve with sign-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-auth-"));
  const events: AuditEvent[] = [];
  let server: Server;
  let api: string;
  let close: () => Promise<void>;
  let province: string;

  // The test's stand-in for a login proxy: x-user names a caller below.
  const people: Record<string, Principal> = {
    editor: { user: "editor", edit: true },
    other: { user: "other", edit: true },
    maintainer: { user: "maintainer", edit: true, maintain: true },
    viewer: { user: "viewer" },
    scoped: { user: "scoped" }, // scope filled in once a province is known
    village: { user: "village", scope: [{ dimension: "village", op: "eq", value: "nowhere" }] },
    elsewhere: { user: "elsewhere", packs: ["another"] },
  };
  const access = (req: IncomingMessage) => people[String(req.headers["x-user"] ?? "")] ?? null;
  const call = async (who: string | null, path: string, init: RequestInit = {}) => {
    const r = await fetch(`${api}${path}`, { ...init, headers: { ...(who ? { "x-user": who } : {}), "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: r.status, body: (await r.json()) as any };
  };

  beforeAll(async () => {
    const db = await openDuckdb(join(dir, "campaign.duckdb"));
    await seed(db.writer, "duckdb", { households: 3000 });
    await db.close();
    const file = join(dir, "lenspack.yaml");
    writeFileSync(file, `sources:\n  data: { kind: duckdb, path: ${join(dir, "campaign.duckdb")} }\npacks:\n  - pack: ${campaign}pack.yaml\n    source: data\n    boards: ${campaign}boards\n    now: "2026-09-01T00:00:00Z"\nstore: { kind: memory }\n`);
    const { config, dir: base } = readConfig(file);
    const opened = await openConfig(config, base);
    for (const h of opened.hosts) await seedBoards(h);
    close = opened.close;
    server = createServer(createApp(opened.hosts, { access, audit: (e) => events.push(e) }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const options = await call("editor", "/campaign/overview/options?field=province");
    province = options.body[0].value;
    people.scoped!.scope = [{ dimension: "province", op: "eq", value: province }];
  });
  afterAll(async () => {
    server.close();
    await close();
  });

  it("turns away a caller the deployment does not know", async () => {
    expect((await call(null, "")).status).toBe(401);
    expect((await call("stranger", "/campaign/overview/data")).status).toBe(401);
  });

  it("lets a viewer read but not change a board, and records the attempt", async () => {
    expect((await call("viewer", "/campaign/overview/data")).status).toBe(200);
    const denied = await call("viewer", "/campaign/overview/ops", { method: "POST", body: JSON.stringify({ ops: [{ op: "set_title", title: "Mine" }] }) });
    expect(denied.status).toBe(403);
    expect(events.at(-1)).toMatchObject({ user: "viewer", pack: "campaign", board: "overview", outcome: "denied" });
  });

  it("records a maintainer's change to the pack's board, and a refused one, by user", async () => {
    const ok = await call("maintainer", "/campaign/overview/ops", { method: "POST", body: JSON.stringify({ ops: [{ op: "set_title", title: "Campaign" }] }) });
    expect(ok.status).toBe(200);
    expect(events.at(-1)).toMatchObject({ user: "maintainer", action: "ops", outcome: "ok", detail: "set_title" });
    const widget = { kind: "kpi", title: "x", query: { kind: "value", measure: "vists" } };
    await call("maintainer", "/campaign/overview/ops", { method: "POST", body: JSON.stringify({ ops: [{ op: "add_widget", id: "x", widget }] }) });
    expect(events.at(-1)).toMatchObject({ user: "maintainer", action: "ops", outcome: "refused" });
  });

  it("keeps a board someone made theirs: hidden until shared, then read-only to others, who may copy it", async () => {
    const rename = (title: string) => ({ method: "POST", body: JSON.stringify({ ops: [{ op: "set_title", title }] }) });
    expect((await call("editor", "/campaign/overview/ops", rename("Mine now"))).status).toBe(403);
    const made = await call("editor", "/campaign/boards", { method: "POST", body: JSON.stringify({ title: "Editor's" }) });
    const id = made.body.id as string;
    expect((await call("editor", `/campaign/${id}/ops`, rename("Editor's board"))).status).toBe(200);

    const listed = async (who: string) => ((await call(who, "/campaign")).body.boards as { id: string; writable: boolean }[]).find((b) => b.id === id);
    expect(await listed("other")).toBeUndefined();
    expect((await call("other", `/campaign/${id}`)).status).toBe(404);
    expect((await call("other", `/campaign/${id}/share`, { method: "POST", body: JSON.stringify({ shared: true }) })).status).toBe(404);

    expect((await call("editor", `/campaign/${id}/share`, { method: "POST", body: JSON.stringify({ shared: true }) })).body.shared).toBe(true);
    expect(await listed("other")).toMatchObject({ writable: false, owner: "editor", shared: true });
    expect((await call("other", `/campaign/${id}`)).body.writable).toBe(false);
    expect((await call("other", `/campaign/${id}/ops`, rename("Taken"))).status).toBe(403);
    expect((await call("other", `/campaign/${id}`, { method: "DELETE" })).status).toBe(403);
    expect((await call("viewer", `/campaign/${id}/copy`, { method: "POST", body: "{}" })).status).toBe(403);

    const copy = await call("other", `/campaign/${id}/copy`, { method: "POST", body: "{}" });
    expect(await listed("other")).toMatchObject({ writable: false });
    const theirs = await call("other", `/campaign/${copy.body.id}`);
    expect(theirs.body).toMatchObject({ writable: true, board: { owner: "other", shared: false, config: { title: "Editor's board (copy)" } } });
    expect((await call("editor", `/campaign/${copy.body.id}`)).status).toBe(404);

    expect((await call("editor", `/campaign/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call("maintainer", "/campaign/overview", { method: "DELETE" })).status).toBe(403);
  });

  it("narrows every number to the caller's scope", async () => {
    const q = encodeURIComponent(JSON.stringify({ kind: "breakdown", dimension: "province", measure: "visits", limit: 50 }));
    const all = await call("editor", `/campaign/explain?q=${q}`);
    const mine = await call("scoped", `/campaign/explain?q=${q}`);
    expect(all.body.ok).toBe(true);
    expect(mine.body.native).toMatch(/province/i);
    expect(mine.body.native.length).toBeGreaterThan(all.body.native.length);
    const everyone = (await call("editor", "/campaign/overview/options?field=province")).body as { value: string }[];
    const theirs = (await call("scoped", "/campaign/overview/options?field=province")).body as { value: string }[];
    expect(everyone.length).toBeGreaterThan(1);
    expect(theirs.map((o) => o.value)).toEqual([province]);
  });

  it("refuses a number the caller's scope cannot reach, rather than showing it unnarrowed", async () => {
    // Targets live on projects, which have no village: that caller sees no coverage.
    const data = (await call("village", "/campaign/overview/data")).body;
    expect(data.coverage.error).toMatch(/limited by "village"/);
    expect(data.visits.error).toBeUndefined();
  });

  it("hides packs a caller may not open", async () => {
    expect((await call("elsewhere", "")).body.examples).toEqual([]);
    expect((await call("elsewhere", "/campaign/overview/data")).status).toBe(404);
  });
});

describe("sign-in from lenspack.yaml", () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

  it("knows a bearer token's user, rights and scope", async () => {
    const access = accessFrom(authSchema.parse({ kind: "tokens", users: [{ user: "ops", token: "t-ops", edit: true }, { user: "ke", token: "t-ke", tenant: "ke" }] }))!;
    expect(await access(req({ authorization: "Bearer t-ops" }))).toEqual({ user: "ops", edit: true });
    expect(await access(req({ authorization: "Bearer t-ke" }))).toEqual({ user: "ke", edit: false, tenant: "ke" });
    expect(await access(req({ authorization: "Bearer nope" }))).toBeNull();
    expect(await access(req({}))).toBeNull();
  });

  it("trusts a proxy's user header only with the proxy's secret", async () => {
    const access = accessFrom(authSchema.parse({ kind: "proxy", secret: "s".repeat(32), editors: ["*"], maintainers: ["amina"] }))!;
    const as = (user: string) => access(req({ "x-lenspack-proxy-secret": "s".repeat(32), "x-forwarded-user": user }));
    expect(await as("amina")).toEqual({ user: "amina", edit: true, maintain: true });
    expect(await as("bo")).toEqual({ user: "bo", edit: true });
    expect(await access(req({ "x-forwarded-user": "amina" }))).toBeNull();
    expect(() => accessFrom(authSchema.parse({ kind: "proxy", secret: "short" }))).toThrow(/16 characters/);
  });
});
