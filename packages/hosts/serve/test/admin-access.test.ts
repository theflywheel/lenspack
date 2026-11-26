// Who is an admin and who may use the assistant (admin-access.ts), the routes admins change them with, and the admin
// pages' own password sign-in (admin-signin.ts).
import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PASSWORD_ADMIN, type Rights, adminRights, mayUse, principalOf } from "@lenspack/policy";
import { afterEach, describe, expect, it } from "vitest";

import { accessRights, adminAccessSetup, adminRoutes, adminSettings, adminSignIn, settingsGrants, userAccessSetup } from "../src";
import { settingsStore } from "../src/settings";

const tmp = () => mkdtempSync(join(tmpdir(), "lp-access-"));
const HOST: Rights = { editors: [], maintainers: [], admins: ["role:Admin"], usage: ["role:Admin"] };

describe("admin access setup", () => {
  it("superset-role by default, saying where its roles come from", () => {
    const a = adminAccessSetup({ env: {}, grants: settingsGrants(settingsStore(tmp())) });
    expect(a.mode).toBe("superset-role");
    expect(a.line()).toBe("admins: Superset role Admin (access superset-role, the default)");
    expect(a.warnings).toEqual([]);
  });

  it("refuses an unknown mode, and owners written as roles", () => {
    expect(() => adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "everyone" }, grants: settingsGrants(settingsStore(tmp())) })).toThrow(/superset-role, superset-users or password/);
    expect(() => adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "superset-users", LENSPACK_ADMIN_USERS: "role:Admin" }, grants: settingsGrants(settingsStore(tmp())) })).toThrow(/roles grant nothing/);
  });

  it("superset-users: counts owners and grants in the start-up line; with no owner, says nobody", () => {
    const grants = settingsGrants(settingsStore(tmp()));
    grants.add({ user: "bea", by: "olga", at: "2026-01-01T00:00:00Z" });
    const a = adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "superset-users", LENSPACK_ADMIN_USERS: "olga, id:42" }, grants });
    expect(a.line()).toBe("admins: named Superset users (2 owners from LENSPACK_ADMIN_USERS, 1 granted; access superset-users, from LENSPACK_ADMIN_ACCESS)");
    const none = adminAccessSetup({ config: { adminAccess: "superset-users" }, env: {}, grants });
    expect(none.line()).toMatch(/0 owners, 1 granted; access superset-users, from auth.adminAccess\): NOBODY/);
    expect(none.warnings[0]).toMatch(/no owner is named: nobody is an admin/);
    expect(adminRights({ user: "bea", roles: [] }, none.state()).administer).toBe(false);
  });

  it("password: says whether one is set, never what it is", () => {
    const set = adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "password", LENSPACK_ADMIN_PASSWORD: "a-long-test-password" }, grants: settingsGrants(settingsStore(tmp())) });
    expect(set.line()).toBe("admins: one shared password (LENSPACK_ADMIN_PASSWORD set; access password, from LENSPACK_ADMIN_ACCESS)");
    expect(JSON.stringify(set.view())).not.toContain("a-long-test-password");
    const unset = adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "password" }, grants: settingsGrants(settingsStore(tmp())) });
    expect(unset.line()).toMatch(/NOT SET: nobody is an admin/);
    expect(unset.warnings[0]).toMatch(/no password is set/);
  });

  it("warns when owners are named under another mode", () => {
    const a = adminAccessSetup({ env: { LENSPACK_ADMIN_USERS: "olga" }, grants: settingsGrants(settingsStore(tmp())) });
    expect(a.warnings[0]).toMatch(/LENSPACK_ADMIN_USERS is set but admin access is superset-role/);
  });
});

describe("user access setup", () => {
  it("superset-role by default: everyone signed in when no role is named, as before", () => {
    const u = userAccessSetup({ env: {}, grants: settingsGrants(settingsStore(tmp()), "userGrants") });
    expect(u.rule()).toBeUndefined();
    expect(u.line()).toBe("users: everyone signed in (access superset-role, the default)");
  });

  it("granted with nobody: a note, and only admins", () => {
    const u = userAccessSetup({ env: { LENSPACK_USER_ACCESS: "granted" }, grants: settingsGrants(settingsStore(tmp()), "userGrants") });
    expect(u.rule()).toEqual([]);
    expect(u.warnings[0]).toMatch(/nobody is granted yet/);
  });

  it("everyone: a warning that it is for a dedicated instance", () => {
    const u = userAccessSetup({ env: { LENSPACK_USER_ACCESS: "everyone" }, grants: settingsGrants(settingsStore(tmp()), "userGrants") });
    expect(u.warnings[0]).toMatch(/dedicated instance/);
  });

  it("superset-role,granted: roles and grants both let people in; seeded people come from LENSPACK_USERS", () => {
    const grants = settingsGrants(settingsStore(tmp()), "userGrants");
    grants.add({ user: "bea", by: "ana", at: "2026-01-01T00:00:00Z" });
    const u = userAccessSetup({ env: { LENSPACK_USER_ACCESS: "superset-role,granted", LENSPACK_USERS: "cid" }, grants, roles: ["role:Field"] });
    expect(u.rule()).toEqual(["role:Field", "cid", "bea"]);
    expect(u.line()).toBe("users: Superset role Field, or 1 seeded from LENSPACK_USERS and 1 granted and admins (access superset-role,granted, from LENSPACK_USER_ACCESS)");
    expect(() => userAccessSetup({ env: { LENSPACK_USER_ACCESS: "friends" }, grants })).toThrow(/superset-role, granted and everyone/);
  });

  it("applies a grant to the next request through the live rights", () => {
    const store = settingsStore(tmp());
    const users = userAccessSetup({ env: { LENSPACK_USER_ACCESS: "granted" }, grants: settingsGrants(store, "userGrants") });
    const rights = accessRights(HOST, undefined, users);
    expect(mayUse(principalOf({ user: "bea", roles: ["Gamma"] }, rights))).toBe(false);
    users.grants.add({ user: "bea", by: "ana", at: "2026-01-01T00:00:00Z" });
    expect(mayUse(principalOf({ user: "bea", roles: ["Gamma"] }, rights))).toBe(true);
    users.grants.remove("bea");
    expect(mayUse(principalOf({ user: "bea", roles: ["Gamma"] }, rights))).toBe(false);
  });
});

describe("the admins and users routes", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function start(env: NodeJS.ProcessEnv) {
    const dir = tmp();
    const settings = adminSettings(dir, {}, env);
    const access = adminAccessSetup({ env, grants: settingsGrants(settings.settings, "adminGrants") });
    const users = userAccessSetup({ env, grants: settingsGrants(settings.settings, "userGrants") });
    const rights = accessRights(HOST, access, users);
    const audited: string[] = [];
    const audit = { audit: (e: { user: string; action: string; outcome: string; detail?: string }) => audited.push(`${e.user} ${e.action} ${e.outcome}${e.detail ? ` ${e.detail}` : ""}`), file: "", retentionDays: 90, months: () => [], read: () => [], since: () => [] };
    const routes = adminRoutes({ prefix: "/_x", settings, providers: [], audit, log: () => {}, adminName: "admin", writable: () => true, access, users });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://x");
      const who = principalOf({ user: String(req.headers["x-user"]), roles: String(req.headers["x-roles"] ?? "").split(",").filter(Boolean) }, rights);
      await routes(req, res, url, who);
      if (!res.headersSent) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}/_x`;
    const as = (user: string, roles = "", init: RequestInit = {}) => ({ ...init, headers: { "x-user": user, "x-roles": roles, "content-type": "application/json" } });
    const put = (path: string, user: string, body: unknown, roles = "") => fetch(`${at}${path}`, as(user, roles, { method: "PUT", body: JSON.stringify(body) }));
    return { at, as, put, audited, rights };
  }

  it("superset-users: a Superset Admin is refused; an owner grants and removes; a granted admin may not grant", async () => {
    const { at, as, put, audited } = await start({ LENSPACK_ADMIN_ACCESS: "superset-users", LENSPACK_ADMIN_USERS: "olga" });
    expect((await fetch(`${at}/settings/admins`, as("ana", "Admin"))).status).toBe(403);
    const view = await (await fetch(`${at}/settings/admins`, as("olga", "Gamma"))).json();
    expect(view).toMatchObject({ mode: "superset-users", owners: ["olga"], ownersFrom: "LENSPACK_ADMIN_USERS", granted: [], canGrant: true });
    expect((await put("/settings/admins", "olga", { add: "bea" }, "Gamma")).status).toBe(200);
    expect((await put("/settings/admins", "olga", { add: "bea" })).status).toBe(409);
    const granted = await (await fetch(`${at}/settings/admins`, as("bea", "Gamma"))).json();
    expect(granted).toMatchObject({ granted: [{ user: "bea", by: "olga" }], canGrant: false });
    expect((await put("/settings/admins", "bea", { add: "cid" })).status).toBe(403);
    expect((await put("/settings/admins", "olga", { remove: "olga" })).status).toBe(400);
    expect((await put("/settings/admins", "olga", { add: "role:Admin" })).status).toBe(400);
    expect((await put("/settings/admins", "olga", { remove: "bea" })).status).toBe(200);
    expect((await fetch(`${at}/settings/admins`, as("bea", "Gamma"))).status).toBe(403);
    expect(audited).toEqual(["ana GET /_x/settings/admins denied not a admin", "olga settings admins grant ok bea", "bea PUT settings admins denied not an owner", "olga settings admins revoke ok bea", "bea GET /_x/settings/admins denied not a admin"]);
  });

  it("superset-role: admins are not granted here", async () => {
    const { put } = await start({});
    expect((await put("/settings/admins", "ana", { add: "bea" }, "Admin")).status).toBe(409);
  });

  it("granted users: an admin adds and removes people; searchable and paged, newest first; seeded people stay", async () => {
    const { at, as, put, audited, rights } = await start({ LENSPACK_USER_ACCESS: "superset-role,granted", LENSPACK_USERS: "seed" });
    expect((await put("/settings/users", "bea", { add: "cid" }, "Gamma")).status).toBe(403);
    for (const u of ["u1", "u2", "u3", "bea"]) expect((await put("/settings/users", "ana", { add: u }, "Admin")).status).toBe(200);
    expect(mayUse(principalOf({ user: "bea", roles: ["Gamma"] }, rights))).toBe(true);
    const first = await (await fetch(`${at}/settings/users?limit=2`, as("ana", "Admin"))).json();
    expect(first).toMatchObject({ seeded: ["seed"], users: [{ user: "bea", by: "ana" }, { user: "u3" }], page: { offset: 0, limit: 2, total: 4, prev: null } });
    const second = await (await fetch(`${at}/settings/users?limit=2&cursor=${first.page.next}`, as("ana", "Admin"))).json();
    expect(second.users.map((g: { user: string }) => g.user)).toEqual(["u2", "u1"]);
    expect((await (await fetch(`${at}/settings/users?q=be`, as("ana", "Admin"))).json()).users.map((g: { user: string }) => g.user)).toEqual(["bea"]);
    expect((await put("/settings/users", "ana", { remove: "seed" }, "Admin")).status).toBe(400);
    expect((await put("/settings/users", "ana", { remove: "bea" }, "Admin")).status).toBe(200);
    expect(mayUse(principalOf({ user: "bea", roles: ["Gamma"] }, rights))).toBe(false);
    expect(audited.filter((l) => l.includes("users"))).toEqual(["bea PUT /_x/settings/users denied not a admin", "ana settings users grant ok u1", "ana settings users grant ok u2", "ana settings users grant ok u3", "ana settings users grant ok bea", "ana settings users revoke ok bea"]);
  });

  it("the settings answer says which modes are in force", async () => {
    const { at, as } = await start({ LENSPACK_USER_ACCESS: "granted" });
    const s = await (await fetch(`${at}/settings`, as("ana", "Admin"))).json();
    expect(s.adminAccess).toMatchObject({ mode: "superset-role", label: "Superset roles", from: "default" });
    expect(s.userAccess).toMatchObject({ modes: ["granted"], from: "LENSPACK_USER_ACCESS" });
  });
});

describe("the admin pages' password sign-in", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it("is refused without a password", () => {
    expect(adminSignIn({ prefix: "/_admin", dir: tmp(), env: {}, publicBase: () => "" })).toMatchObject({ refused: expect.stringMatching(/no admin password is set/) });
  });

  it("signs in, sets a strict cookie, audits every try, and locks out after repeated failures", async () => {
    const audited: string[] = [];
    let now = Date.parse("2026-01-01T00:00:00Z");
    const s = adminSignIn({ prefix: "/_admin", dir: tmp(), env: { LENSPACK_ADMIN_PASSWORD: "correct-horse-battery" }, publicBase: () => "/lenspack", audit: (e) => audited.push(`${e.user} ${e.action} ${e.outcome} ${e.detail}`), now: () => now });
    if ("refused" in s) throw new Error(s.refused);
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://x");
      if (await s.handle(req, res, url)) return;
      const who = s.identify(req);
      res.writeHead(who ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(who ? { user: who.user, admin: adminRights(who, { mode: "password" }).administer } : {}));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = (password: string) => fetch(`${at}/_admin/auth/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `password=${encodeURIComponent(password)}&return=/lenspack/_admin/` });

    const ok = await login("correct-horse-battery");
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/lenspack/_admin/");
    const [sessionCookie] = ok.headers.getSetCookie();
    expect(sessionCookie).toMatch(/^lenspack_admin=[^;]+; Path=\/lenspack\/_admin\/;.*HttpOnly/);
    expect(sessionCookie).toMatch(/Secure/);
    expect(sessionCookie).toMatch(/SameSite=Strict/);
    const me = await (await fetch(`${at}/_admin/`, { headers: { cookie: sessionCookie!.split(";")[0]! } })).json();
    expect(me).toEqual({ user: PASSWORD_ADMIN, admin: true });
    expect((await fetch(`${at}/_admin/`)).status).toBe(401);

    for (let i = 0; i < 5; i++) expect((await login("wrong")).status).toBe(401);
    const locked = await login("correct-horse-battery");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    now += 3_600_000;
    expect((await login("correct-horse-battery")).status).toBe(303);
    // Another site's form never signs in.
    expect((await fetch(`${at}/_admin/auth/login`, { method: "POST", headers: { origin: "https://elsewhere.example", "content-type": "application/x-www-form-urlencoded" }, body: "password=correct-horse-battery" })).status).toBe(400);

    const lines = audited.map((l) => l.replace(/ \(?127\.0\.0\.1\)?$/, ""));
    expect(lines[0]).toBe(`${PASSWORD_ADMIN} admin sign-in ok`);
    expect(lines.slice(1, 6)).toEqual(Array(5).fill(`${PASSWORD_ADMIN} admin sign-in denied wrong password`));
    expect(lines[6]).toMatch(new RegExp(`^${PASSWORD_ADMIN} admin sign-in denied too many tries; waiting \\d+ s`));
    expect(lines[7]).toBe(`${PASSWORD_ADMIN} admin sign-in ok`);
    expect(lines[8]).toMatch(/denied from another site/);
  });
});
