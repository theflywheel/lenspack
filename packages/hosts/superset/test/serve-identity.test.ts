// The signed identity through the real board API: createApp given supersetAuth, as server.ts gives it.
// Sign-in adapters (password, oidc, proxy, tokens) are another way to say who is asking; Superset mode
// takes none of them, and nothing of theirs may stand in for the signed header.
//
// A dashboard's rights hold on that dashboard's board only. Requests here go out byte for byte
// (fetch() would resolve ".." before sending), the way a client that skips the browser can send them.
import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyBoard } from "@lenspack/core";
import { apiRoute, createApp, openConfig, readConfig, seedBoards } from "@lenspack/serve";
import { catalogueFrom } from "@lenspack/pack";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seed } from "../../../../examples/campaign/seed";
import { IDENTITY_HEADER, type Identity, READ_ONLY_MESSAGE, boardCheck, signIdentity, supersetAccess, supersetAuth } from "../src/identity";

const campaign = fileURLToPath(new URL("../../../../examples/campaign/", import.meta.url));
const KEY = "k".repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const id = (over: Partial<Identity>): Identity => ({ u: "someone", a: false, t: now(), ...over });

/** Owner of dashboard 1, as the plugin signs it now (board and pack named) and as plugins before that did (d only). */
const OWNER_OF_1 = { u: "owner", d: 1, b: "superset-1", p: "campaign", e: true, v: true };
const OWNER_OF_1_OLD_PLUGIN = { u: "owner", d: 1, e: true, v: true };

/** Every way found to name one board to Superset's route and another to Lenspack's, and the forms around them. */
const TO_BOARD_2 = [
  "/api/campaign/superset-1/../superset-2/ops",
  "/api/campaign/superset-1/./../superset-2/ops",
  "/api/campaign/superset-1/%2e%2e/superset-2/ops",
  "/api/campaign/superset-1/%2E%2E/superset-2/ops",
  "/api/campaign/superset-1/.%2e/superset-2/ops",
  "/api/campaign/superset-1/%2e./superset-2/ops",
  "/api/campaign/superset-1/..%2fsuperset-2/ops",
  "/api/campaign/superset-1/..%2Fsuperset-2/ops",
  "/api/campaign/superset-1%2f..%2fsuperset-2/ops",
  "/api/campaign/superset-1/..%5csuperset-2/ops",
  "/api/campaign/superset-1/..\\superset-2/ops",
  "/api/campaign/superset-1//../superset-2/ops",
  "/api/campaign/superset-1/..//superset-2/ops",
  "/api/campaign/superset-2;superset-1/ops",
  "/api/campaign/superset-2/ops;superset-1",
  "/api/campaign/superset-2/ops/superset-1",
  "/api/campaign/superset-2/ops",
];

describe("which board a signed right is for", () => {
  it("reads the board from the route the board API acts on", () => {
    expect(apiRoute("/api/campaign/superset-1/ops?x=1")).toEqual({ api: true, pack: "campaign", board: "superset-1", action: "ops" });
    expect(apiRoute("/api/campaign/superset-1/../superset-2/ops")).toMatchObject({ board: "superset-2" });
    expect(apiRoute("/api/campaign/superset-1/%2e%2e/superset-2/ops")).toMatchObject({ board: "superset-2" });
    expect(apiRoute("/_superset/bind")).toMatchObject({ api: false });
  });

  it("lets the signed board through, with its rights", () => {
    expect(boardCheck(id(OWNER_OF_1), "/api/campaign/superset-1/ops")).toEqual({ refused: null, onBoard: true });
    expect(boardCheck(id(OWNER_OF_1_OLD_PLUGIN), "/api/campaign/superset-1")).toEqual({ refused: null, onBoard: true });
    // About no dashboard: nothing refused, and no dashboard's rights.
    expect(boardCheck(id({ u: "x" }), "/api/campaign")).toEqual({ refused: null, onBoard: false });
    expect(boardCheck(id({ u: "x" }), "/api/campaign/b_123/ops")).toEqual({ refused: null, onBoard: false });
    expect(boardCheck(id({ u: "x", d: 1 }), "/_superset/bind?dashboard=1")).toEqual({ refused: null, onBoard: false });
  });

  it("refuses every other board, pack or none on a request signed for a dashboard", () => {
    for (const signed of [OWNER_OF_1, OWNER_OF_1_OLD_PLUGIN])
      for (const path of [...TO_BOARD_2, "/api/", "/api/_usage", "/api/campaign", "/api/campaign/boards", "/api/campaign/superset-1/../../_usage", "/api/campaign/superset-1/%2e%2e/%2e%2e/_usage"])
        expect(boardCheck(id(signed), path).refused, `${JSON.stringify(signed)} ${path}`).toBeTruthy();
    expect(boardCheck(id({ ...OWNER_OF_1, p: "another" }), "/api/campaign/superset-1/ops").refused).toBeTruthy();
    expect(boardCheck(id({ ...OWNER_OF_1, v: false }), "/api/campaign/superset-1").refused).toBeTruthy();
    // A dashboard board Superset signed nothing for: it never checked the user may view it.
    expect(boardCheck(id({ u: "x" }), "/api/campaign/superset-2").refused).toBeTruthy();
    // A dot segment or an encoded slash anywhere, even on a path about no dashboard.
    for (const path of ["/x/../_superset/bind", "/x/%2e%2e/_superset/bind", "/_superset%2fbind", "/api/./campaign"]) expect(boardCheck(id({ u: "x" }), path).refused, path).toBeTruthy();
  });
});

describe("Superset mode's board API", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-superset-identity-"));
  let server: Server;
  let accessServer: Server;
  let base: string;
  let accessBase: string;
  let close: () => Promise<void>;
  let hosts: Awaited<ReturnType<typeof openConfig>>["hosts"];

  const signed = (who: Partial<Identity>) => signIdentity(id(who), KEY);
  /** One request, its path sent exactly as written. */
  const raw = (header: string | null, path: string, init: { method?: string; body?: unknown; to?: string } = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const body = init.body === undefined ? undefined : JSON.stringify(init.body);
      // Options, not a URL string: a URL string would be parsed, and its ".." resolved, before it is sent.
      const { hostname, port } = new URL(init.to ?? base);
      const r = request({ hostname, port, path, method: init.method ?? "GET", headers: { ...(header ? { [IDENTITY_HEADER]: header } : {}), ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
      });
      r.on("error", reject);
      r.end(body);
    });
  const setTitle = (header: string, path: string, title: string) => raw(header, path, { method: "POST", body: { ops: [{ op: "set_title", title }] } });
  const titleOf = async (board: string) => (await hosts[0]!.store.get(board))!.config.title;

  beforeAll(async () => {
    const db = await openDuckdb(join(dir, "campaign.duckdb"));
    await seed(db.writer, "duckdb", { households: 300 });
    await db.close();
    const file = join(dir, "lenspack.yaml");
    writeFileSync(file, `sources:\n  data: { kind: duckdb, path: ${join(dir, "campaign.duckdb")} }\npacks:\n  - pack: ${campaign}pack.yaml\n    source: data\n    boards: ${campaign}boards\n    now: "2026-09-01T00:00:00Z"\nstore: { kind: memory }\n`);
    const { config, dir: dirOf } = readConfig(file);
    const opened = await openConfig(config, dirOf);
    for (const h of opened.hosts) await seedBoards(h);
    hosts = opened.hosts;
    close = opened.close;
    // Two dashboards' boards, as the Superset store keeps them: the pack's own, no owner.
    for (const [board, title] of [["superset-1", "One"], ["superset-2", "Two"]] as const) await hosts[0]!.store.create({ id: board, pack: hosts[0]!.pack, title, config: emptyBoard(hosts[0]!.pack, title) });
    server = createServer(createApp(opened.hosts, { auth: supersetAuth(() => KEY, "superset") }));
    accessServer = createServer(createApp(opened.hosts, { access: supersetAccess(() => KEY, "superset") }));
    for (const s of [server, accessServer]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    accessBase = `http://127.0.0.1:${(accessServer.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.close();
    accessServer.close();
    await close();
  });

  it("is not signed in without a valid, fresh signature, and offers no sign-in of its own", async () => {
    expect((await raw(null, "/api/")).status).toBe(401);
    expect((await raw(signIdentity({ u: "x", a: true, t: now() }, "z".repeat(64)), "/api/")).status).toBe(401);
    expect((await raw(signed({ t: now() - 3600 }), "/api/campaign/overview/data")).status).toBe(401);
    // The sign-in adapters' routes are not there: no sign-in form, no session cookie to stand in for the header.
    const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
    expect(login.status).toBe(404);
    expect(login.headers.get("set-cookie")).toBeNull();
  });

  it("names the signed user, opens the pack in full without any roles, and gives the usage page to admins only", async () => {
    expect((await raw(signed({ u: "owner" }), "/api/")).body.me).toMatchObject({ user: "owner", edit: false, maintain: false, usage: false });
    expect((await raw(signed({ u: "boss", a: true }), "/api/")).body.me).toMatchObject({ user: "boss", edit: true, maintain: true, usage: true });
    const pack = await raw(signed({ u: "viewer" }), "/api/campaign");
    expect(pack.status).toBe(200);
    expect(pack.body.catalogue.dimensions.length).toBe(catalogueFrom(hosts[0]!.pack).dimensions.length);
    expect((await raw(signed({ u: "viewer" }), "/api/campaign/pack")).status).toBe(200);
    expect((await raw(signed({ u: "boss", a: true }), "/api/_usage")).status).toBe(200);
    // A dashboard owner is not an admin: their edit right is for their board, not for every user's spend.
    expect((await raw(signed({ u: "owner" }), "/api/_usage")).status).toBe(403);
    expect((await raw(signed(OWNER_OF_1_OLD_PLUGIN), "/api/_usage/superset-1")).status).toBe(403);
  });

  it("lets the owner change their own dashboard's board, and a viewer ask but change nothing", async () => {
    const own = await setTitle(signed(OWNER_OF_1), "/api/campaign/superset-1/ops", "One, renamed");
    expect(own.status).toBe(200);
    expect(await titleOf("superset-1")).toBe("One, renamed");
    expect((await raw(signed(OWNER_OF_1), "/api/campaign/superset-1")).body.writable).toBe(true);
    const viewer = signed({ u: "viewer", d: 1, b: "superset-1", p: "campaign", e: false, v: true });
    expect((await raw(viewer, "/api/campaign/superset-1")).body.writable).toBe(false);
    expect(await setTitle(viewer, "/api/campaign/superset-1/ops", "Mine")).toMatchObject({ status: 403, body: { error: READ_ONLY_MESSAGE } });
    // No model here, so the chat answers 503: not the 403 a caller without the read-only path gets.
    const chat = { method: "POST", body: { messages: [{ role: "user", parts: [{ type: "text", text: "how many?" }] }] } };
    expect((await raw(viewer, "/api/campaign/superset-1/chat", chat)).status).toBe(503);
  });

  it("refuses a right signed for one dashboard on any other board, however the path names it", async () => {
    for (const who of [OWNER_OF_1, OWNER_OF_1_OLD_PLUGIN])
      for (const [i, path] of TO_BOARD_2.entries()) {
        const r = await setTitle(signed(who), path, `Two, changed ${i}`);
        expect(r.status, `${path} ${JSON.stringify(who)}`).toBe(403);
        expect(await titleOf("superset-2")).toBe("Two");
      }
  });

  it("refuses reading another dashboard's board or data, or the usage page, through a dashboard's right", async () => {
    for (const path of [
      "/api/campaign/superset-1/../superset-2",
      "/api/campaign/superset-1/../superset-2/data",
      "/api/campaign/superset-1/%2e%2e/superset-2/data",
      "/api/campaign/superset-1/%2e%2e/superset-2/versions",
      "/api/campaign/superset-1/../../_usage",
      "/api/campaign/superset-1/%2e%2e/%2e%2e/_usage",
    ])
      expect((await raw(signed(OWNER_OF_1), path)).status, path).toBe(403);
    // A dashboard board Superset signed nothing for, or signed as not viewable.
    expect((await raw(signed({ u: "viewer" }), "/api/campaign/superset-2/data")).status).toBe(403);
    expect((await raw(signed({ ...OWNER_OF_1, v: false }), "/api/campaign/superset-1/data")).status).toBe(403);
    // The right pack only, when the plugin names it.
    expect((await setTitle(signed({ ...OWNER_OF_1, p: "another" }), "/api/campaign/superset-1/ops", "x")).status).toBe(403);
  });

  it("as a bare access hook (no 403 step), a mismatched request is not signed in at all", async () => {
    expect((await raw(signed(OWNER_OF_1), "/api/campaign/superset-1/../superset-2/data", { to: accessBase })).status).toBe(401);
    expect((await setTitle(signed(OWNER_OF_1), "/api/campaign/superset-1/%2e%2e/superset-2/ops", "x")).status).toBe(403);
    expect((await raw(signed(OWNER_OF_1), "/api/campaign/superset-1/data", { to: accessBase })).status).toBe(200);
  });

  it("refuses a sign-in adapter alongside the signed identity", () => {
    expect(() => createApp(hosts, { access: supersetAccess(() => KEY, "superset"), auth: {} as never })).toThrow(/auth or access, not both/);
  });
});
