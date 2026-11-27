// Who is an admin and who may use the assistant (docs/access/admin-access.md), on Superset 6.1: named Superset users as
// admins, people granted the assistant one by one (alone and with a role), named admin passwords on a sign-in of their
// own, the password combined with a role or with named users, and a Superset Admin who gives themselves the admin role
// (allowed under superset-role, and on the admins roster; refused under superset-users). Each restarts Lenspack with
// its settings in superset.yaml.
// Run with `pnpm test:access access-modes`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ChatResult, PACK, Session, type Stack, readChat, startStack } from "./stack";

const PASSWORD = "access-suite-admin-password-0123";
const OPS = "access-suite-ops-password-4567";
const VENDOR = "access-suite-vendor-password-89";
const NOT_ON = /isn't turned on for your account/;
const BREAKDOWN = { query_kind: "breakdown", measure: "visit_total", dimension: "region" };
const byGroup = (rows: { group: string; value: number }[] | undefined) => Object.fromEntries((rows ?? []).map((r) => [r.group, r.value]));
type Event = { user: string; action: string; outcome: string; detail?: string };

describe.sequential("Superset 6.1.0: admin and user access modes", () => {
  let stack: Stack;
  const s: Record<string, Session> = {};
  let A = "";
  let real = "";

  const overlay = async (who: string) => (await s[who]!.lp("GET", "overlay.js")).text;
  const chat = async (who: string): Promise<ChatResult> =>
    readChat(await s[who]!.lp("POST", `api/${PACK}/${A}/chat?review=off`, { messages: [{ id: `m${Date.now()}`, role: "user", parts: [{ type: "text", text: `TOOL query ${JSON.stringify(BREAKDOWN)}` }] }] }));
  const rows = async (who: string) => {
    const r = await chat(who);
    expect(r.status, r.error).toBe(200);
    return byGroup(r.tools[0]!.output.rows);
  };
  const refused = async (who: string) => {
    expect((await overlay(who)).length).toBeLessThan(200);
    const r = await s[who]!.lp("GET", `api/${PACK}/${A}`);
    expect([r.status, r.json?.code, r.json?.error]).toEqual([403, "not-turned-on", expect.stringMatching(NOT_ON)]);
  };
  const audit = async (who: Session, path = "_superset/audit?limit=200"): Promise<Event[]> => (await who.lp("GET", path)).json.events;

  beforeAll(async () => {
    stack = await startStack("6.1.0", { lenspackEnv: { LENSPACK_ADMIN_PASSWORD: PASSWORD, LENSPACK_ADMIN_PASSWORDS: `ops:${OPS},vendor:${VENDOR}` } });
    A = `superset-${stack.fixtures.dashboards.a}`;
    for (const u of ["lp_admin", "lp_owner", "lp_viewer", "lp_north", "lp_lensuser", "lp_lensadmin"]) s[u] = await stack.as(u);
    const a = await s.lp_admin!.lp("POST", `api/${PACK}/${A}/ops`, { ops: [{ op: "add_widget", id: "visits", widget: { title: "Visits", kind: "chart", chart: "bar", query: { kind: "breakdown", dimension: "region", measure: "visit_total" } }, placement: { place: "bottom", width: "half" } }] });
    expect(a.status, a.text).toBe(200);
    real = await overlay("lp_viewer");
    expect(real.length).toBeGreaterThan(1000);
  }, 900_000);
  afterAll(async () => {
    await stack?.stop();
  });

  describe("admins: named Superset users (adminAccess: superset-users)", () => {
    beforeAll(async () => {
      await stack.restartLenspack(["auth: { adminAccess: superset-users, adminUsers: [lp_owner] }"]);
      expect(stack.log()).toMatch(/admins: named Superset users \(1 owner from auth\.adminUsers, 0 granted; access superset-users, from auth\.adminAccess\)/);
    }, 300_000);

    it("refuses a Superset Admin who is not named, on every admin page and route", async () => {
      for (const path of ["_superset/settings", "_superset/admin/", "_superset/admin/api/packs", "_superset/settings/admins", "_superset/audit?limit=5"]) expect([path, (await s.lp_admin!.lp("GET", path)).status]).toEqual([path, 403]);
      expect((await s.lp_admin!.lp("PUT", "_superset/settings/admins", { add: "lp_admin" })).status).toBe(403);
      // Still a Superset Admin for the data, and still a user of the assistant.
      expect(await rows("lp_admin")).toEqual({ North: 3, South: 4, East: 8, West: 16 });
    });

    it("lets the owner grant admin to a Gamma user, who can then open the admin pages but not grant", async () => {
      const owner = s.lp_owner!;
      expect((await owner.lp("GET", "_superset/admin/")).status).toBe(200);
      const before = await owner.lp("GET", "_superset/settings/admins");
      expect(before.json).toMatchObject({ mode: "superset-users", owners: ["lp_owner"], granted: [], canGrant: true });
      expect((await s.lp_viewer!.lp("GET", "_superset/admin/")).status).toBe(403);
      expect((await owner.lp("PUT", "_superset/settings/admins", { add: "lp_viewer" })).status).toBe(200);
      const page = await s.lp_viewer!.lp("GET", "_superset/admin/");
      expect([page.status, page.headers["content-type"]]).toEqual([200, expect.stringMatching(/text\/html/)]);
      expect((await s.lp_viewer!.lp("GET", "_superset/settings")).json.adminAccess).toMatchObject({ mode: "superset-users", granted: [{ user: "lp_viewer", by: "lp_owner" }], canGrant: false });
      expect((await s.lp_viewer!.lp("PUT", "_superset/settings/admins", { add: "lp_north" })).status).toBe(403);
      expect((await owner.lp("PUT", "_superset/settings/admins", { remove: "lp_owner" })).status).toBe(400);
    });

    it("revokes that admin: refused again at once, and every step is in the audit log", async () => {
      expect((await s.lp_owner!.lp("PUT", "_superset/settings/admins", { remove: "lp_viewer" })).status).toBe(200);
      expect((await s.lp_viewer!.lp("GET", "_superset/admin/")).status).toBe(403);
      const lines = (await audit(s.lp_owner!)).map((e) => `${e.user} ${e.action} ${e.outcome}${e.detail ? ` ${e.detail}` : ""}`);
      for (const want of ["lp_owner settings admins grant ok lp_viewer", "lp_viewer PUT settings admins denied not an owner", "lp_owner settings admins revoke ok lp_viewer"]) expect(lines).toContain(want);
      expect(lines.some((l) => l.startsWith("lp_admin GET /_superset/settings denied"))).toBe(true);
    });
  });

  describe("users: granted one by one (userAccess: granted)", () => {
    beforeAll(async () => {
      await stack.restartLenspack(["auth: { userAccess: granted }"]);
      expect(stack.log()).toMatch(/users: 0 seeded and 0 granted and admins \(access granted, from auth\.userAccess\)/);
      expect(stack.log()).toMatch(/warning: user access is granted, and nobody is granted yet/);
    }, 300_000);

    it("refuses a Gamma user nobody granted: no button, no data", async () => {
      await refused("lp_north");
    });

    it("an admin grants them: the button, and answers within their own row rules", async () => {
      expect((await s.lp_admin!.lp("PUT", "_superset/settings/users", { add: "lp_north" })).status).toBe(200);
      expect(await overlay("lp_north")).toBe(real);
      expect(await rows("lp_north")).toEqual({ North: 3 });
      const list = (await s.lp_admin!.lp("GET", "_superset/settings/users?q=north")).json;
      expect(list).toMatchObject({ modes: ["granted"], users: [{ user: "lp_north", by: "lp_admin" }], page: { total: 1 } });
    });

    it("revoked, they are refused again, and both steps are audited", async () => {
      expect((await s.lp_admin!.lp("PUT", "_superset/settings/users", { remove: "lp_north" })).status).toBe(200);
      await refused("lp_north");
      const lines = (await audit(s.lp_admin!)).map((e) => `${e.user} ${e.action} ${e.outcome} ${e.detail ?? ""}`.trim());
      expect(lines).toContain("lp_admin settings users grant ok lp_north");
      expect(lines).toContain("lp_admin settings users revoke ok lp_north");
    });
  });

  describe("users: a role or a grant (userAccess: superset-role,granted)", () => {
    beforeAll(async () => {
      await stack.restartLenspack(['auth: { userAccess: "superset-role,granted", users: ["Lenspack user"] }']);
      expect(stack.log()).toMatch(/users: Superset role Lenspack user, or 0 seeded and 0 granted and admins \(access superset-role,granted, from auth\.userAccess\)/);
    }, 300_000);

    it("lets in the role's holders and the people granted, and nobody else", async () => {
      expect(await overlay("lp_lensuser")).toBe(real);
      await refused("lp_north");
      expect((await s.lp_admin!.lp("PUT", "_superset/settings/users", { add: "lp_north" })).status).toBe(200);
      expect(await rows("lp_north")).toEqual({ North: 3 });
      await refused("lp_viewer");
      expect((await s.lp_admin!.lp("PUT", "_superset/settings/users", { remove: "lp_north" })).status).toBe(200);
    });
  });

  const anon = () => new Session(stack.superset, "anonymous");
  const login = (who: Session, password: string, name = "") =>
    who.send("POST", "/lenspack/_admin/auth/login", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name, password, return: "/lenspack/_admin/" }).toString() });

  describe("admins: named passwords (adminAccess: password)", () => {
    /** The browser that signed in with the password: it reads the audit log at the end. */
    let signedIn: Session;

    beforeAll(async () => {
      await stack.restartLenspack(["auth: { adminAccess: password }"]);
      expect(stack.log()).toMatch(/admins: named passwords \(3 from LENSPACK_ADMIN_PASSWORDS, LENSPACK_ADMIN_PASSWORD; access password, from auth\.adminAccess\)/);
      for (const secret of [PASSWORD, OPS, VENDOR]) expect(stack.log()).not.toContain(secret);
    }, 300_000);

    it("no Superset user is an admin; Superset's address for the panel leads to the sign-in", async () => {
      expect((await s.lp_admin!.lp("GET", "_superset/settings")).status).toBe(403);
      const page = await s.lp_admin!.lp("GET", "_superset/admin/");
      expect([page.status, page.headers.location]).toEqual([302, "/lenspack/_admin/"]);
    });

    it("signs in with the password through Superset's route, without a Superset session", async () => {
      const b = (signedIn = anon());
      const first = await b.send("GET", "/lenspack/_admin/");
      expect([first.status, first.headers.location]).toEqual([302, expect.stringMatching(/^\/lenspack\/_admin\/auth\/login\?return=/)]);
      const form = (await b.send("GET", "/lenspack/_admin/auth/login")).text;
      expect(form).toContain('type="password"');
      expect(form).toContain('name="name"');
      // An empty name is the deployment's shared password (LENSPACK_ADMIN_PASSWORD), as before.
      const ok = await login(b, PASSWORD);
      expect([ok.status, ok.headers.location]).toEqual([303, "/lenspack/_admin/"]);
      const cookie = [ok.headers["set-cookie"] ?? []].flat().find((c) => c.startsWith("lenspack_admin="))!;
      expect(cookie).toMatch(/Path=\/lenspack\/_admin\/;/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Strict/);
      const panel = await b.send("GET", "/lenspack/_admin/");
      expect([panel.status, panel.headers["content-type"]]).toEqual([200, expect.stringMatching(/text\/html/)]);
      expect((await b.send("GET", "/lenspack/_admin/api/packs")).json.me.user).toBe("admin:password");
      expect((await b.send("GET", "/lenspack/_admin/settings")).json.adminAccess).toMatchObject({ mode: "password", passwordSet: true, passwordNames: ["ops", "vendor", "password"] });
    });

    it("each person signs in with their own name and password, and is named in the audit log", async () => {
      // The browser that signed in before: its device cookie keeps these tries off the shared address's count.
      const b = signedIn;
      expect((await login(b, OPS, "vendor")).status).toBe(401);
      expect([(await login(b, VENDOR, "vendor")).status]).toEqual([303]);
      expect((await b.send("GET", "/lenspack/_admin/api/packs")).json.me.user).toBe("admin:vendor");
      const roster = (await b.send("GET", "/lenspack/_admin/settings/admins")).json.roster as { user: string; how: string }[];
      expect(roster).toEqual(expect.arrayContaining([expect.objectContaining({ user: "admin:vendor", how: "named password vendor" }), expect.objectContaining({ user: "admin:password", how: "the shared password" })]));
    });

    it("locks out after repeated wrong passwords, and audits every try", async () => {
      const b = anon();
      for (let i = 0; i < 5; i++) expect((await login(b, "not-the-password")).status).toBe(401);
      const locked = await login(b, PASSWORD);
      expect(locked.status).toBe(429);
      const lines = (await audit(signedIn, "_admin/audit?limit=200")).filter((e) => e.action.startsWith("admin sign-")).map((e) => `${e.user} ${e.action} ${e.outcome} ${(e.detail ?? "").replace(/ ?\(?[0-9a-f.:]+\)?$/, "")}`.trim());
      expect(lines).toContain("admin:password admin sign-in ok");
      expect(lines.filter((l) => l === "admin:password admin sign-in denied wrong password")).toHaveLength(5);
      expect(lines.some((l) => l.startsWith("admin:password admin sign-in denied too many tries"))).toBe(true);
      expect(lines).toContain("admin:vendor admin sign-in denied wrong password");
      expect(lines).toContain("admin:vendor admin sign-in ok");
      const firstUse = (await audit(signedIn, "_admin/audit?limit=200")).filter((e) => e.action === "admin first use").map((e) => `${e.user} ${e.detail}`);
      expect(firstUse).toEqual(expect.arrayContaining(["admin:password the shared password", "admin:vendor named password vendor"]));
      for (const secret of [PASSWORD, OPS, VENDOR]) expect(stack.log()).not.toContain(secret);
    });
  });

  describe("admins: a role of its own, or a named password (adminAccess: superset-role,password)", () => {
    beforeAll(async () => {
      await stack.restartLenspack(['auth: { adminAccess: "superset-role,password", admins: ["Lenspack admin"] }']);
      expect(stack.log()).toMatch(/admins: Superset role Lenspack admin from auth\.admins, or named passwords \(3 from LENSPACK_ADMIN_PASSWORDS, LENSPACK_ADMIN_PASSWORD; access superset-role,password, from auth\.adminAccess\)/);
    }, 300_000);

    it("lets in the role's holders through Superset and the named passwords through their own sign-in, and nobody else", async () => {
      expect((await s.lp_lensadmin!.lp("GET", "_superset/admin/")).status).toBe(200);
      expect((await s.lp_admin!.lp("GET", "_superset/admin/")).status).toBe(403);
      expect((await s.lp_viewer!.lp("GET", "_superset/admin/")).status).toBe(403);
      const b = anon();
      expect((await login(b, OPS, "ops")).status).toBe(303);
      expect((await b.send("GET", "/lenspack/_admin/api/packs")).json.me.user).toBe("admin:ops");
      const view = (await s.lp_lensadmin!.lp("GET", "_superset/settings/admins")).json;
      expect(view).toMatchObject({ modes: ["superset-role", "password"], roles: ["Lenspack admin"], passwordNames: ["ops", "vendor", "password"] });
      const how = Object.fromEntries((view.roster as { user: string; how: string }[]).map((e) => [e.user, e.how]));
      expect(how).toMatchObject({ lp_lensadmin: "Superset role Lenspack admin", "admin:ops": "named password ops" });
    });
  });

  describe("admins: named users, or a named password as a way in when no owner can (adminAccess: superset-users,password)", () => {
    beforeAll(async () => {
      await stack.restartLenspack(['auth: { adminAccess: "superset-users,password", adminUsers: [lp_owner] }']);
      expect(stack.log()).toMatch(/admins: named Superset users \(1 owner from auth\.adminUsers, 0 granted\), or named passwords \(3 from LENSPACK_ADMIN_PASSWORDS, LENSPACK_ADMIN_PASSWORD; access superset-users,password, from auth\.adminAccess\)/);
    }, 300_000);

    it("the owner and the password admin may both grant; the person granted may not", async () => {
      expect((await s.lp_owner!.lp("GET", "_superset/admin/")).status).toBe(200);
      const b = anon();
      expect((await login(b, OPS, "ops")).status).toBe(303);
      expect((await b.send("PUT", "/lenspack/_admin/settings/admins", { body: { add: "lp_north" } })).status).toBe(200);
      expect((await s.lp_north!.lp("GET", "_superset/admin/")).status).toBe(200);
      expect((await s.lp_north!.lp("PUT", "_superset/settings/admins", { add: "lp_viewer" })).status).toBe(403);
      const how = Object.fromEntries(((await s.lp_owner!.lp("GET", "_superset/settings/admins")).json.roster as { user: string; how: string }[]).map((e) => [e.user, e.how]));
      expect(how).toMatchObject({ lp_owner: "owner", lp_north: "granted by an owner" });
      expect((await s.lp_owner!.lp("PUT", "_superset/settings/admins", { remove: "lp_north" })).status).toBe(200);
    });
  });

  describe("a Superset Admin gives themselves the admin role", () => {
    beforeAll(async () => {
      await stack.restartLenspack(['auth: { adminAccess: superset-role, admins: ["Lenspack admin"] }']);
    }, 300_000);

    it("under superset-role: allowed, on the admins roster, with an audit line the first time", async () => {
      expect((await s.lp_admin!.lp("GET", "_superset/admin/")).status).toBe(403);
      stack.giveRole("lp_admin", "Lenspack admin");
      expect((await s.lp_admin!.lp("GET", "_superset/admin/")).status).toBe(200);
      const view = (await s.lp_lensadmin!.lp("GET", "_superset/settings/admins")).json;
      expect(view.roster).toEqual(expect.arrayContaining([expect.objectContaining({ user: "lp_admin", via: "role", detail: "Lenspack admin", how: "Superset role Lenspack admin" })]));
      const lines = (await audit(s.lp_lensadmin!)).map((e) => `${e.user} ${e.action} ${e.outcome} ${e.detail ?? ""}`.trim());
      // lp_admin was an admin earlier in this suite through Superset's Admin role (the default), so the line says how they
      // qualify now; on a deployment where they never were, it is "admin first use".
      expect(lines).toContain("lp_admin admin qualifies another way ok Superset role Admin → Superset role Lenspack admin");
    });

    it("under superset-users: the same person, still holding the role, is refused", async () => {
      await stack.restartLenspack(["auth: { adminAccess: superset-users, adminUsers: [lp_owner] }"]);
      for (const path of ["_superset/admin/", "_superset/settings", "_superset/settings/admins"]) expect([path, (await s.lp_admin!.lp("GET", path)).status]).toEqual([path, 403]);
      expect((await s.lp_admin!.lp("PUT", "_superset/settings/admins", { add: "lp_admin" })).status).toBe(403);
    }, 300_000);
  });
});
