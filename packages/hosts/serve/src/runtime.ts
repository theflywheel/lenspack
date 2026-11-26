import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

import type { Principal } from "@lenspack/policy";

import { type AppOptions, type Host, accessOf, createApp } from "./app";
import { NO_STORE, json } from "./http";
import { type Provider, type ProviderConfig, buildProvider, probe, providersFromEnv } from "./llm";
import { type Budget, type UsageLedger, addUsageSink, jsonlUsageSink, readUsageFile, usageLedger } from "./metering";
import { SettingsSaveError } from "./settings";

// The one server every host of lenspack runs (`lenspack serve`, `lenspack
// superset`): model providers, the usage ledger and budget, the board and chat
// API, /healthz, and a clean exit on SIGTERM. A request goes to the host's
// routes first, then /healthz, then the board API (sign-in routes, /api, UI).

/** A host's routes: they answer by responding, or leave the request to the rest. */
export type Route = (req: IncomingMessage, res: ServerResponse, url: URL, who: () => Promise<Principal | null>) => void | Promise<void>;
export type Runtime = { providers: Provider[]; budget?: Budget; ledger?: UsageLedger; roles?: { reviewer?: string; escalate?: string } };

/** LENSPACK_LLM_PROVIDERS (or LENSPACK_LLM_*); else, with ANTHROPIC_API_KEY, Claude Sonnet, Opus and Haiku 5.5. */
export function serverProviders(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const configured = providersFromEnv(env);
  if (configured.length || !env.ANTHROPIC_API_KEY) return configured;
  // For the settings page: where the key came from (the Anthropic adapter reads it itself).
  env.LENSPACK_LLM_KEY_SOURCE ||= "ANTHROPIC_API_KEY";
  return ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"].map((model) => ({ name: model, kind: "anthropic", model }));
}

/** LENSPACK_BUDGET_USD_PER_DAY and LENSPACK_BUDGET_USD_PER_USER_PER_DAY, for a config that sets no budget. */
export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): Budget | undefined {
  const day = Number(env.LENSPACK_BUDGET_USD_PER_DAY) || 0;
  const user = Number(env.LENSPACK_BUDGET_USD_PER_USER_PER_DAY) || 0;
  return day || user ? { ...(day ? { usdPerDay: day } : {}), ...(user ? { usdPerUserPerDay: user } : {}) } : undefined;
}

export function startRuntime(o: {
  hosts: Host[];
  /** The board API's options; the runtime adds providers, roles, ledger, budget and log. */
  app?: Omit<AppOptions, "providers" | "roles" | "ledger" | "budget" | "log">;
  port: number;
  host: string;
  log: (line: string) => void;
  onListening?: (rt: Runtime) => void;
  /** Closes sources and stores, on SIGTERM or SIGINT. */
  close?: () => Promise<void>;
  /** A JSON line per model call; today's totals are read back at start. */
  usageFile?: string;
  budget?: Budget;
  routes?: (rt: Runtime) => Route;
  /** Fields beside ok in GET /healthz. */
  health?: () => Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}) {
  const env = o.env ?? process.env;
  // As a container's PID 1, node ignores SIGTERM unless told otherwise.
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void (o.close?.() ?? Promise.resolve()).finally(() => process.exit(0)));
  // Every model call is metered into the ledger (GET /api/_usage, the budget); process-wide, so the probes count too.
  const ledger = usageLedger();
  addUsageSink(ledger);
  if (o.usageFile) {
    ledger.restore(readUsageFile(o.usageFile));
    addUsageSink(jsonlUsageSink(o.usageFile));
  }
  const budget = o.budget ?? budgetFromEnv(env);
  const providers = serverProviders(env).map(buildProvider);
  const unpriced = providers.filter((p) => !p.pricing).map((p) => p.name);
  if (budget && unpriced.length) o.log(`budget set, but ${unpriced.join(", ")} has no price, so its spend does not count toward it`);
  void Promise.all(providers.map((p) => probe(p))).then((probed) => probed.forEach((p, i) => (providers[i] = p)));
  const roles = env.LENSPACK_LLM_ROLES ? JSON.parse(env.LENSPACK_LLM_ROLES) : undefined;
  const api = createApp(o.hosts, { ...o.app, providers, roles, ledger, budget, log: o.log });
  const access = accessOf(o.app ?? {});
  const rt: Runtime = { providers, budget, ledger, roles };
  const routes = o.routes?.(rt);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      await routes?.(req, res, url, async () => (access ? access(req) : null));
      if (res.headersSent) return;
      if (url.pathname === "/healthz") return json(res, 200, { ok: true, ...o.health?.() }, NO_STORE);
      await api(req, res);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      o.log(`${req.method} ${url.pathname}: ${message}`);
      // A settings write the disk refused changed nothing, and saying so beats a bare 500.
      if (!res.headersSent) json(res, e instanceof SettingsSaveError ? 503 : 500, { error: message }, NO_STORE);
    }
  });
  server.listen(o.port, o.host, () => o.onListening?.(rt));
  return { server, ledger, ...rt };
}
