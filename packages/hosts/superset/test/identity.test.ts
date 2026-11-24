import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { rotatingAudit } from "@lenspack/serve";
import { serviceAccount } from "../src/bootstrap";
import type { SupersetClient } from "../src/client";
import { IDENTITY_HEADER, type Identity, READ_ONLY_MESSAGE, editPolicyFrom, callerOf, signIdentity, supersetAccess, verifyIdentity } from "../src/identity";

const KEY = "k".repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const req = (value?: string) => ({ headers: value === undefined ? {} : { [IDENTITY_HEADER]: value } }) as unknown as IncomingMessage;

describe("the identity Superset signs", () => {
  const id: Identity = { u: "amina", a: false, d: 7, e: true, v: true, t: now() };

  it("round-trips a fresh, correctly signed header", () => {
    expect(verifyIdentity(signIdentity(id, KEY), KEY)).toEqual(id);
  });

  it("refuses a missing, forged, tampered, malformed or stale header", () => {
    expect(verifyIdentity(undefined, KEY)).toBeNull();
    expect(verifyIdentity(signIdentity(id, "another-key-of-some-length-0000000"), KEY)).toBeNull();
    const [body, sig] = signIdentity(id, KEY).split(".");
    const forged = Buffer.from(JSON.stringify({ ...id, a: true }), "utf8").toString("base64url");
    expect(verifyIdentity(`${forged}.${sig}`, KEY)).toBeNull();
    expect(verifyIdentity(`${body}.${sig!.slice(2)}`, KEY)).toBeNull();
    expect(verifyIdentity("no-dot-here", KEY)).toBeNull();
    expect(verifyIdentity(signIdentity({ ...id, t: now() - 301 }, KEY), KEY)).toBeNull();
    expect(verifyIdentity(signIdentity({ ...id, t: now() + 301 }, KEY), KEY)).toBeNull();
    expect(verifyIdentity(signIdentity({ ...id, u: "" }, KEY), KEY)).toBeNull();
    // No key (not fetched from Superset yet): nobody is signed in.
    expect(verifyIdentity(signIdentity(id, KEY), "")).toBeNull();
  });

  it("is not signed in without a key or a header", async () => {
    expect(await supersetAccess(() => null, "superset")(req(signIdentity(id, KEY)))).toBeNull();
    expect(await supersetAccess(() => KEY, "superset")(req())).toBeNull();
  });
});

describe("who may edit", () => {
  const as = (over: Partial<Identity>): Identity => ({ u: "someone", a: false, d: 7, e: false, v: true, t: now(), ...over });

  it("superset (default): an owner with can_write and an admin edit; a non-owner Alpha and a Gamma viewer only ask", () => {
    const owner = callerOf(as({ u: "owner", e: true }), "superset");
    const admin = callerOf(as({ u: "admin", a: true, e: true }), "superset");
    const otherAlpha = callerOf(as({ u: "alpha", e: false }), "superset");
    const gamma = callerOf(as({ u: "gamma", e: false }), "superset");
    expect(owner).toEqual({ user: "owner", roles: [], usage: false, edit: true, maintain: true });
    expect(admin).toMatchObject({ roles: ["admin"], usage: true, edit: true, maintain: true });
    for (const p of [otherAlpha, gamma]) expect(p).toEqual({ user: p.user, roles: [], usage: false, readOnly: READ_ONLY_MESSAGE });
  });

  it("signed-in: anyone signed in edits, as before", () => {
    expect(callerOf(as({ u: "gamma", e: false }), "signed-in")).toEqual({ user: "gamma", roles: [], usage: false, edit: true, maintain: true });
  });

  it("reads the policy from the environment, refusing a typo", () => {
    expect(editPolicyFrom(undefined)).toBe("superset");
    expect(editPolicyFrom(" Signed-In ")).toBe("signed-in");
    expect(() => editPolicyFrom("everyone")).toThrow(/superset" or "signed-in/);
  });

  it("access applies the policy to the signed header", async () => {
    const header = signIdentity(as({ u: "gamma" }), KEY);
    expect(await supersetAccess(() => KEY, "superset")(req(header))).toMatchObject({ user: "gamma", readOnly: READ_ONLY_MESSAGE });
    expect(await supersetAccess(() => KEY, "signed-in")(req(header))).toMatchObject({ user: "gamma", edit: true });
  });
});

describe("the audit log", () => {
  const event = (at: string, user = "amina") => ({ at, user, action: "chat", outcome: "ok" as const });

  it("writes the current month to audit.jsonl and moves it aside when the month turns", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-audit-"));
    let clock = new Date("2026-10-30T10:00:00Z");
    const log = rotatingAudit(dir, { now: () => clock });
    log.audit(event(clock.toISOString(), "a"));
    log.audit(event(clock.toISOString(), "b"));
    expect(log.read().map((e) => e.user)).toEqual(["b", "a"]);
    clock = new Date("2026-11-02T10:00:00Z");
    log.audit(event(clock.toISOString(), "c"));
    expect(readdirSync(dir).sort()).toEqual(["audit-2026-10.jsonl", "audit.jsonl"]);
    expect(log.read().map((e) => e.user)).toEqual(["c"]);
    expect(log.read({ month: "2026-10" }).map((e) => e.user)).toEqual(["b", "a"]);
    expect(log.months()).toEqual(["current", "2026-10"]);
    expect(statSync(log.file).mode & 0o777).toBe(0o600);
    expect(() => log.read({ month: "../etc/passwd" })).toThrow(/YYYY-MM/);
  });

  it("deletes months older than the retention, keeping the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-audit-"));
    for (const m of ["2026-05", "2026-07", "2026-08", "2026-09"]) writeFileSync(join(dir, `audit-${m}.jsonl`), `${JSON.stringify(event(`${m}-15T00:00:00Z`))}\n`);
    rotatingAudit(dir, { retentionDays: 90, now: () => new Date("2026-11-20T00:00:00Z") });
    // 90 days before 20 Nov is 22 Aug: May and July have ended before that; August has not.
    expect(readdirSync(dir).sort()).toEqual(["audit-2026-08.jsonl", "audit-2026-09.jsonl"]);
  });

  it("takes the month of an existing file from its first line, so a restart rotates correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-audit-"));
    writeFileSync(join(dir, "audit.jsonl"), `${JSON.stringify(event("2026-09-03T00:00:00Z"))}\n`);
    const log = rotatingAudit(dir, { now: () => new Date("2026-10-01T00:00:00Z") });
    log.audit(event("2026-10-01T00:00:00Z", "new"));
    expect(existsSync(join(dir, "audit-2026-09.jsonl"))).toBe(true);
    expect(log.read().map((e) => e.user)).toEqual(["new"]);
  });
});

describe("Lenspack's Superset account", () => {
  // A stand-in for Superset: who can sign in, and what the bootstrap endpoint was asked for.
  function fakeSuperset(users: Record<string, string>) {
    const calls: string[] = [];
    const client = (o: { username: string; password: string }) =>
      ({
        get: async (path: string) => {
          if (users[o.username] !== o.password) throw new Error("401 not authorized");
          // As Superset 5: /api/v1/me/ reads the session cookie only, so a token always gets 401 there.
          if (path === "/api/v1/me/") throw new Error("Superset GET /api/v1/me/ → 401: Not authorized");
          calls.push(`GET ${path} as ${o.username}`);
          return {};
        },
        post: async (path: string, body: { username: string; password: string }) => {
          if (users[o.username] !== o.password) throw new Error("401 not authorized");
          calls.push(`POST ${path} as ${o.username}`);
          users[body.username] = body.password;
          return { result: { username: body.username } };
        },
      }) as unknown as SupersetClient;
    return { client, calls, users };
  }

  it("bootstraps once from the admin sign-in, then signs in with the saved password without it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lp-account-"));
    const s = fakeSuperset({ admin: "admin-pw" });
    const first = await serviceAccount({ url: "http://superset", username: "lenspack", stateDir, admin: { password: "admin-pw" }, client: s.client });
    expect(first.source).toBe("bootstrap");
    expect(s.calls).toEqual(["POST /api/v1/lenspack/bootstrap as admin"]);
    expect(statSync(join(stateDir, "superset-account.json")).mode & 0o777).toBe(0o600);
    const again = await serviceAccount({ url: "http://superset", username: "lenspack", stateDir, client: s.client });
    expect(again).toEqual({ ...first, source: "state" });
    expect(s.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });

  it("makes the account again when the saved password stops working, if the admin password is there", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lp-account-"));
    const s = fakeSuperset({ admin: "admin-pw" });
    const first = await serviceAccount({ url: "http://superset", username: "lenspack", stateDir, admin: { password: "admin-pw" }, client: s.client });
    delete s.users.lenspack; // a fresh metadata database
    await expect(serviceAccount({ url: "http://superset", username: "lenspack", stateDir, client: s.client })).rejects.toThrow(/SUPERSET_ADMIN_PASSWORD/);
    const second = await serviceAccount({ url: "http://superset", username: "lenspack", stateDir, admin: { password: "admin-pw" }, client: s.client });
    expect(second.source).toBe("bootstrap");
    expect(second.password).not.toBe(first.password);
    expect(JSON.parse(readFileSync(join(stateDir, "superset-account.json"), "utf8")).password).toBe(second.password);
  });

  it("uses a password from the environment as is, without bootstrapping", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lp-account-"));
    const s = fakeSuperset({});
    expect(await serviceAccount({ url: "http://superset", username: "svc", stateDir, password: "given", client: s.client })).toEqual({ username: "svc", password: "given", source: "env" });
    expect(s.calls).toEqual([]);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("says what to set when there is no account and no admin password", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lp-account-"));
    await expect(serviceAccount({ url: "http://superset", username: "lenspack", stateDir, client: fakeSuperset({}).client })).rejects.toThrow(/SUPERSET_ADMIN_PASSWORD .* LENSPACK_SUPERSET_PASSWORD/);
  });
});
