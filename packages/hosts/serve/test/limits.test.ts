// Per-person question limits on the chat route: refused with 429 and Retry-After before any model call, in the reader's
// language; today's counts kept in a private file that outlives a restart; a saved answer counts toward the windows but
// not the daily quota; the admin routes read and change the limits and never count as questions.
import { mkdtempSync, statSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PerUserLimits } from "@lenspack/policy";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type Host, type Provider, type Reuse, adminRoutes, adminSettings, buildProvider, configSchema, createApp, limitCounter, limitSettings, limitsFromEnv, openConfig, registerLlmAdapter } from "../src";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
let modelCalls = 0;
const model = () =>
  new MockLanguageModelV4({
    doStream: async () => {
      modelCalls++;
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Done." }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }]) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  });

/** Saved answers that answer "saved?" and nothing else, with no model and no query. */
const savedOnly = {
  attach() {},
  prune: async () => {},
  noteEvent() {},
  suggestions: async () => [],
  remember: async () => {},
  acceptedBefore: async () => false,
  serve: async (t: { question: string }) => (t.question === "saved?" ? { tier: "t1", entry: { id: "e1" }, reply: "From before.", calls: [], note: { tier: "t1", kind: "answer" }, savedUsd: 0, dataAsOf: new Date().toISOString() } : null),
} as unknown as Reuse;

describe("per-person question limits", () => {
  const tickets = fileURLToPath(new URL("../../../../examples/tickets/pack.yaml", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "lenspack-limits-"));
  const file = join(dir, "limits.json");
  let host: Host;
  let close: () => Promise<void>;
  let provider: Provider;
  const servers: Server[] = [];
  let limits: PerUserLimits = {};
  const audited: { action: string; outcome: string; detail?: string; user: string }[] = [];
  const clock = { now: Date.parse("2026-11-27T10:00:00Z") };

  beforeAll(async () => {
    const opened = await openConfig(configSchema.parse({ sources: { data: { url: "duckdb::memory:" } }, packs: [{ pack: tickets, source: "data" }] }), tmpdir());
    host = opened.hosts[0]!;
    close = opened.close;
    await host.store.create({ id: "lim", pack: host.pack, title: "Overview" });
    registerLlmAdapter({ kind: "limits-mock", defaultBaseUrl: "mock:", build: () => model() });
    provider = { ...buildProvider({ name: "mock", kind: "limits-mock", model: "m", pricing: { input: 1, output: 2 } }), available: true };
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    await close();
  });
  beforeEach(() => {
    clock.now += 86_400_000;
    audited.length = 0;
  });

  /** A server whose counts live in `file`; x-user names who asks, x-admin makes them an admin. */
  const start = async (counter = limitCounter({ limits: () => limits, file, now: () => clock.now })) => {
    const access = (req: { headers: Record<string, unknown> }) => ({ user: String(req.headers["x-user"] ?? "olu"), edit: true, maintain: true, roles: req.headers["x-admin"] ? ["admin"] : [] });
    const server = createServer(createApp([host], { providers: [provider], limits: counter, reuse: savedOnly, access: access as never, audit: (e) => audited.push(e as never) }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/${host.name}/lim`, counter };
  };
  const ask = (base: string, o: { user?: string; text?: string; admin?: boolean; uiLanguage?: string; language?: string } = {}) =>
    fetch(`${base}/chat?review=off`, {
      method: "POST",
      headers: { "x-user": o.user ?? "olu", ...(o.admin ? { "x-admin": "1" } : {}) },
      body: JSON.stringify({ messages: [{ id: "u", role: "user", parts: [{ type: "text", text: o.text ?? "how many tickets?" }] }], ...(o.uiLanguage ? { uiLanguage: o.uiLanguage } : {}), ...(o.language ? { language: o.language } : {}) }),
    }).then(async (r) => ({ status: r.status, retryAfter: r.headers.get("retry-after"), body: r.status === 429 ? ((await r.json()) as Record<string, unknown>) : await r.text() }));

  it("off: no limits set, every question goes through", async () => {
    limits = {};
    const { base } = await start(limitCounter({ limits: () => limits, now: () => clock.now }));
    for (let i = 0; i < 5; i++) expect((await ask(base)).status).toBe(200);
  });

  it("per minute: 429 with Retry-After before any model call, the next minute free again", async () => {
    limits = { perMinute: 2 };
    const { base } = await start(limitCounter({ limits: () => limits, now: () => clock.now }));
    expect((await ask(base)).status).toBe(200);
    clock.now += 10_000;
    expect((await ask(base)).status).toBe(200);
    const before = modelCalls;
    const r = await ask(base);
    expect(r.status).toBe(429);
    expect(modelCalls).toBe(before);
    expect(r.retryAfter).toBe("50");
    expect(r.body).toMatchObject({ code: "limit", limit: "perMinute", max: 2, retryAfterSeconds: 50, error: "You have asked 2 questions in the last minute, the most allowed per person. You can ask again in 50 seconds." });
    // Someone else is not held by olu's count.
    expect((await ask(base, { user: "ada" })).status).toBe(200);
    expect(audited.find((e) => e.outcome === "denied")).toMatchObject({ user: "olu", action: "chat", detail: "limit: perMinute (2); free in 50 s" });
    clock.now += 50_000;
    expect((await ask(base)).status).toBe(200);
  });

  it("says so in the panel's language, or the browser's", async () => {
    limits = { perHour: 1 };
    const { base } = await start(limitCounter({ limits: () => limits, now: () => clock.now }));
    await ask(base);
    const fr = await ask(base, { language: "auto", uiLanguage: "fr" });
    expect((fr.body as { error: string }).error).toBe("Vous avez posé 1 question au cours de la dernière heure, le maximum autorisé par personne. Vous pourrez en poser de nouveau dans 60 minutes.");
    const pt = await fetch(`${base}/chat`, { method: "POST", headers: { "x-user": "olu", "accept-language": "pt-PT,pt;q=0.9" }, body: JSON.stringify({ messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "q" }] }] }) });
    expect(((await pt.json()) as { error: string }).error).toMatch(/^Fez 1 pergunta na última hora/);
  });

  it("the daily quota is kept in a private file and outlives a restart", async () => {
    limits = { questionsPerDay: 2 };
    const one = await start();
    expect((await ask(one.base)).status).toBe(200);
    expect((await ask(one.base)).status).toBe(200);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A new process on the same state directory: today's counts are read back.
    const two = await start();
    const r = await ask(two.base);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ limit: "questionsPerDay", max: 2 });
    expect(r.body.error).toMatch(/after midnight UTC, in 14 hours\.$/);
    // The next day starts from zero.
    clock.now += 86_400_000;
    expect((await ask((await start()).base)).status).toBe(200);
  });

  it("a saved answer counts toward the windows but not the daily quota", async () => {
    limits = { questionsPerDay: 2, perMinute: 3 };
    const { base, counter } = await start();
    const before = modelCalls;
    expect((await ask(base, { text: "saved?" })).status).toBe(200);
    expect((await ask(base, { text: "saved?" })).status).toBe(200);
    expect(modelCalls).toBe(before);
    expect(counter.report({ all: true }).people[0]).toMatchObject({ user: "olu", today: 0, lastMinute: 2 });
    // A model question counts in both; then the minute is full, for saved answers too.
    expect((await ask(base)).status).toBe(200);
    expect(counter.report({ all: true }).people[0]).toMatchObject({ today: 1, lastMinute: 3 });
    expect((await ask(base, { text: "saved?" })).body).toMatchObject({ limit: "perMinute" });
    // A refusal is not counted.
    expect(counter.report({ all: true }).people[0]).toMatchObject({ today: 1, lastMinute: 3, refusedToday: 1 });
    clock.now += 61_000;
    expect((await ask(base)).status).toBe(200);
    // The quota used up: a saved answer is refused too, as the lookup itself may need the model.
    expect((await ask(base, { text: "saved?" })).body).toMatchObject({ limit: "questionsPerDay" });
  });

  it("admins are held to the limits unless adminsExempt", async () => {
    limits = { questionsPerDay: 1 };
    const { base } = await start(limitCounter({ limits: () => limits, now: () => clock.now }));
    expect((await ask(base, { user: "ada", admin: true })).status).toBe(200);
    expect((await ask(base, { user: "ada", admin: true })).status).toBe(429);
    limits = { questionsPerDay: 1, adminsExempt: true };
    expect((await ask(base, { user: "ada", admin: true })).status).toBe(200);
    expect((await ask(base)).status).toBe(200);
    expect((await ask(base)).status).toBe(429);
  });

  it("settings: off by default, LENSPACK_LIMIT_* over the config, the settings page over both", () => {
    expect(limitSettings(null).view(false)).toMatchObject({ on: false, questionsPerDay: 0, perMinute: 0, perHour: 0, adminsExempt: false });
    expect(limitsFromEnv({ LENSPACK_LIMIT_QUESTIONS_PER_DAY: "200", LENSPACK_LIMIT_PER_MINUTE: "5", LENSPACK_LIMIT_ADMINS_EXEMPT: "true" })).toEqual({ questionsPerDay: 200, perMinute: 5, adminsExempt: true });
    expect(() => limitsFromEnv({ LENSPACK_LIMIT_PER_HOUR: "lots" })).toThrow(/perHour is a whole number/);
    const s = limitSettings(null, { questionsPerDay: 100, perHour: 30 }, { LENSPACK_LIMIT_PER_HOUR: "60" });
    expect(s.get()).toEqual({ questionsPerDay: 100, perHour: 60 });
    expect(s.line()).toBe("limits per person: 100 questions a day (UTC), 60 an hour; admins not exempt");
    expect(limitSettings(null).line()).toBe("limits per person: off");
  });

  it("the admin routes read and change the limits, and never count as questions", async () => {
    const state = mkdtempSync(join(tmpdir(), "lenspack-limits-admin-"));
    const admin = adminSettings(state, { limits: { perUser: { perMinute: 5 } } }, {});
    expect(admin.limitsLine()).toMatch(/^limits per person: 5 a minute; admins not exempt; today's counts in .*limits\.json$/);
    const routes = adminRoutes({ prefix: "/_x", settings: admin, providers: [], audit: null, log: () => {}, adminName: "admin", writable: () => true });
    const server = createServer((req, res) => void routes(req, res, new URL(req.url!, "http://x"), { user: String(req.headers["x-user"] ?? "boss"), roles: req.headers["x-user"] ? [] : ["admin"], edit: true } as never));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}/_x`;
    const got = (await (await fetch(`${at}/settings`)).json()) as { limits: Record<string, unknown> };
    expect(got.limits).toMatchObject({ perMinute: 5, questionsPerDay: 0, on: true, source: "default", writable: true });
    const put = await fetch(`${at}/settings/limits`, { method: "PUT", body: JSON.stringify({ questionsPerDay: 50, adminsExempt: true }) });
    expect(await put.json()).toMatchObject({ perMinute: 5, questionsPerDay: 50, adminsExempt: true, source: "settings" });
    expect((await fetch(`${at}/settings/limits`, { method: "PUT", body: JSON.stringify({ perMinute: -1 }) })).status).toBe(400);
    expect((await fetch(`${at}/settings/limits`, { method: "PUT", headers: { "x-user": "olu" }, body: JSON.stringify({ perMinute: 0 }) })).status).toBe(403);
    // Back to the deployment's value.
    expect(await (await fetch(`${at}/settings/limits`, { method: "PUT", body: JSON.stringify({ questionsPerDay: null }) })).json()).toMatchObject({ questionsPerDay: 0 });
    // None of that was a question: nobody is counted.
    expect(admin.limitCounts.report({ all: true }).people).toEqual([]);
    // Who is at a limit, and one person's count cleared.
    const t = admin.limitCounts.admit({ user: "olu", admin: false });
    if (t.ok) t.place.charge();
    expect(((await (await fetch(`${at}/limits?all=1`)).json()) as { people: { user: string; today: number }[] }).people).toMatchObject([{ user: "olu", today: 1 }]);
    expect(await (await fetch(`${at}/limits?user=olu`, { method: "DELETE" })).json()).toEqual({ cleared: true, user: "olu" });
    expect(admin.limitCounts.report({ all: true }).people).toEqual([]);
  });
});
