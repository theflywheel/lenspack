import { mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seed } from "../../../../examples/campaign/seed";
import { type AuditEvent, type Principal, accessFrom, authSchema, createApp, openConfig, readConfig, seedBoards } from "../src";

// Who may see and change what: the access hook, the row scope it carries into
// every query, and the audit trail of changes and denials.

const campaign = fileURLToPath(new URL("../../../../examples/campaign/", import.meta.url));

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
    alice_a: { user: "alice", edit: true, tenant: "a" },
    alice_b: { user: "alice", edit: true, tenant: "b" },
    bob_a: { user: "bob", edit: true, tenant: "a" },
    bob_b: { user: "bob", edit: true, tenant: "b" },
    carol_a: { user: "carol", edit: true, tenant: "a" },
    BOB_a: { user: "BOB", edit: true, tenant: "a" },
    viewer: { user: "viewer" },
    reader: { user: "reader", readOnly: "You can view this board but not edit it." },
    scoped: { user: "scoped" }, // scope filled in once a province is known
    village: { user: "village", scope: [{ dimension: "village", op: "eq", value: "nowhere" }] },
    elsewhere: { user: "elsewhere", packs: ["another"] },
    elsewhere_b: { user: "eve", tenant: "b", packs: ["campaign"] },
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
    writeFileSync(file, `sources:\n  data: { kind: duckdb, path: ${join(dir, "campaign.duckdb")} }\npacks:\n  - pack: ${campaign}pack.yaml\n    source: data\n    boards: ${campaign}boards\n    now: "2026-09-01T00:00:00Z"\n  - pack: ${campaign}pack.yaml\n    name: pinned\n    source: data\n    tenant: a\n    now: "2026-09-01T00:00:00Z"\nstore: { kind: memory }\n`);
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

  it("lets a read-only caller talk to the chat, but not change the board by any other route", async () => {
    // No model is configured here, so the chat answers 503: what matters is that it is not the 403 a viewer gets.
    const chat = { method: "POST", body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: "how many?" }] }] }) };
    expect((await call("viewer", "/campaign/overview/chat", chat)).status).toBe(403);
    expect((await call("reader", "/campaign/overview/chat", chat)).status).toBe(503);
    expect((await call("reader", "/campaign/overview/data")).status).toBe(200);
    const ops = await call("reader", "/campaign/overview/ops", { method: "POST", body: JSON.stringify({ ops: [{ op: "set_title", title: "Mine" }] }) });
    expect(ops.status).toBe(403);
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

  it("checks a copy's title like any board's, so a long one still loads", async () => {
    const long = await call("editor", "/campaign/boards", { method: "POST", body: JSON.stringify({ title: "t".repeat(160) }) });
    const copy = await call("editor", `/campaign/${long.body.id}/copy`, { method: "POST", body: "{}" });
    expect((await call("editor", `/campaign/${copy.body.id}`)).status).toBe(200);
    expect((await call("editor", `/campaign/${long.body.id}/copy`, { method: "POST", body: JSON.stringify({ title: { x: 1 } }) })).status).not.toBe(200);
  });

  it("keeps a shared board within the tenant it was made in, even for the same user name", async () => {
    const made = await call("alice_a", "/campaign/boards", { method: "POST", body: JSON.stringify({ title: "Tenant a" }) });
    await call("alice_a", `/campaign/${made.body.id}/share`, { method: "POST", body: JSON.stringify({ shared: true }) });
    expect((await call("bob_a", `/campaign/${made.body.id}`)).status).toBe(200);
    expect((await call("alice_b", `/campaign/${made.body.id}`)).status).toBe(404);
    expect((await call("alice_b", `/campaign/${made.body.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("shares a board with the people its owner names, everyone optional, and tells only the owner who they are", async () => {
    const share = (who: string, id: string, body: unknown) => call(who, `/campaign/${id}/share`, { method: "POST", body: JSON.stringify(body) });
    const made = await call("alice_a", "/campaign/boards", { method: "POST", body: JSON.stringify({ title: "For bob" }) });
    const id = made.body.id as string;
    await call("carol_a", "/campaign");
    const named = await share("alice_a", id, { everyone: false, people: [" bob ", "bob", "alice", ""] });
    expect(named.body).toMatchObject({ owner: "alice", shared: true, everyone: false, people: ["bob"] });
    expect(events.at(-1)).toMatchObject({ user: "alice", board: id, action: "share", outcome: "ok", detail: "everyone no, 1 by name" });

    expect((await call("bob_a", `/campaign/${id}`)).body).toMatchObject({ writable: false, board: { owner: "alice", shared: true, everyone: false } });
    expect((await call("bob_a", `/campaign/${id}`)).body.board).not.toHaveProperty("people");
    const listed = async (who: string) => ((await call(who, "/campaign")).body.boards as Record<string, unknown>[]).find((b) => b.id === id);
    expect(await listed("bob_a")).toEqual(expect.objectContaining({ owner: "alice", shared: true, writable: false }));
    expect(await listed("bob_a")).not.toHaveProperty("people");
    expect(await listed("alice_a")).toMatchObject({ everyone: false, people: ["bob"] });
    // Neither someone not named, nor the same name in another tenant.
    expect((await call("carol_a", `/campaign/${id}`)).status).toBe(404);
    expect(await listed("carol_a")).toBeUndefined();
    expect((await call("bob_b", `/campaign/${id}`)).status).toBe(404);
    // Only its owner says who it is shared with.
    expect((await share("bob_a", id, { everyone: true, people: [] })).status).toBe(403);
    expect((await share("carol_a", id, { everyone: true, people: [] })).status).toBe(404);
    expect((await share("alice_a", id, { people: "bob" })).status).toBe(400);
    expect((await share("alice_a", id, {})).status).toBe(400);

    expect((await share("alice_a", id, { everyone: true, people: ["bob"] })).body).toMatchObject({ everyone: true, people: ["bob"] });
    expect((await call("carol_a", `/campaign/${id}`)).body.board).toEqual(expect.objectContaining({ owner: "alice", shared: true, everyone: true }));
    expect((await call("carol_a", `/campaign/${id}`)).body.board).not.toHaveProperty("people");
    expect((await call("bob_b", `/campaign/${id}`)).status).toBe(404);
    expect((await share("alice_a", id, { everyone: false, people: [] })).body).toMatchObject({ shared: false });
    expect(events.at(-1)).toMatchObject({ action: "unshare", detail: "everyone no, 0 by name" });
    expect((await call("bob_a", `/campaign/${id}`)).status).toBe(404);
  });

  it("matches a name whatever its case", async () => {
    const made = await call("alice_a", "/campaign/boards", { method: "POST", body: JSON.stringify({ title: "Any case" }) });
    const id = made.body.id as string;
    const named = await call("alice_a", `/campaign/${id}/share`, { method: "POST", body: JSON.stringify({ everyone: false, people: ["Bob", "bob", "ALICE", "Carol"] }) });
    expect(named.body).toMatchObject({ people: ["Bob", "Carol"] });
    expect((await call("bob_a", `/campaign/${id}`)).status).toBe(200);
    expect((await call("BOB_a", `/campaign/${id}`)).status).toBe(200);
    expect((await call("carol_a", `/campaign/${id}`)).status).toBe(200);
    expect((await call("bob_b", `/campaign/${id}`)).status).toBe(404);
    // One suggestion per name, and never the caller, whatever the case.
    await call("bob_a", "/campaign");
    await call("BOB_a", "/campaign/boards", { method: "POST", body: JSON.stringify({ title: "Owned as BOB" }) });
    const names = (await call("alice_a", "/_people")).body.people as string[];
    expect(names.filter((n) => n.toLowerCase() === "bob")).toHaveLength(1);
    expect((await call("BOB_a", "/_people")).body.people.map((n: string) => n.toLowerCase())).not.toContain("bob");
  });

  it("still takes { shared } from an older client: true is everyone, false is nobody", async () => {
    const made = await call("alice_a", "/campaign/boards", { method: "POST", body: JSON.stringify({ title: "Old client" }) });
    const share = (body: unknown) => call("alice_a", `/campaign/${made.body.id}/share`, { method: "POST", body: JSON.stringify(body) });
    await share({ everyone: false, people: ["bob"] });
    expect((await share({ shared: true })).body).toMatchObject({ shared: true, everyone: true, people: ["bob"] });
    expect((await call("carol_a", `/campaign/${made.body.id}`)).status).toBe(200);
    expect((await share({ shared: false })).body).toMatchObject({ shared: false, everyone: false, people: [] });
    expect((await call("bob_a", `/campaign/${made.body.id}`)).status).toBe(404);
  });

  it("offers editors the names of people in their tenant to share with, and nobody else", async () => {
    await call("bob_a", "/campaign");
    await call("bob_b", "/campaign");
    const names = (await call("alice_a", "/_people")).body.people as string[];
    expect(names).toContain("bob");
    expect(names).not.toContain("alice");
    expect(names).not.toContain("eve");
    expect((await call("alice_b", "/_people")).body.people).not.toContain("carol");
    expect((await call("viewer", "/_people")).status).toBe(403);
    expect((await call("reader", "/_people")).status).toBe(403);
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

  it("refuses a pack pinned to another tenant, and does not list it", async () => {
    const names = async (who: string) => ((await call(who, "")).body.examples as { example: string }[]).map((e) => e.example);
    expect(await names("alice_a")).toEqual(["campaign", "pinned"]);
    // A caller without a tenant reads the pack's own.
    expect(await names("editor")).toEqual(["campaign", "pinned"]);
    expect(await names("alice_b")).toEqual(["campaign"]);
    expect((await call("alice_a", "/pinned")).status).toBe(200);
    // Refused outright, as before, and recorded.
    expect((await call("alice_b", "/pinned")).status).toBe(403);
    expect(events.at(-1)).toMatchObject({ user: "alice", pack: "pinned", action: "open", outcome: "denied", detail: "tenant" });
    // Kept from the caller for another reason as well: not there at all.
    expect((await call("elsewhere_b", "/pinned")).status).toBe(404);
  });
});

describe("sign-in from lenspack.yaml", () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

  it("knows a bearer token's user, rights and scope", async () => {
    const access = accessFrom(authSchema.parse({ kind: "tokens", users: [{ user: "ops", token: "t-ops", edit: true }, { user: "ke", token: "t-ke", tenant: "ke" }] }))!;
    expect(await access(req({ authorization: "Bearer t-ops" }))).toEqual({ user: "ops", roles: [], edit: true, usage: false });
    expect(await access(req({ authorization: "Bearer t-ke" }))).toEqual({ user: "ke", roles: [], edit: false, usage: false, tenant: "ke" });
    expect(await access(req({ authorization: "Bearer nope" }))).toBeNull();
    expect(await access(req({}))).toBeNull();
  });

  it("trusts a proxy's user header only with the proxy's secret", async () => {
    const access = accessFrom(authSchema.parse({ kind: "proxy", secret: "s".repeat(32), editors: ["*"], maintainers: ["amina"] }))!;
    const as = (user: string) => access(req({ "x-lenspack-proxy-secret": "s".repeat(32), "x-forwarded-user": user }));
    expect(await as("amina")).toEqual({ user: "amina", roles: [], edit: true, maintain: true, usage: true });
    expect(await as("bo")).toEqual({ user: "bo", roles: [], edit: true, usage: false });
    expect(await access(req({ "x-forwarded-user": "amina" }))).toBeNull();
    // A role: entry is for roles: a user named like one gets nothing from it.
    const byRole = accessFrom(authSchema.parse({ kind: "proxy", secret: "s".repeat(32), rolesHeader: "x-forwarded-groups", maintainers: ["role:admins"] }))!;
    const with_ = (user: string, groups: string) => byRole(req({ "x-lenspack-proxy-secret": "s".repeat(32), "x-forwarded-user": user, "x-forwarded-groups": groups }));
    expect(await with_("role:admins", "")).toEqual({ user: "role:admins", roles: [], edit: false, usage: false });
    expect(await with_("kofi", "staff, admins")).toMatchObject({ roles: ["staff", "admins"], maintain: true });
    expect(() => accessFrom(authSchema.parse({ kind: "proxy", secret: "short" }))).toThrow(/16 characters/);
  });
});
