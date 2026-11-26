// Data export through HTTP: the export token (from the environment, compared in equal time, refused when unset),
// streaming JSON lines and CSV a cursor page at a time, today's switches deciding what leaves, and one audit line per
// request. Which streams a token may read and how records are shaped is tested without a host, in packages/kernel/agent.
import { type Server, createServer } from "node:http";

import { type TelemetryLine, TELEMETRY_ITEMS, switchable } from "@lenspack/agent";
import { afterEach, describe, expect, it } from "vitest";

import { type AuditEvent, type ExportSources, EXPORT_PREFIX, csvCell, exportGrantFromEnv, exportRoutes, sameToken } from "../src";

const TOKEN = "export-token-for-tests-0123456789";
const ALL = new Set(TELEMETRY_ITEMS.filter(switchable).map((s) => s.id));
const hash = (s: string) => Buffer.from(s).toString("hex").padEnd(64, "0");
const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m)).toISOString();
const turn = (i: number, o: Record<string, unknown> = {}) =>
  ({ type: "turn", v: 1, turnId: `t${i}`, sessionId: "s1", at: at(i), user: i % 2 ? "ben" : "ana", roles: ["Viewer"], tenant: null, board: "b1", pack: "p", datasets: ["d1"], question: `question ${i}`, questionHash: `qh${i}`, kind: "direct", outcome: "answered", costUsd: 0.01, models: ["model-a"], ...o }) as unknown as TelemetryLine;

let server: Server | null = null;
afterEach(() => void server?.close());

async function serve(o: { env?: Record<string, string>; lines?: TelemetryLine[]; items?: Set<string>; telemetry?: boolean; events?: AuditEvent[] } = {}) {
  const written: AuditEvent[] = [];
  const lines = o.lines ?? Array.from({ length: 5 }, (_, i) => turn(i));
  const src: ExportSources = {
    telemetry: { find: async (q) => lines.filter((l) => (!q.type || l.type === q.type) && l.at >= q.from.toISOString() && (!q.to || l.at < q.to.toISOString())).reverse() },
    auditSince: (from) => (o.events ?? []).filter((e) => e.at >= from.toISOString()),
    recordings: async () => [],
    keeping: () => ({ itemsOn: o.items ?? ALL, telemetry: o.telemetry ?? true, audit: true }),
    hash,
    audit: (e) => void written.push(e),
    env: { LENSPACK_EXPORT_TOKEN: TOKEN, ...o.env },
    now: () => new Date("2026-11-02T00:00:00Z"),
  };
  const routes = exportRoutes(src);
  server = createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url ?? "/", "http://x")))) res.writeHead(404).end("not export");
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const get = (path: string, init: RequestInit & { token?: string | null } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }), ...(init.headers as Record<string, string>) } });
  return { get, written };
}

const jsonl = async (r: Response) => (await r.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("the export token", () => {
  it("turns export off when unset or too short, and never falls back to anything else", async () => {
    expect(exportGrantFromEnv({})).toEqual({ off: "export is off: LENSPACK_EXPORT_TOKEN is not set" });
    expect(exportGrantFromEnv({ LENSPACK_EXPORT_TOKEN: "short" })).toMatchObject({ off: expect.stringContaining("at least 24") });
    expect(exportGrantFromEnv({ LENSPACK_EXPORT_TOKEN: TOKEN, LENSPACK_EXPORT_STREAMS: "turns,everything" })).toMatchObject({ off: expect.stringContaining("everything") });
    const { get } = await serve({ env: { LENSPACK_EXPORT_TOKEN: "" } });
    const r = await get(`${EXPORT_PREFIX}/turns`);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ code: "export-off" });
  });
  it("refuses a missing or wrong token, and writes the refusal down", async () => {
    const { get, written } = await serve();
    expect((await get(`${EXPORT_PREFIX}/turns`, { token: null })).status).toBe(401);
    expect((await get(`${EXPORT_PREFIX}/turns`, { token: `${TOKEN}x` })).status).toBe(401);
    expect(written.map((e) => [e.user, e.outcome, e.detail])).toEqual([["export:?", "denied", "no token"], ["export:?", "denied", "wrong token"]]);
    expect(sameToken(TOKEN, TOKEN)).toBe(true);
    expect(sameToken(TOKEN, TOKEN.slice(0, -1))).toBe(false);
  });
  it("is read-only and leaves other paths alone", async () => {
    const { get } = await serve();
    expect((await get(`${EXPORT_PREFIX}/turns`, { method: "POST" })).status).toBe(405);
    expect(await (await get("/_superset/settings")).text()).toBe("not export");
  });
});

describe("streams", () => {
  it("pages turns oldest first with a cursor in the Link header, one audit line per page", async () => {
    const { get, written } = await serve();
    const first = await get(`${EXPORT_PREFIX}/turns?limit=2&from=2026-11-01`);
    expect(first.headers.get("content-type")).toContain("application/x-ndjson");
    const a = await jsonl(first);
    expect(a.map((r) => r.turnId)).toEqual(["t0", "t1"]);
    const link = first.headers.get("link")!;
    expect(link).toMatch(/rel="next"/);
    const next = /<([^>]+)>/.exec(link)![1]!;
    const b = await jsonl(await get(next));
    const c = await jsonl(await get(/<([^>]+)>/.exec((await get(next)).headers.get("link")!)![1]!));
    expect([...a, ...b, ...c].map((r) => r.turnId)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(written.filter((e) => e.action === "export turns" && e.outcome === "ok")).toHaveLength(4);
    expect(written[0]!.user).toBe("export:export");
    expect(written[0]!.detail).toContain("2 rows, jsonl, stand-ins");
  });
  it("gives stand-ins for names unless the token has the usernames right", async () => {
    const masked = await jsonl(await (await serve()).get(`${EXPORT_PREFIX}/turns`));
    expect(masked[0]!.user).toMatch(/^u_[0-9a-f]{12}$/);
    const named = await (await serve({ env: { LENSPACK_EXPORT_USERNAMES: "true" } })).get(`${EXPORT_PREFIX}/turns`);
    expect(named.headers.get("x-export-usernames")).toBe("names");
    expect((await jsonl(named))[0]!.user).toBe("ana");
  });
  it("follows today's switches: an item off leaves its fields out, telemetry off refuses the stream", async () => {
    const off = new Set([...ALL].filter((id) => id !== "question-text"));
    const rows = await jsonl(await (await serve({ items: off })).get(`${EXPORT_PREFIX}/turns`));
    expect(rows[0]!.question).toBeUndefined();
    expect(rows[0]!.questionHash).toBe("qh0");
    const r = await (await serve({ telemetry: false })).get(`${EXPORT_PREFIX}/turns`);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ code: "not-kept", error: "turns are not kept on this deployment: usage telemetry is off" });
  });
  it("refuses a stream the token was not given", async () => {
    const { get, written } = await serve({ env: { LENSPACK_EXPORT_STREAMS: "turns", LENSPACK_EXPORT_NAME: "warehouse" } });
    const r = await get(`${EXPORT_PREFIX}/audit`);
    expect(r.status).toBe(403);
    expect(written.at(-1)).toMatchObject({ user: "export:warehouse", action: "export audit", outcome: "denied" });
    expect(await (await get(`${EXPORT_PREFIX}/`)).json()).toMatchObject({ token: "warehouse", streams: ["turns"] });
  });
  it("writes CSV with a header row, defusing cells a spreadsheet would run", async () => {
    const lines = [turn(0, { question: "=1+1, then \"more\"" })];
    const r = await (await serve({ lines })).get(`${EXPORT_PREFIX}/turns?format=csv`);
    expect(r.headers.get("content-type")).toContain("text/csv");
    const [head, row] = (await r.text()).trim().split("\n");
    expect(head!.split(",").slice(0, 3)).toEqual(["at", "turnId", "sessionId"]);
    expect(row).toContain(`"'=1+1, then ""more"""`);
    expect(csvCell(["a", "b"])).toBe("a|b");
  });
  it("exports the audit log and the cost of each turn from it", async () => {
    const events: AuditEvent[] = [
      { at: at(1), user: "ana", action: "chat-turn", outcome: "ok", board: "b1", detail: JSON.stringify({ costUsd: 0.02, sttUsd: 0, models: ["model-a"], tokens: { in: 1000, out: 200 } }) },
      { at: at(2), user: "ben", action: "settings", outcome: "ok", detail: "language" },
    ];
    const { get } = await serve({ events, env: { LENSPACK_EXPORT_USERNAMES: "1" } });
    expect((await jsonl(await get(`${EXPORT_PREFIX}/audit`))).map((e) => e.action)).toEqual(["chat-turn", "settings"]);
    expect(await jsonl(await get(`${EXPORT_PREFIX}/cost`))).toEqual([{ at: at(1), user: "ana", board: "b1", models: ["model-a"], tokensIn: 1000, tokensOut: 200, costUsd: 0.02, sttUsd: 0, unpriced: 0 }]);
  });
  it("leaves a chat turn's words out of the audit export while question text is off", async () => {
    const events: AuditEvent[] = [{ at: at(1), user: "ana", action: "chat-turn", outcome: "ok", detail: JSON.stringify({ instruction: "how many visits", costUsd: 0.02 }) }];
    const off = new Set([...ALL].filter((id) => id !== "question-text"));
    const { get } = await serve({ events, items: off });
    const [line] = await jsonl(await get(`${EXPORT_PREFIX}/audit`));
    expect(line).not.toHaveProperty("detail");
    expect((await jsonl(await get(`${EXPORT_PREFIX}/cost`)))[0]).toMatchObject({ costUsd: 0.02 });
  });
  it("answers bad parameters in words", async () => {
    const { get } = await serve();
    expect((await get(`${EXPORT_PREFIX}/turns?limit=0`)).status).toBe(400);
    expect((await get(`${EXPORT_PREFIX}/turns?from=yesterday`)).status).toBe(400);
    expect(await (await get(`${EXPORT_PREFIX}/turns?cursor=abc`)).json()).toMatchObject({ error: "cursor is not one this server gave" });
  });
});
