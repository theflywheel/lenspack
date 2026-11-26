import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { parsePackText } from "@lenspack/pack";
import { type Principal, adminRights, principalOf } from "@lenspack/policy";

import { type Host, createApp, seedBoards } from "../app";
import type { Audit, AuditEvent } from "../audit";
import { readBoards } from "../config";
import type { Provider } from "../llm";
import type { Budget, UsageLedger } from "../metering";
import { USAGE_HOST, usageSource } from "./usage-source";

// Usage as a Lenspack board. The admin panel's Overview is not a hand-drawn chart: it is a board, drawn
// by the same engine and renderer people use, over an ordinary pack (packs/usage/pack.yaml, with its
// default board in packs/usage/boards) bound to the usage source adapter (usage-source.ts), which reads
// this server's own record of its chat turns. Admins can change the board like any other, and ask the
// chat about it ("which board cost most this week?"). Those chat turns are marked internal: logged and
// costed like any other, but left out of the daily review, so the review never reviews itself.


/** packs/usage, found from the source tree (src/review) or the built package (dist). */
export function usagePackDir(): string {
  for (const rel of ["../../packs/usage/", "../packs/usage/"]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(`${p}pack.yaml`)) return p;
  }
  throw new Error("lenspack: the usage pack (packs/usage) is missing from this install");
}

export type UsageBoardOptions = {
  /** usage.duckdb goes here (the usage tables and the board's versions); telemetry*.jsonl is read from here when present. */
  stateDir: string;
  /** The usage pack's folder (pack.yaml and boards/); the one this package ships by default. */
  packDir?: string;
  /** The audit events at or after a time: the fallback when there is no telemetry. */
  events?: (from: Date) => AuditEvent[];
  providers: () => Provider[];
  ledger?: UsageLedger;
  budget?: Budget;
  roles?: { reviewer?: string; escalate?: string };
  /** The deployment's audit log: the usage chat's lines go there, marked internal. */
  audit?: Audit;
  review?: () => boolean;
  chatDefault?: () => { model?: string; effort?: string } | undefined;
  log?: (line: string) => void;
  /** How many days of turns the tables hold (default 90). */
  days?: number;
  /** Seconds between refreshes (default 30): the tables are read again when the board is opened after that. */
  refreshSeconds?: number;
  now?: () => Date;
};

export type UsageBoard = NonNullable<Awaited<ReturnType<typeof usageBoard>>>;

/** The usage pack bound to the usage source, its boards and the board API over them, or null when DuckDB is not installed. */
export async function usageBoard(o: UsageBoardOptions) {
  const source = await usageSource({ stateDir: o.stateDir, events: o.events, days: o.days, refreshSeconds: o.refreshSeconds, now: o.now, log: o.log });
  if (!source) return null;
  const dir = o.packDir ?? usagePackDir();
  const packYaml = readFileSync(`${dir}pack.yaml`, "utf8");
  const pack = parsePackText(packYaml);
  const host: Host = { name: USAGE_HOST, pack, packYaml, connector: source.connector, store: source.store, ctx: {}, boards: readBoards(`${dir}boards`) };
  await seedBoards(host);
  // Who asks is settled by the panel (an admin); the board API reads it off the request.
  const WHO = Symbol("lenspack-usage-who");
  // createApp keeps the list it is given; the deployment's providers are probed after start, so the
  // list is refreshed in place on every request.
  const providers: Provider[] = [...o.providers()];
  const app = createApp([host], {
    providers,
    roles: o.roles,
    ledger: o.ledger,
    budget: o.budget,
    review: o.review,
    chatDefault: o.chatDefault,
    log: o.log,
    access: (req) => (req as unknown as Record<symbol, Principal | undefined>)[WHO] ?? null,
    audit: o.audit ? (e) => o.audit!({ ...e, internal: true }) : undefined,
  });
  return {
    pack,
    host,
    refresh: source.refresh,
    /** Where the tables were last read from. */
    source: source.source,
    /**
     * Answers <panel>/api/usage/<rest>: the board API for the usage pack. The panel let `who` in (adminRights
     * panel); they change the usage board as its maintainer. Someone the policy does not let see who asked
     * (adminRights users) gets the pack with the user dimension and the questions hidden.
     */
    async handle(req: IncomingMessage, res: ServerResponse, rest: string, search: string, who: Principal) {
      providers.splice(0, providers.length, ...o.providers());
      const rights = adminRights(who);
      if (!rights.panel) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "only admins can read usage" }));
        return;
      }
      (req as unknown as Record<symbol, Principal>)[WHO] = principalOf({ user: who.user, tenant: who.tenant, edit: true, maintain: true, usage: true, ...(rights.users ? {} : { hidden: USAGE_PEOPLE_KEYS }) });
      req.url = `/api/${USAGE_HOST}${rest ? `/${rest}` : ""}${search}`;
      await app(req, res);
    },
    close: source.close,
  };
}

/** The usage pack's keys that say who asked or what: hidden from an admin the policy does not let see usernames. */
export const USAGE_PEOPLE_KEYS = ["user", "question", "session"];
