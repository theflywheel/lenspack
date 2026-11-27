// Who is an admin and who may use the assistant (admin-access.ts), the routes admins change them with, and the admin
// pages' own password sign-in (admin-signin.ts).
import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PASSWORD_ADMIN, type Rights, adminRights, mayUse, passwordAdmin, principalOf, rightsUnder } from "@lenspack/policy";
import { afterEach, describe, expect, it } from "vitest";

import { accessRights, adminAccessSetup, adminApiKeys, adminApiKeysFrom, adminPasswordsFrom, hashPassword, presentedKey, adminRoutes, adminSettings, adminSignIn, settingsGrants, settingsRoster, userAccessSetup } from "../src";
import { settingsStore } from "../src/settings";

const tmp = () => mkdtempSync(join(tmpdir(), "lp-access-"));
const HOST: Rights = { editors: [], maintainers: [], admins: ["role:Admin"], usage: ["role:Admin"] };
const HOST_LENS: Rights = { editors: [], maintainers: [], admins: ["role:Lenspack admin"], usage: ["role:Lenspack admin"] };

describe("admin access setup", () => {
  it("superset-role by default, saying where its roles come from", () => {
    const a = adminAccessSetup({ env: {}, grants: settingsGrants(settingsStore(tmp())) });
    expect(a.modes).toEqual(["superset-role"]);
    expect(a.line()).toBe("admins: Superset role Admin (access superset-role, the default)");
    // Superset's own Admin role as the admins rule: allowed, as before, with a nudge toward a role of its own.
    expect(a.warnings).toEqual([expect.stringMatching(/every Superset Admin is an assistant admin.*role of its own \(LENSPACK_ADMIN_ROLES\)/)]);
    const own = adminAccessSetup({ env: {}, grants: settingsGrants(settingsStore(tmp())), adminRoles: ["Lenspack admin"], adminRolesFrom: "LENSPACK_ADMIN_ROLES" });
    expect(own.line()).toBe("admins: Superset role Lenspack admin from LENSPACK_ADMIN_ROLES (access superset-role, the default)");
    expect(own.warnings).toEqual([]);
  });

  it("refuses an unknown mode, and owners written as roles", () => {
    expect(() => adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "everyone" }, grants: settingsGrants(settingsStore(tmp())) })).toThrow(/superset-role, superset-users and password/);
    expect(() => adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "superset-role,superset-users" }, grants: settingsGrants(settingsStore(tmp())) })).toThrow(/can't combine/);
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

  it("password: says how many are set and where, never what they are", () => {
    const set = adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "password", LENSPACK_ADMIN_PASSWORD: "a-long-test-password" }, grants: settingsGrants(settingsStore(tmp())) });
    expect(set.line()).toBe("admins: named passwords (1 from LENSPACK_ADMIN_PASSWORD; access password, from LENSPACK_ADMIN_ACCESS)");
    expect(JSON.stringify(set.view())).not.toContain("a-long-test-password");
    expect(set.view()).toMatchObject({ passwordSet: true, passwordNames: ["password"] });
    const unset = adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "password" }, grants: settingsGrants(settingsStore(tmp())) });
    expect(unset.line()).toMatch(/none set; access password, from LENSPACK_ADMIN_ACCESS\): NOBODY signs in with a password/);
    expect(unset.warnings[0]).toMatch(/no admin password is set/);
  });

  it("combines modes: one line naming each, a role and named passwords, either letting a person in", () => {
    const dir = tmp();
    const a = adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "password,superset-role", LENSPACK_ADMIN_PASSWORDS: "ops:a-long-ops-secret-1,vendor:a-long-vendor-secret" }, grants: settingsGrants(settingsStore(dir)), adminRoles: ["Lenspack admin"], adminRolesFrom: "LENSPACK_ADMIN_ROLES" });
    expect(a.modes).toEqual(["superset-role", "password"]);
    expect(a.line()).toBe("admins: Superset role Lenspack admin from LENSPACK_ADMIN_ROLES, or named passwords (2 from LENSPACK_ADMIN_PASSWORDS; access superset-role,password, from LENSPACK_ADMIN_ACCESS)");
    expect(a.view()).toMatchObject({ modes: ["superset-role", "password"], label: "Superset roles or named passwords", passwordNames: ["ops", "vendor"] });
    expect(adminRights(passwordAdmin("vendor"), a.state())).toMatchObject({ administer: true, via: "password", detail: "vendor" });
    const host = principalOf({ user: "lin", roles: ["Lenspack admin"] }, rightsUnder(a.state(), HOST_LENS));
    expect(adminRights(host, a.state())).toMatchObject({ administer: true, via: "role", detail: "Lenspack admin" });
  });

  it("reads named passwords from the environment and from a mounted file, refusing what can't be used", () => {
    const file = join(tmp(), "passwords");
    writeFileSync(file, "# admins of this deployment\nops:a,secret:with every-character\n\nvendor:scrypt$bad\n");
    expect(() => adminPasswordsFrom({ LENSPACK_ADMIN_PASSWORDS_FILE: file })).toThrow(/LENSPACK_ADMIN_PASSWORDS_FILE: the password named "vendor": a password hash must be/);
    writeFileSync(file, "# admins of this deployment\nops:a,secret:with every-character\n\nvendor:another-long-secret\n");
    expect(adminPasswordsFrom({ LENSPACK_ADMIN_PASSWORDS_FILE: file }).map((p) => [p.name, p.password])).toEqual([["ops", "a,secret:with every-character"], ["vendor", "another-long-secret"]]);
    expect(() => adminPasswordsFrom({ LENSPACK_ADMIN_PASSWORDS: "ops:short" })).toThrow(/at least 12 characters/);
    expect(() => adminPasswordsFrom({ LENSPACK_ADMIN_PASSWORDS: "no-colon-here" })).toThrow(/write name:secret/);
    expect(() => adminPasswordsFrom({ LENSPACK_ADMIN_PASSWORDS: "a b:a-long-secret-x" })).toThrow(/not a name/);
    expect(() => adminPasswordsFrom({ LENSPACK_ADMIN_PASSWORDS: "password:a-long-secret-x", LENSPACK_ADMIN_PASSWORD: "another-long-one" })).toThrow(/given twice.*LENSPACK_ADMIN_PASSWORD is the name "password"/);
    expect(() => adminPasswordsFrom({ LENSPACK_ADMIN_PASSWORDS_FILE: join(tmp(), "missing") })).toThrow(/can't read/);
    // An error names where the bad entry is, never the secret.
    try {
      adminPasswordsFrom({ LENSPACK_ADMIN_PASSWORDS: "ops:tiny-pw" });
    } catch (e) {
      expect(String(e)).not.toContain("tiny-pw");
    }
    // A bad entry stops the server at start, when the mode is on.
    expect(() => adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "password", LENSPACK_ADMIN_PASSWORDS: "ops:short" }, grants: settingsGrants(settingsStore(tmp())) })).toThrow(/at least 12/);
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
      res.writeHead(who ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(who ? { user: who.user, admin: adminRights(who, { modes: ["password"], owners: [], granted: [], passwords: ["password", "ops"] }).administer } : {}));
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

  it("named passwords: each person signs in with a name, is admin:<name>, and tries count per name as well as per browser", async () => {
    const audited: string[] = [];
    let now = Date.parse("2026-01-01T00:00:00Z");
    const passwords = adminPasswordsFrom({ LENSPACK_ADMIN_PASSWORDS: "ops:ops-long-secret-1,vendor:vendor-long-secret" });
    const dir = tmp();
    const s = adminSignIn({ prefix: "/_admin", dir, env: {}, passwords, publicBase: () => "", clientAddress: (req) => String(req.headers["x-test-client"] ?? "10.0.0.1"), audit: (e) => audited.push(`${e.user} ${e.action} ${e.outcome} ${e.detail}`), now: () => now });
    if ("refused" in s) throw new Error(s.refused);
    const access = { modes: ["password"] as const, owners: [], granted: [], passwords: ["ops", "vendor"] };
    let current = s;
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://x");
      if (await current.handle(req, res, url)) return;
      const who = current.identify(req);
      res.writeHead(who ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(who ? { user: who.user, admin: adminRights(who, access).administer } : {}));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = (name: string, password: string, client = "10.0.0.1", cookie = "") =>
      fetch(`${at}/_admin/auth/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", "x-test-client": client, ...(cookie ? { cookie } : {}) }, body: `name=${encodeURIComponent(name)}&password=${encodeURIComponent(password)}` });
    const jar = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    const ok = await login("vendor", "vendor-long-secret");
    expect(ok.status).toBe(303);
    const vendorJar = jar(ok);
    expect(await (await fetch(`${at}/_admin/`, { headers: { cookie: vendorJar } })).json()).toEqual({ user: "admin:vendor", admin: true });
    // The page asks for a name; a wrong name and a wrong password get the same answer.
    expect(await (await fetch(`${at}/_admin/auth/login`)).text()).toContain('name="name"');
    const [wrongName, wrongPassword] = [await login("nobody", "ops-long-secret-1"), await login("ops", "vendor-long-secret")];
    expect([wrongName.status, wrongPassword.status]).toEqual([401, 401]);
    expect((await wrongName.text()).includes("Wrong name or password.") && (await wrongPassword.text()).includes("Wrong name or password.")).toBe(true);
    // Guessing one name from many addresses: the name's own count holds it up.
    for (let i = 0; i < 4; i++) expect((await login("ops", "guess", `10.9.0.${i}`)).status).toBe(401);
    expect((await login("ops", "ops-long-secret-1", "10.9.0.200")).status).toBe(429);
    // A browser that signed in as that name before isn't held up by the name's count.
    now += 3_600_000;
    const opsFirst = await login("ops", "ops-long-secret-1", "10.0.0.7");
    expect(opsFirst.status).toBe(303);
    const device = opsFirst.headers.getSetCookie().find((c) => c.startsWith("lenspack_admin_device="))!.split(";")[0]!;
    for (let i = 0; i < 6; i++) await login("ops", "guess", `10.8.0.${i}`);
    expect((await login("ops", "ops-long-secret-1", "10.0.0.7", device)).status).toBe(303);
    expect((await login("ops", "ops-long-secret-1", "10.0.0.99")).status).toBe(429);
    // The audit log names each person, and never what they typed as a name unless it could be one.
    expect(audited).toContain("admin:vendor admin sign-in ok 10.0.0.1");
    expect(audited).toContain("admin:nobody admin sign-in denied no such name (10.0.0.1)");
    expect(audited).toContain("admin:ops admin sign-in denied wrong password (10.0.0.1)");
    await login("<b>x</b>", "whatever-long-x");
    expect(audited[audited.length - 1]).toMatch(/^admin:\? admin sign-in denied/);

    // Taking a name off the list (and restarting) ends that person's session.
    const fewer = adminSignIn({ prefix: "/_admin", dir, env: {}, passwords: passwords.filter((p) => p.name !== "vendor"), publicBase: () => "", now: () => now });
    if ("refused" in fewer) throw new Error(fewer.refused);
    current = fewer;
    expect((await fetch(`${at}/_admin/`, { headers: { cookie: vendorJar } })).status).toBe(401);
  });
});

describe("the admins roster", () => {
  it("lists everyone who used admin rights and how, audits the first use, and tells each admin who is new since their last visit", () => {
    const store = settingsStore(tmp());
    const audited: string[] = [];
    let now = Date.parse("2026-03-02T09:00:00Z");
    const a = adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "superset-role,password", LENSPACK_ADMIN_PASSWORDS: "vendor:vendor-long-secret" }, grants: settingsGrants(store), roster: settingsRoster(store), adminRoles: ["Lenspack admin"], now: () => now });
    a.auditTo((e) => audited.push(`${e.user} ${e.action} ${e.detail}`));
    const settle = (user: string, roles: string[]) => principalOf({ user, roles }, rightsUnder(a.state(), HOST_LENS));
    a.seen(settle("lin", ["Lenspack admin"]));
    now += 5 * 60_000;
    a.seen(settle("lin", ["Lenspack admin"]));
    expect(audited).toEqual(["lin admin first use Superset role Lenspack admin"]);
    // A Superset Admin gives themselves the role: allowed under superset-role, and it shows.
    now += 2 * 3_600_000;
    a.seen(settle("ana", ["Admin", "Lenspack admin"]));
    now += 60_000;
    a.seen(passwordAdmin("vendor"));
    // Not an admin: not on the roster.
    a.seen(settle("bea", ["Gamma"]));
    expect(audited.slice(1)).toEqual(["ana admin first use Superset role Lenspack admin", "admin:vendor admin first use named password vendor"]);
    // lin comes back the next day: ana and the vendor are new to them, and not to ana.
    now += 24 * 3_600_000;
    a.seen(settle("lin", ["Lenspack admin"]));
    const view = a.view({ owner: false, user: "lin" });
    expect(view.roster.map((e) => [e.user, e.how])).toEqual([["lin", "Superset role Lenspack admin"], ["admin:vendor", "named password vendor"], ["ana", "Superset role Lenspack admin"]]);
    expect(view.roster[0]).toMatchObject({ firstSeen: "2026-03-02T09:00:00.000Z" });
    expect(view.newSince.map((e) => e.user).sort()).toEqual(["admin:vendor", "ana"]);
    expect(a.view({ owner: false, user: "ana" }).newSince).toEqual([]);
    // The roster survives a restart: it is in the state directory's settings.
    const again = adminAccessSetup({ env: { LENSPACK_ADMIN_ACCESS: "superset-role" }, grants: settingsGrants(store), roster: settingsRoster(store), adminRoles: ["Lenspack admin"] });
    expect(again.view().roster).toHaveLength(3);
  });
});

describe("admin API keys: reading them and checking one", () => {
  const CI = "test-only-ci-key-0123456789abcdefghij";
  const req = (authorization?: string, address = "192.0.2.4") => ({ headers: authorization === undefined ? {} : { authorization }, socket: { remoteAddress: address } }) as never;

  it("reads name:key pairs and a mounted file, plain keys 32 characters or more, or scrypt hashes; refuses the rest without echoing them", () => {
    const file = join(tmp(), "keys");
    writeFileSync(file, `# keys\nops:${hashPassword("test-only-ops-key")}\n`);
    const keys = adminApiKeysFrom({ LENSPACK_ADMIN_API_KEYS: `ci:${CI}`, LENSPACK_ADMIN_API_KEYS_FILE: file });
    expect(keys.map((k) => [k.name, k.from, !!k.password, !!k.passwordHash])).toEqual([["ci", "LENSPACK_ADMIN_API_KEYS", true, false], ["ops", "LENSPACK_ADMIN_API_KEYS_FILE", false, true]]);
    expect(adminApiKeysFrom({})).toEqual([]);
    const short = "a-key-of-only-thirty-one-chars!";
    expect(() => adminApiKeysFrom({ LENSPACK_ADMIN_API_KEYS: `ci:${short}` })).toThrow(/LENSPACK_ADMIN_API_KEYS: the admin API key named "ci": an admin API key must be at least 32 characters/);
    expect(() => adminApiKeysFrom({ LENSPACK_ADMIN_API_KEYS: "ci:scrypt$bad" })).toThrow(/a password hash must be scrypt/);
    expect(() => adminApiKeysFrom({ LENSPACK_ADMIN_API_KEYS: `ci:${CI},ci:${CI}y` })).toThrow(/given twice/);
    expect(() => adminApiKeysFrom({ LENSPACK_ADMIN_API_KEYS: `ci deploy:${CI}` })).toThrow(/not a name for an admin API key/);
    expect(() => adminApiKeysFrom({ LENSPACK_ADMIN_API_KEYS: CI })).toThrow(/write name:secret/);
    try {
      adminApiKeysFrom({ LENSPACK_ADMIN_API_KEYS: `ci:${short}` });
    } catch (e) {
      expect(String(e)).not.toContain(short);
    }
    // Read in every admin access mode, and named on the settings, never shown.
    const a = adminAccessSetup({ env: { LENSPACK_ADMIN_API_KEYS: `ci:${CI}` }, grants: settingsGrants(settingsStore(tmp())) });
    expect(a.state().apiKeys).toEqual(["ci"]);
    expect(a.view().apiKeys).toEqual({ names: ["ci"], from: ["LENSPACK_ADMIN_API_KEYS"] });
    expect(a.apiKeys.line()).toBe("admin API keys: 1 (ci) from LENSPACK_ADMIN_API_KEYS; admin routes only (through Superset: <root>/lenspack/_admin/…)");
    expect(JSON.stringify(a.view())).not.toContain(CI);
    expect(adminAccessSetup({ env: {}, grants: settingsGrants(settingsStore(tmp())) }).apiKeys).toMatchObject({ on: false, names: [] });
  });

  it("reads the key from Authorization: Bearer only", () => {
    expect(presentedKey(req(`Bearer ${CI}`))).toBe(CI);
    expect(presentedKey(req(`bearer   ${CI} `))).toBe(CI);
    expect(presentedKey(req())).toBeNull();
    expect(presentedKey(req(`Basic ${CI}`))).toBe("");
    expect(presentedKey(req(`Bearer a b`))).toBe("");
  });

  it("checks plain and hashed keys, remembering a hashed one that passed; audits wrong ones without the key", async () => {
    const events: { user: string; action: string; outcome: string; detail?: string }[] = [];
    const k = adminApiKeys({ keys: adminApiKeysFrom({ LENSPACK_ADMIN_API_KEYS: `ci:${CI},ops:${hashPassword("test-only-ops-key-0123456789abcdef")}` }), audit: (e) => events.push(e) });
    const ok = await k.check(req(), CI);
    expect("who" in ok && ok.who).toMatchObject({ user: "api:ci", uses: false });
    const hashed = await k.check(req(), "test-only-ops-key-0123456789abcdef");
    expect("who" in hashed && hashed.who.user).toBe("api:ops");
    // The second time is remembered: well under a scrypt check.
    const t = Date.now();
    await k.check(req(), "test-only-ops-key-0123456789abcdef");
    expect(Date.now() - t).toBeLessThan(15);
    expect(await k.check(req(), "nope")).toEqual({ status: 401, error: "not a valid admin API key" });
    expect(await k.check(req(), "")).toMatchObject({ status: 401, error: expect.stringMatching(/Authorization: Bearer/) });
    expect(events).toEqual([expect.objectContaining({ user: "api:?", action: "admin API key", outcome: "denied", detail: "wrong key (192.0.2.4)" }), expect.objectContaining({ outcome: "denied", detail: expect.stringMatching(/^no key/) })]);
    expect(JSON.stringify(events)).not.toContain(CI);
  });

  it("holds an address after five wrong keys, a right key included, and counts the caller a host vouches for", async () => {
    let t = 1_000_000;
    const k = adminApiKeys({ keys: adminApiKeysFrom({ LENSPACK_ADMIN_API_KEYS: `ci:${CI}` }), now: () => t });
    for (let i = 0; i < 5; i++) expect(await k.check(req(undefined, "10.0.0.1"), `wrong-${i}`)).toMatchObject({ status: 401 });
    expect(await k.check(req(undefined, "10.0.0.1"), CI)).toMatchObject({ status: 429, retryAfterS: 1 });
    // The same socket, but a signed caller address: another caller.
    expect("who" in (await k.check(req(undefined, "10.0.0.1"), CI, "198.51.100.2"))).toBe(true);
    t += 2000;
    expect("who" in (await k.check(req(undefined, "10.0.0.1"), CI))).toBe(true);
  });
});
