import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { boardTools } from "@lenspack/agent";
import { boardConfigSchema, emptyBoard } from "@lenspack/core";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { parsePackText } from "@lenspack/pack";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seed } from "../../../../examples/campaign/seed";
import { type AuditEvent, type Host, authFrom, authSchema, buildProvider, createApp, hiddenKeys, openConfig, readConfig, registerLlmAdapter, seedBoards } from "../src";
import { fakeIssuer, listen } from "./fake-issuer";

// Pack access by role: who may open a pack, which keys they may use, and the
// rows they see. Every way a key's values could reach a caller is tried here
// with a caller it is hidden from: the catalogue, the pack file, explain,
// board data, filter menus, selections, drills, shared boards, copies, edits,
// the chat's prompt and its tools. Rights and pack rules sit above the
// sign-in, so the same tests run with callers named by each adapter: a login
// proxy's headers, bearer tokens, and lenspack's own OIDC sign-in.

const campaign = fileURLToPath(new URL("../../../../examples/campaign/", import.meta.url));
const SECRET = "p".repeat(32);
const HIDDEN = ["delivered_by", "not_delivered_reason", "village", "distributors_active"];

// The callers, as "user:role,role": each adapter below is set up to name them so.
const CALLERS = ["sam:staff", "pat:partner,newsletter", "abe:auditor", "nobody:"];
const RIGHTS = { editors: ["*"], maintainers: ["role:staff"], usage: ["role:auditor"] };
const parse = (who: string) => {
  const [user, groups] = who.split(":");
  return { user: user!, roles: (groups ?? "").split(",").filter(Boolean) };
};

// Each adapter: how to start a server signed in by it, and the headers a caller sends.
async function signer(kind: "proxy" | "tokens" | "oidc", hosts: Host[]): Promise<{ api: string; headers: (who: string) => Promise<Record<string, string>>; close(): void }> {
  const server = createServer();
  const base = await listen(server);
  const start = (auth: unknown, extra: Parameters<typeof createApp>[1]) => {
    const { adapter, rights } = authFrom(authSchema.parse(auth));
    server.on("request", createApp(hosts, { auth: adapter, rights, ...extra }));
  };
  const closers = [() => server.close()];
  let headers: (who: string) => Promise<Record<string, string>>;
  if (kind === "proxy") {
    start({ kind: "proxy", secret: SECRET, rolesHeader: "x-forwarded-groups", ...RIGHTS }, OPTIONS);
    headers = async (who) => ({ "x-lenspack-proxy-secret": SECRET, "x-forwarded-user": parse(who).user, "x-forwarded-groups": parse(who).roles.join(",") });
  } else if (kind === "tokens") {
    start({ kind: "tokens", users: CALLERS.map((c) => ({ user: parse(c).user, token: `token-${parse(c).user}`, roles: parse(c).roles })), ...RIGHTS }, OPTIONS);
    headers = async (who) => ({ authorization: `Bearer token-${parse(who).user}` });
  } else {
    const idp = fakeIssuer();
    idp.state.url = await listen(idp.server);
    closers.push(() => idp.server.close());
    start({ kind: "oidc", issuer: idp.state.url, clientId: "lenspack", clientSecret: "client-secret", baseUrl: base, sessionSecret: "s".repeat(40), ...RIGHTS }, OPTIONS);
    // Signs each caller in through the provider once, and keeps their session cookie.
    const sessions = new Map<string, string>();
    headers = async (who) => {
      if (!sessions.has(who)) {
        idp.state.user = { preferred_username: parse(who).user, groups: parse(who).roles };
        const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
        const loginCookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
        const atIdp = await fetch(login.headers.get("location")!, { redirect: "manual" });
        const back = await fetch(atIdp.headers.get("location")!, { redirect: "manual", headers: { cookie: loginCookie } });
        const session = back.headers.getSetCookie().find((c) => c.startsWith("lenspack_session="));
        if (!session) throw new Error(`sign-in for ${who} failed: ${back.status}`);
        sessions.set(who, session.split(";")[0]!);
      }
      return { cookie: sessions.get(who)! };
    };
  }
  return { api: `${base}/api`, headers, close: () => closers.forEach((c) => c()) };
}

const events: AuditEvent[] = [];
const prompts: string[] = [];
const reviews: string[] = [];
let OPTIONS: Parameters<typeof createApp>[1] = {};

describe("pack access by role", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-access-"));
  let hosts: Host[];
  let close: () => Promise<void>;
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  const keysOf = (catalogue: { dimensions: { key: string }[]; measures: { key: string }[] }) => [...catalogue.dimensions, ...catalogue.measures].map((k) => k.key);

  beforeAll(async () => {
    const db = await openDuckdb(join(dir, "campaign.duckdb"));
    await seed(db.writer, "duckdb", { households: 3000 });
    await db.close();
    // The example pack, with one example on a hidden key and one on visible keys: the prompt shows only the second.
    writeFileSync(
      join(dir, "pack.yaml"),
      `${readFileSync(`${campaign}pack.yaml`, "utf8")}\nexamples:\n  - { question: "Who visited the most households?", query: { kind: breakdown, dimension: delivered_by, measure: visits } }\n  - { question: "Nets by province", query: { kind: breakdown, dimension: province, measure: nets_distributed } }\n`,
    );
    const file = join(dir, "lenspack.yaml");
    writeFileSync(
      file,
      `sources:
  data: { kind: duckdb, path: ${join(dir, "campaign.duckdb")} }
packs:
  - pack: ${join(dir, "pack.yaml")}
    source: data
    boards: ${campaign}boards
    now: "2026-09-01T00:00:00Z"
    access:
      - roles: [staff]
      - roles: [partner]
        hide: [${HIDDEN.join(", ")}]
      - roles: [auditor]
        only: [province, district, delivered_to, visits]
        scope: [{ dimension: delivered_to, op: eq, value: HOUSEHOLD }]
  - pack: ${campaign}pack.yaml
    name: internal
    source: data
    now: "2026-09-01T00:00:00Z"
    access:
      - roles: [staff]
store: { kind: memory }
`,
    );
    const { config, dir: base } = readConfig(file);
    const opened = await openConfig(config, base);
    for (const h of opened.hosts) await seedBoards(h);
    hosts = opened.hosts;
    close = opened.close;
    // A chat model that only answers, so each turn's system prompt, and what its reviewer reads, can be read. Its
    // answer claims an edit the board did not gain, so the reviewer looks.
    registerLlmAdapter({
      kind: "access-mock",
      defaultBaseUrl: "mock:",
      build: () =>
        new MockLanguageModelV4({
          doGenerate: async (opts) => {
            reviews.push(JSON.stringify(opts.prompt));
            return { content: [{ type: "text", text: '{"findings": []}' }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
          },
          doStream: async (opts) => {
            prompts.push(JSON.stringify(opts.prompt.filter((m) => m.role === "system")));
            return {
              stream: new ReadableStream({
                start(c) {
                  c.enqueue({ type: "text-start", id: "t" });
                  c.enqueue({ type: "text-delta", id: "t", delta: "I added the chart." });
                  c.enqueue({ type: "text-end", id: "t" });
                  c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
                  c.close();
                },
              }),
            };
          },
        }),
    });
    OPTIONS = { providers: [{ ...buildProvider({ name: "mock", kind: "access-mock", model: "m" }), available: true }], audit: (e) => events.push(e) };
  });
  afterAll(async () => {
    await close();
  });

  describe.each(["proxy", "tokens", "oidc"] as const)("signed in by %s", (kind) => {
    let api: string;
    let headers: (who: string) => Promise<Record<string, string>>;
    let stop: () => void;
    beforeAll(async () => {
      ({ api, headers, close: stop } = await signer(kind, hosts));
    });
    afterAll(() => stop());

    const call = async (who: string | null, path: string, init: RequestInit = {}) => {
      const r = await fetch(`${api}${path}`, { ...init, headers: { "content-type": "application/json", ...(who ? await headers(who) : {}) } });
      const text = await r.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {}
      return { status: r.status, body, text };
    };
    const [staff, partner, auditor] = CALLERS as [string, string, string];

    it("lists only the packs a caller's roles open, and hides the rest as if absent", async () => {
      const names = async (who: string) => ((await call(who, "")).body.examples as { example: string }[]).map((e) => e.example);
      expect(await names(staff)).toEqual(["campaign", "internal"]);
      expect(await names(partner)).toEqual(["campaign"]);
      expect(await names("nobody:")).toEqual([]);
      expect((await call(partner, "/internal")).status).toBe(404);
      expect((await call("nobody:", "/campaign/overview/data")).status).toBe(404);
    });

    it("leaves hidden keys out of the catalogue, its hierarchies, and the pack file", async () => {
      const all = keysOf((await call(staff, "/campaign")).body.catalogue);
      const theirs = (await call(partner, "/campaign")).body.catalogue;
      for (const k of HIDDEN) {
        expect(all).toContain(k);
        expect(keysOf(theirs)).not.toContain(k);
      }
      expect(theirs.hierarchies.area).toEqual(["province", "district", "locality"]);
      expect((await call(partner, "/campaign/overview")).body.catalogue.dimensions.map((d: { key: string }) => d.key)).not.toContain("delivered_by");
      // only: everything else hidden, and what is computed from hidden measures with it.
      expect(keysOf((await call(auditor, "/campaign")).body.catalogue).sort()).toEqual(["delivered_to", "district", "province", "visits"]);
      expect((await call(staff, "/campaign/pack")).status).toBe(200);
      expect((await call(partner, "/campaign/pack")).status).toBe(403);
    });

    it("refuses a hidden key in explain, as a grouping, a column or only a filter", async () => {
      const explain = async (who: string, q: unknown) => (await call(who, `/campaign/explain?q=${encodeURIComponent(JSON.stringify(q))}`)).body;
      const queries = [
        { kind: "breakdown", dimension: "delivered_by", measure: "visits" },
        { kind: "breakdown", dimension: "province", measure: "visits", filters: [{ dimension: "not_delivered_reason", op: "eq", value: "x" }] },
        { kind: "rows", entity: "task", columns: ["province", "village"] },
        { kind: "value", measure: "visits", measures: ["distributors_active"] },
      ];
      // Allowed queries compile, but the statement is not shown to a caller kept from the pack file.
      expect((await explain(staff, { kind: "value", measure: "visits" })).sql).toBeTruthy();
      const compiled = await explain(partner, { kind: "value", measure: "visits" });
      expect(compiled.ok).toBe(true);
      expect(compiled).not.toHaveProperty("sql");
      expect(compiled).not.toHaveProperty("native");
      for (const q of queries) {
        expect(await explain(staff, q)).toMatchObject({ ok: true });
        const refused = await explain(partner, q);
        expect(refused).toMatchObject({ ok: false, code: "NOT_PERMITTED" });
        expect(refused.sql).toBeUndefined();
      }
      // A misspelling is never answered with a hidden key.
      expect((await explain(partner, { kind: "breakdown", dimension: "delivered_bye", measure: "visits" })).nearest).not.toBe("delivered_by");
    });

    it("draws a pack board's widget on a hidden key as not permitted, and the rest as usual", async () => {
      for (const path of ["/campaign/overview?include=data", "/campaign/overview/data"]) {
        const r = await call(partner, path);
        const data = r.body.data ?? r.body;
        expect(data.not_delivered).toMatchObject({ rows: [], error: '"not_delivered_reason" is not available to you' });
        expect(data.by_province.rows.length).toBeGreaterThan(0);
        expect(r.text).not.toContain("Refused");
      }
      expect((await call(staff, "/campaign/overview/data")).body.not_delivered.error).toBeUndefined();
    });

    it("gives no filter values for a hidden dimension, and ignores a selection or drill on one", async () => {
      expect((await call(staff, "/campaign/overview/options?field=delivered_by")).body.length).toBeGreaterThan(0);
      expect((await call(partner, "/campaign/overview/options?field=delivered_by")).body).toEqual([]);
      const plain = (await call(partner, "/campaign/overview/data")).body;
      const village = (await call(staff, "/campaign/overview/options?field=village")).body[0].value;
      // A village is a hierarchy level: for staff it narrows the board, for the partner it is not applied.
      const drilledStaff = (await call(staff, `/campaign/overview/data?f_village=${encodeURIComponent(village)}`)).body;
      expect(drilledStaff.visits.rows[0].value).toBeLessThan((await call(staff, "/campaign/overview/data")).body.visits.rows[0].value);
      expect((await call(partner, `/campaign/overview/data?f_village=${encodeURIComponent(village)}`)).body.visits).toEqual(plain.visits);
    });

    it("shows a shared board with a hidden widget as not permitted, before and after a copy", async () => {
      const widget = { kind: "table", title: "By distributor", query: { kind: "breakdown", dimension: "delivered_by", measure: "visits" } };
      const made = await call(staff, "/campaign/boards", post({ title: "Distributors" }));
      const id = made.body.id as string;
      expect((await call(staff, `/campaign/${id}/ops`, post({ ops: [{ op: "add_widget", id: "who", widget }, { op: "add_filter", filter: { id: "f", type: "select", label: "Who", field: "delivered_by", applies: ["*"] } }] }))).body.ok).not.toBe(false);
      await call(staff, `/campaign/${id}/share`, post({ shared: true }));
      const user = (await call(staff, `/campaign/${id}/options?field=delivered_by`)).body[0].value;

      const seen = await call(partner, `/campaign/${id}?include=data,options`);
      expect(seen.status).toBe(200);
      expect(seen.body.data.who).toMatchObject({ rows: [], error: '"delivered_by" is not available to you' });
      expect(seen.body.options.delivered_by).toEqual([]);
      expect(seen.text).not.toContain(user);
      // A selection on a hidden board filter refuses the widgets rather than answering for that user.
      expect((await call(partner, `/campaign/${id}/data?f_delivered_by=${user}`)).body.who.error).toMatch(/not available/);

      // A widget filtered on one distributor: the partner sees the filter's key, not its value.
      const pinned = { kind: "kpi", title: "One distributor", query: { kind: "value", measure: "visits", filters: [{ dimension: "delivered_by", op: "in", value: [user] }] } };
      const ops = await call(staff, `/campaign/${id}/ops`, post({ ops: [{ op: "add_widget", id: "one", widget: pinned }] }));
      expect(JSON.stringify(ops.body)).toContain(user);
      for (const path of [`/campaign/${id}`, `/campaign/${id}?include=data`, `/campaign/${id}/versions`]) {
        const r = await call(partner, path);
        expect(r.text, path).not.toContain(user);
        expect(r.text, path).toContain("(hidden)");
      }

      const copy = await call(partner, `/campaign/${id}/copy`, post({}));
      expect(copy.status).toBe(200);
      const theirs = await call(partner, `/campaign/${copy.body.id}?include=data`);
      expect(theirs.body.data.who.error).toMatch(/not available/);
      expect(theirs.text).not.toContain(user);
      // What is stored under their name is what they were shown: the value is not in their copy at all.
      const stored = (await hosts.find((x) => x.name === "campaign")!.store.get(copy.body.id))!.config;
      expect(JSON.stringify(stored)).not.toContain(user);
      expect(stored.widgets.one).toMatchObject({ query: { filters: [{ dimension: "delivered_by", value: ["(hidden)"] }] } });
      // Their own edit on the copy answers with the board, values still kept back.
      expect((await call(partner, `/campaign/${copy.body.id}/ops`, post({ ops: [{ op: "set_title", title: "Mine" }] }))).text).not.toContain(user);
      expect((await call(partner, `/campaign/${copy.body.id}/versions`)).text).not.toContain(user);
    });

    it("refuses an edit that would put a hidden key on a board, and records it", async () => {
      const made = await call(partner, "/campaign/boards", post({ title: "Mine" }));
      const add = await call(partner, `/campaign/${made.body.id}/ops`, post({ ops: [{ op: "add_widget", id: "x", widget: { kind: "kpi", title: "x", query: { kind: "value", measure: "distributors_active" } } }] }));
      expect(add.body).toMatchObject({ ok: false });
      expect(events.at(-1)).toMatchObject({ user: "pat", action: "ops", outcome: "refused" });
      const filter = await call(partner, `/campaign/${made.body.id}/ops`, post({ ops: [{ op: "add_filter", filter: { id: "f", type: "select", label: "Who", field: "delivered_by", applies: ["*"] } }] }));
      expect(filter.body).toMatchObject({ ok: false });
    });

    it("narrows every query by the rule's scope", async () => {
      const values = async (who: string) => ((await call(who, "/campaign/overview/options?field=delivered_to")).body as { value: string }[]).map((v) => v.value).sort();
      expect(await values(staff)).toEqual(["HOUSEHOLD", "INDIVIDUAL"]);
      expect(await values(auditor)).toEqual(["HOUSEHOLD"]);
    });

    it("gives the usage page to the usage role, which need not maintain", async () => {
      expect((await call(auditor, "/_usage")).status).toBe(200);
      expect((await call(staff, "/_usage")).status).toBe(403);
      expect((await call(partner, "/_usage")).status).toBe(403);
      expect((await call(auditor, "")).body.me).toMatchObject({ user: "abe", usage: true, maintain: false, edit: true });
      expect((await call(staff, "")).body.me).toMatchObject({ usage: false, maintain: true });
    });

    it("never shows the chat model a hidden key", async () => {
      const made = await call(partner, "/campaign/boards", post({ title: "Chat" }));
      const turn = async (who: string, board: string) => {
        const before = prompts.length;
        await call(who, `/campaign/${board}/chat?review=off`, post({ messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "what can I see?" }] }] }));
        return prompts.slice(before).join("");
      };
      const theirs = await turn(partner, made.body.id);
      expect(theirs).toContain("Nets by province");
      expect(theirs).not.toContain("Who visited the most");
      for (const k of HIDDEN) expect(theirs).not.toContain(k);
      const mine = await call(staff, "/campaign/boards", post({ title: "Chat" }));
      const staffs = await turn(staff, mine.body.id);
      expect(staffs).toContain("delivered_by");
      expect(staffs).toContain("Who visited the most");
    });

    it("shows the chat model and its reviewer a board as the caller is shown it, without a hidden key's values", async () => {
      const h = hosts.find((x) => x.name === "campaign")!;
      // Boards of their own that hold a village, which the partner may not use: saved before their access narrowed, say.
      const own = async (user: string) => (await h.store.create({ id: `old-${user}-${kind}`, pack: h.pack, title: "Old board", config: holding(h.pack), owner: user })).id;
      const turn = async (who: string, board: string, review: boolean) => {
        const seen = { prompts: prompts.length, reviews: reviews.length };
        const r = await call(who, `/campaign/${board}/chat${review ? "" : "?review=off"}`, post({ messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "add a chart of visits by province" }] }] }));
        expect(r.status).toBe(200);
        return { prompt: prompts.slice(seen.prompts).join(""), review: reviews.slice(seen.reviews).join("") };
      };
      const theirs = await turn(partner, await own("pat"), true);
      expect(theirs.prompt).toContain("One village");
      expect(theirs.prompt).toContain("(hidden)");
      expect(theirs.prompt).not.toContain(VILLAGE);
      expect(theirs.review).toContain("One village");
      expect(theirs.review).not.toContain(VILLAGE);
      // Someone who may use the key is shown the value.
      expect((await turn(staff, await own("sam"), false)).prompt).toContain(VILLAGE);
    });
  });


  it("stops at startup on a rule that names a key the pack does not have", async () => {
    const file = join(dir, "typo.yaml");
    writeFileSync(file, `sources:\n  data: { kind: duckdb, path: ${join(dir, "campaign.duckdb")} }\npacks:\n  - pack: ${campaign}pack.yaml\n    source: data\n    access: [{ roles: [x], hide: [deliverd_by] }]\n`);
    const { config, dir: base } = readConfig(file);
    await expect(openConfig(config, base)).rejects.toThrow(/deliverd_by/);
  });

  it("keeps hidden keys from the chat's tools: catalogue, query, explain, values and edits", async () => {
    const h = hosts.find((x) => x.name === "campaign")!;
    const board = await h.store.create({ id: "tools", pack: h.pack, title: "Tools" });
    const hidden = hiddenKeys(h.pack, { roles: ["partner"], hide: HIDDEN });
    const tools = Object.fromEntries(boardTools({ pack: h.pack, connector: h.connector, store: h.store, boardId: board.id, ctx: { ...h.ctx, hidden } }).map((t) => [t.name, t]));
    const run = (name: string, args: Record<string, unknown>) => tools[name]!.execute(tools[name]!.inputSchema.parse(args) as never) as Promise<any>;
    const listed = await run("list_metrics", {});
    expect(keysOf(listed)).not.toContain("delivered_by");
    expect(await run("query", { query_kind: "breakdown", measure: "visits", dimension: "delivered_by" })).toMatchObject({ ok: false, error: '"delivered_by" is not available to you' });
    expect(await run("query", { query_kind: "value", measure: "visits", filters: "not_delivered_reason = x" })).toMatchObject({ ok: false });
    expect(await run("explain", { query_kind: "rows", entity: "task", dimension: "province,village" })).toMatchObject({ ok: false });
    expect(await run("list_values", { dimension: "delivered_by" })).toMatchObject({ ok: false, error: '"delivered_by" is not available to you' });
    expect(await run("add_widget", { id: "x", kind: "table", title: "x", query_kind: "breakdown", measure: "visits", dimension: "delivered_by" })).toMatchObject({ applied: false });
    expect(await run("add_filter", { field: "delivered_by" })).toMatchObject({ applied: false });
    expect((await run("list_values", { dimension: "province" })).ok).toBe(true);
    // A dimension's values are counted with a measure the caller may use, even when the usual one is hidden.
    const noVisits = Object.fromEntries(boardTools({ pack: h.pack, connector: h.connector, store: h.store, boardId: board.id, ctx: { ...h.ctx, hidden: new Set(["visits"]) } }).map((t) => [t.name, t]));
    expect(await noVisits.list_values!.execute(noVisits.list_values!.inputSchema.parse({ dimension: "province" }) as never)).toMatchObject({ ok: true });
    expect(() => boardTools({ pack: h.pack, connector: h.connector, store: h.store, boardId: board.id, ctx: { hidden }, runSql: "role-scoped" })).toThrow(/run_sql/);
  });

  it("shows the chat's tools a board, and a query's statement, only as the board API would show the caller", async () => {
    const h = hosts.find((x) => x.name === "campaign")!;
    await h.store.create({ id: "holding", pack: h.pack, title: "Old board", config: holding(h.pack) });
    const toolsFor = (hidden?: ReadonlySet<string>) => {
      const tools = Object.fromEntries(boardTools({ pack: h.pack, connector: h.connector, store: h.store, boardId: "holding", ctx: { ...h.ctx, ...(hidden ? { hidden } : {}) } }).map((t) => [t.name, t]));
      return (name: string, args: Record<string, unknown> = {}) => tools[name]!.execute(tools[name]!.inputSchema.parse(args) as never) as Promise<any>;
    };
    const partner = toolsFor(hiddenKeys(h.pack, { roles: ["partner"], hide: HIDDEN }));
    const read = await partner("get_board");
    expect(read.board).toContain("One village");
    expect(read.board).toContain("(hidden)");
    expect(read.board).not.toContain(VILLAGE);
    // An edit's result and a restore's carry the board too.
    const renamed = await partner("rename_board", { title: "Renamed" });
    expect(renamed.applied).toBe(true);
    expect(renamed.board).not.toContain(VILLAGE);
    const restored = await partner("restore_version", { to: "baseline" });
    expect(restored.applied).toBe(true);
    expect(restored.board).not.toContain(VILLAGE);
    // The compiled statement is not shown to such a caller (the explain route does the same); the numbers are.
    const q = { query_kind: "value", measure: "visits" };
    expect(await partner("query", q)).not.toHaveProperty("sql");
    expect(await partner("explain", q)).not.toHaveProperty("sql");
    expect((await partner("query", q)).ok).toBe(true);
    const staff = toolsFor();
    expect((await staff("get_board")).board).toContain(VILLAGE);
    expect((await staff("query", q)).sql).toBeTruthy();
  });
});

// A made-up village: a value of a key partners may not use.
const VILLAGE = "Lakeside-V9";
/** A board that holds VILLAGE in a board filter's default and in a widget's filter. */
const holding = (pack: Host["pack"]) =>
  boardConfigSchema.parse({
    ...emptyBoard(pack, "Old board"),
    filters: [{ id: "f", type: "select", label: "Village", field: "village", applies: ["*"], default: { values: [VILLAGE] } }],
    widgets: { one: { kind: "kpi", title: "One village", query: { kind: "value", measure: "visits", filters: [{ dimension: "village", op: "in", value: [VILLAGE] }] } } },
    layout: [{ i: "one", x: 0, y: 0, w: 6, h: 4 }],
  });

describe("hidden keys", () => {
  const pack = parsePackText(readFileSync(fileURLToPath(new URL("../../../../examples/campaign/pack.yaml", import.meta.url)), "utf8"));

  it("hide a measure computed from a hidden one, through derived and per-level measures", () => {
    const fromDelivered = hiddenKeys(pack, { roles: ["x"], hide: ["households_delivered"] });
    for (const k of ["households_delivered", "delivery_rate", "household_coverage", "coverage_points", "coverage_gap_points", "households_remaining"]) expect(fromDelivered.has(k)).toBe(true);
    expect(fromDelivered.has("visits")).toBe(false);
    const fromLevel = hiddenKeys(pack, { roles: ["x"], hide: ["household_target_at_district"] });
    expect([...fromLevel].sort()).toEqual(["coverage_gap_points", "coverage_points", "household_coverage", "household_target", "household_target_at_district", "households_remaining"]);
  });
});
