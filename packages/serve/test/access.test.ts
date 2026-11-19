import { mkdtempSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { boardTools } from "@lenspack/mcp";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { parsePackText } from "@lenspack/spec";
import { MockLanguageModelV4 } from "ai/test";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seed } from "../../../examples/campaign/seed";
import { type AuditEvent, type Host, accessFrom, authSchema, buildProvider, createApp, hiddenKeys, openConfig, readConfig, registerLlmAdapter, seedBoards } from "../src";

// Pack access by role: who may open a pack, which keys they may use, and the
// rows they see. Every way a key's values could reach a caller is tried here
// with a caller it is hidden from: the catalogue, the pack file, explain,
// board data, filter menus, selections, drills, shared boards, copies, edits,
// the chat's prompt and its tools.

const campaign = fileURLToPath(new URL("../../../examples/campaign/", import.meta.url));
const SECRET = "p".repeat(32);
const HIDDEN = ["delivered_by", "not_delivered_reason", "village", "distributors_active"];

describe("pack access by role", () => {
  const dir = mkdtempSync(join(tmpdir(), "lenspack-access-"));
  const events: AuditEvent[] = [];
  const prompts: string[] = [];
  let server: Server;
  let api: string;
  let hosts: Host[];
  let close: () => Promise<void>;

  // A login proxy in front, as auth.proxy reads it: the user and their groups.
  const call = async (who: string | null, path: string, init: RequestInit = {}) => {
    const [user, groups] = (who ?? "").split(":");
    const headers: Record<string, string> = { "content-type": "application/json", ...(who ? { "x-lenspack-proxy-secret": SECRET, "x-forwarded-user": user!, "x-forwarded-groups": groups ?? "" } : {}) };
    const r = await fetch(`${api}${path}`, { ...init, headers });
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, body, text };
  };
  const staff = "sam:staff";
  const partner = "pat:partner,newsletter";
  const auditor = "abe:auditor";
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  const keysOf = (catalogue: { dimensions: { key: string }[]; measures: { key: string }[] }) => [...catalogue.dimensions, ...catalogue.measures].map((k) => k.key);

  beforeAll(async () => {
    const db = await openDuckdb(join(dir, "campaign.duckdb"));
    await seed(db.writer, "duckdb", { households: 3000 });
    await db.close();
    const file = join(dir, "lenspack.yaml");
    writeFileSync(
      file,
      `sources:
  data: { kind: duckdb, path: ${join(dir, "campaign.duckdb")} }
packs:
  - pack: ${campaign}pack.yaml
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
    // A chat model that only answers, so each turn's system prompt can be read.
    registerLlmAdapter({
      kind: "access-mock",
      defaultBaseUrl: "mock:",
      build: () =>
        new MockLanguageModelV4({
          doStream: async (opts) => {
            prompts.push(JSON.stringify(opts.prompt.filter((m) => m.role === "system")));
            return {
              stream: new ReadableStream({
                start(c) {
                  c.enqueue({ type: "text-start", id: "t" });
                  c.enqueue({ type: "text-delta", id: "t", delta: "ok" });
                  c.enqueue({ type: "text-end", id: "t" });
                  c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
                  c.close();
                },
              }),
            };
          },
        }),
    });
    const providers = [{ ...buildProvider({ name: "mock", kind: "access-mock", model: "m" }), available: true }];
    const access = accessFrom(authSchema.parse({ kind: "proxy", secret: SECRET, rolesHeader: "x-forwarded-groups", editors: ["*"], maintainers: ["role:staff"], usage: ["role:auditor"] }));
    server = createServer(createApp(hosts, { access, providers, audit: (e) => events.push(e) }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  afterAll(async () => {
    server.close();
    await close();
  });

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
    for (const path of ["/campaign/overview?include=data", "/campaign/overview/data", "/campaign/overview/canonical"]) {
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

    const copy = await call(partner, `/campaign/${id}/copy`, post({}));
    expect(copy.status).toBe(200);
    const theirs = await call(partner, `/campaign/${copy.body.id}?include=data`);
    expect(theirs.body.data.who.error).toMatch(/not available/);
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
    expect(theirs).toContain("province");
    for (const k of HIDDEN) expect(theirs).not.toContain(k);
    const mine = await call(staff, "/campaign/boards", post({ title: "Chat" }));
    expect(await turn(staff, mine.body.id)).toContain("delivered_by");
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
    expect(() => boardTools({ pack: h.pack, connector: h.connector, store: h.store, boardId: board.id, ctx: { hidden }, runSql: "role-scoped" })).toThrow(/run_sql/);
  });
});

describe("hidden keys", () => {
  const pack = parsePackText(readFileSync(fileURLToPath(new URL("../../../examples/campaign/pack.yaml", import.meta.url)), "utf8"));

  it("hide a measure computed from a hidden one, through derived and per-level measures", () => {
    const fromDelivered = hiddenKeys(pack, { roles: ["x"], hide: ["households_delivered"] });
    for (const k of ["households_delivered", "delivery_rate", "household_coverage", "coverage_points", "coverage_gap_points", "households_remaining"]) expect(fromDelivered.has(k)).toBe(true);
    expect(fromDelivered.has("visits")).toBe(false);
    const fromLevel = hiddenKeys(pack, { roles: ["x"], hide: ["household_target_at_district"] });
    expect([...fromLevel].sort()).toEqual(["coverage_gap_points", "coverage_points", "household_coverage", "household_target", "household_target_at_district", "households_remaining"]);
  });
});
