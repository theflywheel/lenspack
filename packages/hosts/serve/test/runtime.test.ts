// The one server runtime both hosts run: which models it offers from the environment, the budget it reads
// there, and the order a request takes (the host's routes, /healthz, then the board API).
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { budgetFromEnv, json, serverProviders, startRuntime } from "../src";

describe("the models a server offers", () => {
  it("defaults to Claude Sonnet, Opus and Haiku 5.5 with only ANTHROPIC_API_KEY, and says where the key came from", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "k" };
    expect(serverProviders(env)).toEqual([
      { name: "claude-sonnet-5-5", kind: "anthropic", model: "claude-sonnet-5-5" },
      { name: "claude-opus-5-5", kind: "anthropic", model: "claude-opus-5-5" },
      { name: "claude-haiku-5-5", kind: "anthropic", model: "claude-haiku-5-5" },
    ]);
    expect(env.LENSPACK_LLM_KEY_SOURCE).toBe("ANTHROPIC_API_KEY");
  });

  it("takes LENSPACK_LLM_PROVIDERS over ANTHROPIC_API_KEY, and offers nothing with neither", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "k", LENSPACK_LLM_PROVIDERS: JSON.stringify([{ name: "mine", kind: "anthropic", model: "m" }]) };
    expect(serverProviders(env).map((p) => p.name)).toEqual(["mine"]);
    expect(env.LENSPACK_LLM_KEY_SOURCE).toBeUndefined();
    expect(serverProviders({})).toEqual([]);
  });

  it("reads a budget from the environment", () => {
    expect(budgetFromEnv({})).toBeUndefined();
    expect(budgetFromEnv({ LENSPACK_BUDGET_USD_PER_DAY: "5" })).toEqual({ usdPerDay: 5 });
    expect(budgetFromEnv({ LENSPACK_BUDGET_USD_PER_USER_PER_DAY: "0.5" })).toEqual({ usdPerUserPerDay: 0.5 });
  });
});

describe("a request's way through the runtime", () => {
  it("tries the host's routes, then /healthz, then the board API", async () => {
    const { server } = startRuntime({
      hosts: [],
      port: 0,
      host: "127.0.0.1",
      log: () => {},
      env: {},
      health: () => ({ extra: 1 }),
      routes: () => (_req, res, url) => {
        if (url.pathname === "/mine") json(res, 200, { mine: true });
        if (url.pathname === "/boom") throw new Error("no");
      },
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (p: string) => {
      const r = await fetch(base + p);
      return { status: r.status, body: await r.json() };
    };
    expect(await get("/mine")).toEqual({ status: 200, body: { mine: true } });
    expect(await get("/healthz")).toEqual({ status: 200, body: { ok: true, extra: 1 } });
    // Without a readiness rule, ready as soon as it listens.
    expect(await get("/readyz")).toEqual({ status: 200, body: { ready: true } });
    expect((await get("/api")).body).toMatchObject({ examples: [] });
    expect(await get("/boom")).toEqual({ status: 500, body: { error: "no" } });
    server.close();
  });

  it("answers /readyz 503 while the host says it isn't ready, and keeps /healthz 200 for liveness", async () => {
    let ready = false;
    const { server } = startRuntime({ hosts: [], port: 0, host: "127.0.0.1", log: () => {}, env: {}, ready: () => (ready ? { ready: true } : { ready: false, reason: "no key yet" }) });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (p: string) => {
      const r = await fetch(base + p);
      return { status: r.status, body: await r.json() };
    };
    expect(await get("/readyz")).toEqual({ status: 503, body: { ready: false, reason: "no key yet" } });
    expect(await get("/healthz")).toEqual({ status: 200, body: { ok: true, ready: false } });
    ready = true;
    expect(await get("/readyz")).toEqual({ status: 200, body: { ready: true } });
    expect(await get("/healthz")).toEqual({ status: 200, body: { ok: true, ready: true } });
    server.close();
  });
});
