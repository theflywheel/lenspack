import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script, runInNewContext } from "node:vm";

import { parsePackText } from "@lenspack/pack";
import { type Principal, principalOf } from "@lenspack/policy";
import { sqlConnector } from "@lenspack/sql";
import { openDuckdb } from "@lenspack/sql/duckdb";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AuditEvent, type Provider, adminSettings, buildProvider, panelRoutes, readBoards, readTelemetry, registerLlmAdapter, reviewSystem, usageBoard, usageFromAudit, usageFromTelemetry, usagePackDir } from "../src";

const USAGE_BOARD = readBoards(`${usagePackDir()}boards`).find((b) => b.id === "overview")!;

const fixture = fileURLToPath(new URL("./fixtures/telemetry-2026-11.jsonl", import.meta.url));
const usageTokens = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const NOW = new Date("2026-11-26T09:00:00Z");

const auditTurn = (at: string, user: string, board: string, detail: Record<string, unknown>): AuditEvent => ({ at, user, pack: "shop", board, action: "chat-turn", outcome: "ok", detail: JSON.stringify(detail) });

describe("the usage pack's rows", () => {
  it("reads the audit log's chat turns", () => {
    const t = usageFromAudit([
      auditTurn("2026-11-25T09:00:00Z", "ana", "b1", { instruction: "how many?", answer: "4", calls: [{ tool: "query", input: { measure: "sales" }, ok: true }], refusals: [], costUsd: 0.02, models: ["m1"], ms: 2500 }),
      auditTurn("2026-11-25T10:00:00Z", "ben", "b1", { instruction: "add a chart", answer: "Done", calls: [{ tool: "add_widget", ok: true }], refusals: ["no such key"], outcome: "saved", sttUsd: 0.001 }),
      auditTurn("2026-11-25T11:00:00Z", "ben", "b2", { instruction: "which?", answer: "", calls: [], refusals: [] }),
      { at: "2026-11-25T11:00:00Z", user: "ben", action: "ops", outcome: "ok" },
    ]);
    expect(t.turns.map((r) => [r.kind, r.answer_kind, r.outcome, r.input])).toEqual([
      ["answer", "direct", "answered", "typed"],
      ["edit", "chart", "answered", "spoken"],
      ["answer", "meta", "failed", "typed"],
    ]);
    expect(t.turns[0]).toMatchObject({ usd: 0.02, model: "m1", reply_s: 2.5 });
    expect(t.turns[1]!.refused).toBe(1);
  });

  it("reads the turn telemetry and its events when the server writes them", () => {
    const lines = readTelemetry(join(fixture, ".."), new Date("2026-11-01T00:00:00Z"));
    const t = usageFromTelemetry(lines);
    expect(t.turns).toHaveLength(40);
    expect(t.events.filter((e) => e.event === "feedback" && e.value === "down").length).toBe(10);
    expect(new Set(t.turns.map((r) => r.answer_kind))).toEqual(new Set(["direct", "derived", "chart", "meta"]));
    expect(t.roles.length).toBeGreaterThan(40);
    expect(t.turns[0]).toMatchObject({ chat_session: "s0", country: "Country A", input: "spoken", reply_s: 3, first_token_s: 0.8, cache_tier: "t1", speech_s: 4.5 });
  });

  it("reads what the switches left out as missing, not as a value, and keeps transcripts and events that belong to no turn", () => {
    const at = "2026-11-20T10:00:00.000Z";
    const t = usageFromTelemetry([
      // No user and no roles field: their switches were off when it was written.
      { type: "turn", v: 2, turnId: "a", at, sessionId: "s", pack: "p", board: "b", kind: "direct", outcome: "answered", input: "spoken", questionHash: "h", questionWords: 6, transcriptEditDistance: 2, queueMs: 1200 },
      { type: "transcript", v: 2, transcriptId: "x", at, user: "ana", model: "speech-a", seconds: 4, usd: 0.0005, ms: 300, words: 6 },
      { type: "event", v: 2, event: "voice-not-sent", at, stage: "review" },
      { type: "event", v: 2, event: "quick-reply", at, turnId: "a", choice: "Last week" },
    ] as never);
    expect(t.turns[0]).toMatchObject({ user_name: null, question_hash: "h", question_words: 6, transcript_edits: 2, edited: 1, queue_s: 1.2, waited: 1 });
    expect(t.roles).toEqual([]);
    expect(t.transcripts).toEqual([{ transcript_id: "x", at, user_name: "ana", model: "speech-a", language: null, seconds: 4, usd: 0.0005, ms: 300, words: 6 }]);
    expect(t.events).toEqual([
      { turn_id: null, event: "voice-not-sent", value: null, reason: null, stage: "review", at, user_name: null },
      { turn_id: "a", event: "quick-reply", value: "Last week", reason: null, stage: null, at, user_name: null },
    ]);
  });
});

const PACK = parsePackText(`pack: shop
version: 1
entities:
  sales: { source: sales, grain: one row per sale }
dimensions:
  - { key: region, entity: sales, sql: region }
measures:
  - { key: sales, entity: sales, agg: count }
`);

describe("the admin panel", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-panel-"));
  const lines: AuditEvent[] = [];
  let server: ReturnType<typeof createServer>;
  let base = "";
  let close: () => Promise<void>;
  let usage: Awaited<ReturnType<typeof usageBoard>>;
  const as = (user: string, admin: boolean) => ({ "x-test-user": user, "x-test-admin": admin ? "1" : "0" });

  beforeAll(async () => {
    copyFileSync(fixture, join(dir, "telemetry-2026-11.jsonl"));
    const db = await openDuckdb(":memory:");
    await db.writer.exec("CREATE TABLE sales (region VARCHAR)");
    const admin = adminSettings(dir, {}, {});
    // The usage chat's model: answers in one round, no tools.
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: new ReadableStream({ start(c) { for (const p of [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "The sales board cost most." }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usageTokens }]) c.enqueue(p as never); c.close(); } }) }),
    });
    registerLlmAdapter({ kind: "panel-mock", defaultBaseUrl: "mock:", build: () => model });
    const providers: Provider[] = [{ ...buildProvider({ name: "m", kind: "panel-mock", model: "m" }), available: true }];
    const review = reviewSystem({ stateDir: dir, hosts: [{ name: "shop", pack: PACK, connector: sqlConnector(db.executor), ctx: {} }], features: admin.features, settings: admin.settings, providers: () => providers, events: () => lines, audit: (e) => lines.push(e) });
    usage = await usageBoard({ stateDir: dir, events: () => lines, providers: () => providers, audit: (e) => lines.push(e), review: () => false, now: () => NOW });
    const panel = panelRoutes({ prefix: "/_x", system: review, features: admin.features, brand: admin.brand, providers: () => providers, adminName: "maintainer", title: "Shop <b>", usage });
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
      const who: Principal = principalOf({ user: String(req.headers["x-test-user"] ?? "anon"), edit: true, maintain: true, roles: req.headers["x-test-admin"] === "1" ? ["admin"] : [], ...(req.headers["x-test-usage"] === "0" ? { usage: false } : {}) });
      if (!(await panel(req, res, url, who))) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/_x/admin`;
    close = async () => {
      server.close();
      await usage?.close();
      await db.close();
    };
  });
  afterAll(() => close());

  it("is for admins only: a non-admin gets 403 on the page and the API, and the refusal is audited", async () => {
    const page = await fetch(`${base}/`, { headers: as("viv", false) });
    expect(page.status).toBe(403);
    for (const path of ["api/packs", "api/definitions", "api/usage/overview/data"]) expect((await fetch(`${base}/${path}`, { headers: as("viv", false) })).status).toBe(403);
    const post = await fetch(`${base}/api/review/run`, { method: "POST", body: JSON.stringify({ confirm: true }), headers: as("viv", false) });
    expect(post.status).toBe(403);
    expect(lines.some((l) => l.user === "viv" && l.outcome === "denied")).toBe(true);
  });

  it("names the assistant as an admin sets it: admins only, audited, and on the next page load", async () => {
    const put = (body: unknown, admin = true) => fetch(`${base}/api/settings/brand`, { method: "PUT", headers: { ...as(admin ? "ana" : "viv", admin), "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await put({ name: "Campaign assistant" }, false)).status).toBe(403);
    expect(lines.some((l) => l.user === "viv" && l.action === "PUT /_x/admin/api/settings/brand" && l.outcome === "denied")).toBe(true);
    expect((await (await fetch(`${base}/`, { headers: as("ana", true) })).text())).toContain("<h1 data-t=\"title\">Lenspack admin</h1>");
    const r = await put({ name: "Campaign assistant", buttonLabel: "Ask the data", i18n: { fr: { buttonLabel: "Interroger les données" } } });
    expect(r.status).toBe(200);
    expect((await r.json()).brand).toMatchObject({ values: { name: "Campaign assistant", buttonLabel: "Ask the data", i18n: { fr: { buttonLabel: "Interroger les données" } } }, source: { name: "settings" }, writable: true });
    expect(lines).toContainEqual(expect.objectContaining({ user: "ana", action: "settings brand", outcome: "ok", detail: expect.stringContaining("Campaign assistant") }));
    const html = await (await fetch(`${base}/`, { headers: as("ana", true) })).text();
    expect(html).toContain("<title>Shop b · Campaign assistant admin</title>");
    expect(html).toContain('data-name="Campaign assistant"');
    expect((await (await fetch(`${base}/api/settings`, { headers: as("ana", true) })).json()).brand.values.name).toBe("Campaign assistant");
    // An icon replaces the header's mark.
    expect((await put({ icon: "/static/mark.png" })).status).toBe(200);
    expect(await (await fetch(`${base}/`, { headers: as("ana", true) })).text()).toContain('<span class="mark icon" aria-hidden="true"><img src="/static/mark.png" alt=""></span>');
    // Markup is refused, and changes nothing.
    const bad = await put({ name: "<img src=x onerror=alert(1)>" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("brand.name: name is plain text: no < or >");
    // Back to the deployment's value.
    expect((await put({ name: null, buttonLabel: null, i18n: null, icon: null })).status).toBe(200);
    expect(await (await fetch(`${base}/`, { headers: as("ana", true) })).text()).toContain("Shop b · Lenspack admin");
  });

  it("serves the page, its script and the board renderer's files to an admin", async () => {
    const redirect = await fetch(base, { headers: as("ana", true), redirect: "manual" });
    expect(redirect.status).toBe(302);
    const html = await (await fetch(`${base}/`, { headers: as("ana", true) })).text();
    expect(html).toContain("panel.js");
    expect(html).toContain("Shop b · Lenspack admin");
    const js = await (await fetch(`${base}/panel.js`, { headers: as("ana", true) })).text();
    // The script parses, and has both languages and every tab.
    expect(() => new Script(js)).not.toThrow();
    expect(js).toContain("const TABS = { overview, review, questions, proposals, definitions, telemetry, cache, settings };");
    expect(js).toContain('fr: {');
    expect((await fetch(`${base}/panel.css`, { headers: as("ana", true) })).status).toBe(200);
    // The Telemetry tab is its own module and stylesheet, which the page loads before the panel mounts it.
    expect(html.indexOf("telemetry.js")).toBeGreaterThan(-1);
    expect(html.indexOf("telemetry.js")).toBeLessThan(html.indexOf("panel.js"));
    expect(html).toContain("telemetry.css");
    const tjs = await (await fetch(`${base}/telemetry.js`, { headers: as("ana", true) })).text();
    const tbox: { window: { LenspackTelemetry?: { strings: Record<string, Record<string, string>>; create: Function } } } = { window: {} };
    runInNewContext(tjs, { ...tbox, document: { addEventListener: () => {} } });
    expect(Object.keys(tbox.window.LenspackTelemetry!.strings)).toEqual(["en", "fr"]);
    // Every word in one language is in the other.
    expect(Object.keys(tbox.window.LenspackTelemetry!.strings.fr!).sort()).toEqual(Object.keys(tbox.window.LenspackTelemetry!.strings.en!).sort());
    expect(js).toContain("window.LenspackTelemetry.create(");
    expect((await fetch(`${base}/telemetry.css`, { headers: as("ana", true) })).status).toBe(200);
    // The Cache tab reads the saved answers' own admin routes (docs/features/saved-answers.md).
    for (const route of ["../cache${path}", "/chart-candidates", "/boards", "/suggestions?board=", "/prewarm", '"unpin" : "pin"', "/evict"]) expect(js).toContain(route);
    const packs = await (await fetch(`${base}/api/packs`, { headers: as("ana", true) })).json();
    expect(packs.usage).toEqual({ board: "overview", telemetryBoard: "telemetry", source: "telemetry" });
  });

  it("serves the telemetry tab's script, which sums up what's recorded and copies it as Markdown with each switch", async () => {
    const js = await (await fetch(`${base}/checklist.js`, { headers: as("ana", true) })).text();
    const box: { window: { LenspackChecklist?: { summary: Function; markdown: Function; counts: Function } } } = { window: {} };
    runInNewContext(js, box);
    const C = box.window.LenspackChecklist!;
    // Made-up data, made by telemetryChecklist itself.
    const data = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/telemetry-checklist.json", import.meta.url)), "utf8"));
    const words: Record<string, string> = { tlSumRecording: "{0} of {1} fields recording", tlSumNoData: "{0} on, nothing yet", tlSumConfig: "{0} need configuration", tlSumOff: "{0} off", tlTitle: "Telemetry", tlViewRecorded: "What's recorded", tlViewMetrics: "What it tells you", tlOn: "on", tlOff: "off", tlMixed: "mixed", tlNoSwitch: "no switch", tlOffSince: "Off since {0}, by {1}.", tlMaster: "Record telemetry", st_off: "off", st_recording: "recording", tmNoData: "Nothing recorded in the last 7 days." };
    const t = (k: string, ...a: unknown[]) => (words[k] ?? k).replace(/\{(\d)\}/g, (_, i) => String(a[Number(i)]));
    expect(C.summary(data, t)).toBe("23 of 34 fields recording · 3 on, nothing yet · 1 need configuration · 7 off");
    const md: string = C.markdown(data, t);
    expect(md.startsWith("# Telemetry")).toBe(true);
    expect(md).toContain("- Record telemetry: on");
    expect(md.split("\n").filter((l) => /^\| (on|off|no switch) \|/.test(l))).toHaveLength(34);
    // Each switch as it stands, a locked one with its reason, and a category's state worked out from its switches.
    expect(md).toMatch(/\| off \| Question words \| ○ off \|/);
    expect(md).toMatch(/\| off \| Daily review runs and proposals \| ○ off \|.*Owned by the daily review switch/);
    expect(md).toContain("### Texts (off)");
    // What reads each field: the usage board's widgets.
    expect(md).toMatch(/\| on \| User name \| ✓ recording \| \d+ \| Active users, 7 days · /);
    expect(md).not.toContain("What it tells you");
  });

  it("draws the usage board from the telemetry, through the same board API as every board", async () => {
    const board = await (await fetch(`${base}/api/usage/overview`, { headers: as("ana", true) })).json();
    expect(Object.keys(board.board.config.widgets)).toHaveLength(USAGE_BOARD.ops.length);
    expect(board.writable).toBe(true);
    const data = (await (await fetch(`${base}/api/usage/overview/data`, { headers: as("ana", true) })).json()) as Record<string, { error?: string; rows: { group: string; value: number | null }[] }>;
    for (const [id, d] of Object.entries(data)) expect(d.error, id).toBeUndefined();
    expect(data.kind_mix!.rows).toHaveLength(4);
    expect(data.thumbs_down!.rows.find((r) => r.group === "wrong number")?.value).toBeGreaterThan(0);
    expect(data.wau_role!.rows.length).toBeGreaterThan(0);
    expect(data.p95_kind!.rows.length).toBe(4);
    expect(data.dau_country!.rows.length).toBeGreaterThan(0);
  });

  it("hides who asked from an admin the policy does not let see usernames", async () => {
    const headers = { ...as("ana", true), "x-test-usage": "0" };
    const pack = await (await fetch(`${base}/api/usage/overview`, { headers })).json();
    const keys = JSON.stringify(pack.catalogue ?? pack.pack ?? pack);
    expect(keys).not.toContain('"user"');
    const data = (await (await fetch(`${base}/api/usage/overview/data`, { headers })).json()) as Record<string, { error?: string }>;
    expect(data.top_users?.error).toBeTruthy();
    expect(data.turns_today?.error).toBeUndefined();
  });

  it("an admin can edit the usage board like any board", async () => {
    const r = await (await fetch(`${base}/api/usage/overview/ops`, { method: "POST", headers: as("ana", true), body: JSON.stringify({ ops: [{ op: "set_title", title: "Usage, edited" }] }) })).json();
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.board.config.title).toBe("Usage, edited");
  });

  it("answers questions about usage, logs them as internal, and the daily review leaves them out", async () => {
    const out = await (await fetch(`${base}/api/usage/overview/chat?model=m`, { method: "POST", headers: as("ana", true), body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Which board cost most this week?" }] }] }) })).text();
    expect(out).toContain("The sales board cost most.");
    const turn = lines.find((l) => l.action === "chat-turn" && l.pack === "usage");
    expect(turn).toMatchObject({ user: "ana", internal: true });
    expect(readFileSync(join(dir, "telemetry-2026-11.jsonl"), "utf8")).not.toContain("Which board cost most");
  });
});
