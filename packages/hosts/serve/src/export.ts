import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { EXPORT_COLUMNS, type ExportKeeping, type TelemetryLine, decodeCursor, encodeCursor, exportAuditLine, exportLine, exportPage, streamsKept, telemetryStream, withUser } from "@lenspack/agent";
import { EXPORT_STREAMS, type ExportGrant, type ExportStream, exportActor, exportDecision, exportIndex, isExportStream } from "@lenspack/policy";

import { type Audit, type AuditEvent, turnRow } from "./audit";
import type { StoredAudio } from "./audio";
import { NO_STORE, json } from "./http";

// Data export (prototype): read-only streams of a deployment's records for whoever holds its export token, as JSON lines
// or CSV, a cursor page at a time. The token comes from the environment (LENSPACK_EXPORT_TOKEN), so only people with
// access to the deployment's secrets can use it; it is not a sign-in and gives nothing else. Unset, every export route
// answers 404. Policy decides what a token may read (exportDecision); the records leave as @lenspack/agent shapes them
// (today's telemetry switches, stand-ins for names). Every request, refused or not, is one audit line.

export const EXPORT_PREFIX = "/_export/v1";
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
/** Shorter than this is no secret: refused at start rather than accepted. */
const MIN_TOKEN = 24;

export type ExportSources = {
  /** The telemetry log: lines between two times. */
  telemetry?: { find(q: { from: Date; to?: Date; type?: TelemetryLine["type"] }): Promise<TelemetryLine[]> } | null;
  /** The audit log: every event since a time (newest first, as AuditLog.since gives them). */
  auditSince?: ((from: Date) => AuditEvent[]) | null;
  /** Kept recordings, listed (never their audio here). */
  recordings?: (() => Promise<StoredAudio[]>) | null;
  /** The switches as they stand, read on every request. */
  keeping: () => ExportKeeping;
  /** The keyed hash telemetry uses: stand-ins match the admin panel's. */
  hash: (text: string) => string;
  /** Where each export is written down. */
  audit?: Audit | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

/** The one grant the environment gives: LENSPACK_EXPORT_TOKEN, and optionally its name, streams and usernames right. */
export function exportGrantFromEnv(env: NodeJS.ProcessEnv = process.env): { token: string; grant: ExportGrant } | { off: string } {
  const token = (env.LENSPACK_EXPORT_TOKEN ?? "").trim();
  if (!token) return { off: "export is off: LENSPACK_EXPORT_TOKEN is not set" };
  if (token.length < MIN_TOKEN) return { off: `export is off: LENSPACK_EXPORT_TOKEN must be at least ${MIN_TOKEN} characters` };
  const listed = (env.LENSPACK_EXPORT_STREAMS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = listed.filter((s) => !isExportStream(s));
  if (unknown.length) return { off: `export is off: LENSPACK_EXPORT_STREAMS names ${unknown.join(", ")} (streams: ${EXPORT_STREAMS.join(", ")})` };
  return {
    token,
    grant: {
      name: (env.LENSPACK_EXPORT_NAME ?? "").trim().slice(0, 60) || "export",
      streams: listed.length ? (listed as ExportStream[]) : [...EXPORT_STREAMS],
      usernames: ["true", "on", "1", "yes"].includes((env.LENSPACK_EXPORT_USERNAMES ?? "").trim().toLowerCase()),
    },
  };
}

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Equal-time comparison over digests, so neither the token nor its length leaks a byte at a time. */
export const sameToken = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

const bearer = (req: IncomingMessage) => {
  const h = req.headers.authorization;
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(h) ? (h[0] ?? "") : (h ?? ""));
  return m ? m[1]!.trim() : null;
};

/** A CSV cell: arrays joined with "|", objects as JSON, quoted when needed; a leading = + - @ is defused for spreadsheets. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = Array.isArray(v) ? v.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : String(x))).join("|") : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Writes one chunk, waiting while the socket's buffer is full. */
const write = (res: ServerResponse, chunk: string) => (res.write(chunk) ? Promise.resolve() : new Promise<void>((r) => res.once("drain", () => r())));

/** The export routes, answering by responding; false when the path is not theirs. */
export function exportRoutes(src: ExportSources) {
  const now = src.now ?? (() => new Date());
  const setup = exportGrantFromEnv(src.env ?? process.env);
  const log = (user: string, action: string, outcome: "ok" | "denied", detail: string) => src.audit?.({ at: now().toISOString(), user, action, outcome, detail });

  /** A stream's records, oldest first is the page's job: here, every record in range, shaped to leave. */
  async function recordsOf(stream: ExportStream, from: Date, to: Date, usernames: boolean): Promise<{ at: string; key?: string; row: Record<string, unknown> }[]> {
    const on = src.keeping().itemsOn;
    const o = { usernames, hash: src.hash };
    const tel = telemetryStream(stream);
    if (tel) {
      const lines = (await src.telemetry?.find({ from, to, type: tel.type })) ?? [];
      return lines.filter((l) => tel.keep(l, on)).map((l) => {
        const key = l.type === "turn" ? l.turnId : l.type === "transcript" ? l.transcriptId : undefined;
        return { at: l.at, key, row: exportLine(l, on, o) };
      });
    }
    if (stream === "audit") return (src.auditSince?.(from) ?? []).filter((e) => e.at < to.toISOString()).map((e) => ({ at: e.at, row: exportAuditLine(e, on, o) as Record<string, unknown> }));
    if (stream === "cost")
      return (src.auditSince?.(from) ?? []).filter((e) => e.at < to.toISOString()).flatMap((e) => {
        const r = turnRow(e);
        if (!r) return [];
        const row = withUser({ at: r.at, user: r.user, board: r.board ?? null, models: r.models, tokensIn: r.tokens.in, tokensOut: r.tokens.out, costUsd: r.costUsd, sttUsd: r.sttUsd, unpriced: r.unpriced }, o);
        return [{ at: r.at, row: row as Record<string, unknown> }];
      });
    if (stream === "recordings") {
      const fromIso = from.toISOString(), toIso = to.toISOString();
      return ((await src.recordings?.()) ?? []).filter((c) => c.at >= fromIso && c.at < toIso).map((c) => ({ at: c.at, key: c.id, row: withUser({ at: c.at, id: c.id, user: c.user, bytes: c.bytes, format: c.format }, o) as Record<string, unknown> }));
    }
    return [];
  }

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== EXPORT_PREFIX && !url.pathname.startsWith(`${EXPORT_PREFIX}/`)) return false;
    const send = (status: number, body: unknown) => (json(res, status, body, NO_STORE), true);
    if ("off" in setup) return send(404, { error: setup.off, code: "export-off" });
    const path = url.pathname.slice(EXPORT_PREFIX.length).replace(/^\/|\/$/g, "");
    const given = bearer(req);
    if (!given || !sameToken(given, setup.token)) {
      log("export:?", `export ${path || "index"}`, "denied", given ? "wrong token" : "no token");
      res.setHeader("www-authenticate", 'Bearer realm="lenspack export"');
      return send(401, { error: "an export token is needed: Authorization: Bearer <LENSPACK_EXPORT_TOKEN>", code: "no-token" });
    }
    const grant = setup.grant;
    const actor = exportActor(grant);
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "export routes are read-only: GET" });
    const keeping = src.keeping();
    const states = streamsKept(keeping);
    if (path === "") {
      log(actor, "export index", "ok", "");
      return send(200, { ...exportIndex(grant, states), limit: { default: DEFAULT_LIMIT, max: MAX_LIMIT }, formats: ["jsonl", "csv"] });
    }
    const d = exportDecision(grant, path, states);
    if (!d.ok) {
      log(actor, `export ${path}`, "denied", d.error);
      return send(d.status, { error: d.error, code: d.code, ...(d.code === "not-granted" ? { streams: grant.streams } : {}) });
    }

    // Parameters: from, to (exclusive), cursor, limit, format.
    const bad = (error: string) => (log(actor, `export ${d.stream}`, "denied", error), send(400, { error, code: "bad-parameter" }));
    const date = (k: string) => {
      const v = url.searchParams.get(k);
      if (!v) return undefined;
      const t = new Date(v);
      return Number.isNaN(t.getTime()) ? null : t;
    };
    const from = date("from"), to = date("to");
    if (from === null || to === null) return bad("from and to must be dates or times, like 2026-11-01 or 2026-11-01T06:00:00Z");
    const end = to ?? now();
    const start = from ?? new Date(0);
    if (start >= end) return bad("from must be before to");
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return bad(`limit is a whole number from 1 to ${MAX_LIMIT}`);
    const accept = String(req.headers.accept ?? "");
    const format = url.searchParams.get("format") ?? (/text\/csv/.test(accept) ? "csv" : "jsonl");
    if (format !== "jsonl" && format !== "csv") return bad("format is jsonl or csv");
    const cursorRaw = url.searchParams.get("cursor");
    const cursor = cursorRaw ? decodeCursor(cursorRaw) : undefined;
    if (cursor && "error" in cursor) return bad(cursor.error);

    const all = await recordsOf(d.stream, start, end, d.usernames);
    const page = exportPage(all, { from: start, to: end, cursor, limit }, (r) => r.key);

    const headers: Record<string, string> = {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "x-export-usernames": d.usernames ? "names" : "stand-ins",
      ...NO_STORE,
    };
    if (d.stream === "turns" || d.stream === "events" || d.stream === "feedback" || d.stream === "transcripts") headers["x-export-items"] = [...keeping.itemsOn].sort().join(",");
    if (page.next) {
      const next = encodeCursor(page.next);
      const q = new URLSearchParams(url.searchParams);
      q.set("cursor", next);
      headers["x-next-cursor"] = next;
      headers.link = `<${EXPORT_PREFIX}/${d.stream}?${q.toString()}>; rel="next"`;
    }
    // Written down before the first byte: an export cut off half way is still on record.
    log(actor, `export ${d.stream}`, "ok", `${start.toISOString()}..${end.toISOString()}, cursor ${cursorRaw ? "given" : "none"}, ${page.records.length} rows, ${format}, ${d.usernames ? "names" : "stand-ins"}`);
    res.writeHead(200, headers);
    if (req.method === "HEAD") return void res.end(), true;
    if (format === "csv") {
      const cols = EXPORT_COLUMNS[d.stream];
      await write(res, `${cols.join(",")}\n`);
      for (const r of page.records) await write(res, `${cols.map((c) => csvCell(r.row[c])).join(",")}\n`);
    } else {
      for (const r of page.records) await write(res, `${JSON.stringify(r.row)}\n`);
    }
    res.end();
    return true;
  };
}
