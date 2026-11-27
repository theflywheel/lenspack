// Starting while Superset is down or refusing: each start-up step is tried until it works, with waits that grow to a
// minute and stay there, and a mistake no wait fixes stops at once. The seed of the dashboards reads a dashboard again
// when Superset closes the connection mid-answer.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryStore } from "@lenspack/core";
import { describe, expect, it } from "vitest";

import { SupersetError, type SupersetClient, type SupersetDataset, fetchDatasets, packFromDatasets, serviceAccount, supersetBoards } from "../src/index";
import { STARTUP_WAITS_MS, StartupConfigError, startupCause, startupWaits, transient, untilItWorks } from "../src/startup";

/** What undici throws when Superset closes the socket mid-answer. */
const closed = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:8088"), { code: "ECONNREFUSED" }) });

describe("a start-up step while Superset is down", () => {
  it("keeps trying past the old limit, with waits capped at a minute, and says each cause and wait once", async () => {
    const slept: number[] = [];
    const lines: string[] = [];
    const errors = [refused(), new SupersetError(503, "Superset GET /api/v1/dataset/1 → 503: down"), new SupersetError(401, "Superset sign-in failed (401): check the service account"), closed()];
    let n = 0;
    // Twelve failures: the old start-up gave up after five tries (about 20 s), and the pod went into a crash loop.
    const got = await untilItWorks(
      "reading the datasets from Superset",
      async () => {
        if (n < 12) throw errors[n++ % errors.length];
        return "pack";
      },
      { log: (l) => lines.push(l), sleep: async (ms) => void slept.push(ms) },
    );
    expect(got).toBe("pack");
    expect(slept).toEqual([2000, 5000, 10_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
    expect(lines).toHaveLength(13);
    expect(lines[0]).toBe("reading the datasets from Superset failed: Superset is unreachable (connection refused); trying again in 2 s (try 1; the server stays up, not ready)");
    expect(lines[1]).toContain("Superset answered 503 (not up yet, or restarting); trying again in 5 s");
    expect(lines[2]).toContain("Superset refused the service sign-in (401)");
    expect(lines[3]).toContain("Superset closed the connection mid-answer; trying again in 30 s");
    expect(lines[12]).toBe("reading the datasets from Superset: worked on try 13");
  });

  it("tells /readyz why it is waiting", async () => {
    const said: string[] = [];
    let n = 0;
    await untilItWorks("signing in to Superset", async () => (n++ ? "ok" : Promise.reject(refused())), { log: () => {}, sleep: async () => {}, waiting: (w) => said.push(w) });
    expect(said).toEqual(["signing in to Superset failed: Superset is unreachable (connection refused); trying again in 2 s"]);
  });

  it("stops at once on a mistake no wait fixes", async () => {
    let tries = 0;
    const slept: number[] = [];
    await expect(
      untilItWorks(
        "reading the datasets from Superset",
        async () => {
          tries++;
          throw new StartupConfigError('Superset dataset "orders": not found');
        },
        { log: () => {}, sleep: async (ms) => void slept.push(ms) },
      ),
    ).rejects.toThrow('Superset dataset "orders": not found');
    expect(tries).toBe(1);
    expect(slept).toEqual([]);
  });

  it("names what passes by itself, and what doesn't", () => {
    expect(transient(closed())).toBe(true);
    expect(transient(refused())).toBe(true);
    expect(transient(new SupersetError(502, "bad gateway"))).toBe(true);
    expect(transient(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe(true);
    expect(transient(new SupersetError(404, "not here"))).toBe(false);
    expect(transient(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(startupCause(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))).toBe("Superset did not answer in time");
  });

  it("reads its waits from LENSPACK_STARTUP_RETRY_SECONDS, and refuses a wrong value as a config mistake", () => {
    expect(startupWaits({})).toEqual(STARTUP_WAITS_MS);
    expect(STARTUP_WAITS_MS).toEqual([2000, 5000, 10_000, 30_000, 60_000]);
    expect(startupWaits({ LENSPACK_STARTUP_RETRY_SECONDS: "1, 2.5,60" })).toEqual([1000, 2500, 60_000]);
    for (const bad of ["soon", "1,,2", "0", "-1", "5000"]) expect(() => startupWaits({ LENSPACK_STARTUP_RETRY_SECONDS: bad })).toThrow(StartupConfigError);
  });
});

describe("what stops the start at once", () => {
  const ds: SupersetDataset = { id: 1, table_name: "visits", schema: "public", columns: [{ column_name: "region", groupby: true, type: "TEXT" }], metrics: [{ metric_name: "visits", expression: "COUNT(*)" }] };
  const client = (get: (path: string) => unknown): SupersetClient => ({ url: "http://superset", get: async (p) => get(p) as any, post: async () => ({}) as any, put: async () => ({}) as any, delete: async () => ({}) as any });
  const fast = { sleep: async () => {} };

  it("a dataset name Superset says doesn't exist, or that names two", async () => {
    const none = client(() => ({ result: [] }));
    await expect(fetchDatasets(none, ["orders"], fast)).rejects.toBeInstanceOf(StartupConfigError);
    const two = client(() => ({ result: [{ id: 1, table_name: "orders", schema: "a" }, { id: 2, table_name: "orders", schema: "b" }] }));
    await expect(fetchDatasets(two, ["orders"], fast)).rejects.toThrow(/more than one matches; name the schema/);
    await expect(fetchDatasets(two, ["orders"], fast)).rejects.toBeInstanceOf(StartupConfigError);
    const gone = client(() => {
      throw new SupersetError(404, "Superset GET /api/v1/dataset/9 → 404: Not found");
    });
    await expect(fetchDatasets(gone, [9], fast)).rejects.toBeInstanceOf(StartupConfigError);
  });

  it("no way to make Lenspack's Superset account", async () => {
    await expect(serviceAccount({ url: "http://superset", username: "lenspack", stateDir: mkdtempSync(join(tmpdir(), "lp-startup-")) })).rejects.toBeInstanceOf(StartupConfigError);
  });

  it("not a request that failed: with retryErrors off, that goes to the start-up's own tries at once", async () => {
    let calls = 0;
    const down = client(() => {
      calls++;
      throw new SupersetError(503, "Superset GET /api/v1/dataset/1 → 503: down");
    });
    const e = await fetchDatasets(down, [1], { ...fast, retryErrors: false }).catch((x) => x);
    expect(e).toBeInstanceOf(SupersetError);
    expect(e).not.toBeInstanceOf(StartupConfigError);
    expect(calls).toBe(1);
    // A dataset that comes back fine still does.
    expect(await fetchDatasets(client(() => ({ result: ds })), [1], { ...fast, retryErrors: false })).toEqual([ds]);
  });
});

describe("seeding the dashboards", () => {
  const ds: SupersetDataset = { id: 1, table_name: "visits", schema: "public", columns: [{ column_name: "region", groupby: true, type: "TEXT" }], metrics: [{ metric_name: "visits", expression: "COUNT(*)" }] };
  const { pack, binding } = packFromDatasets([ds], { pack: "p" });
  const dashboard = { result: { id: 7, dashboard_title: "Ops", position_json: null, json_metadata: null, changed_on: "2026-01-01T00:00:00" } };
  const superset = (fail: (path: string, n: number) => unknown): SupersetClient & { calls: string[] } => {
    const calls: string[] = [];
    return {
      url: "http://superset",
      calls,
      get: async (path: string) => {
        calls.push(path);
        const e = fail(path, calls.filter((c) => c === path).length);
        if (e) throw e;
        return (path.endsWith("/charts") ? { result: [] } : dashboard) as any;
      },
      post: async () => ({}) as any,
      put: async () => ({}) as any,
      delete: async () => ({}) as any,
    };
  };
  const boards = (client: SupersetClient, lines: string[] = []) =>
    supersetBoards({ inner: memoryStore(), client, pack, binding, dashboards: { "superset-7": 7 }, stateFile: join(mkdtempSync(join(tmpdir(), "lp-seed-")), "boards.json"), sleep: async () => {}, log: (l) => lines.push(l) });

  it("reads a dashboard again when Superset closes the connection mid-answer", async () => {
    const lines: string[] = [];
    const client = superset((path, n) => (path === "/api/v1/dashboard/7" && n <= 2 ? closed() : null));
    const store = boards(client, lines);
    await store.seed();
    expect((await store.get("superset-7"))?.config.title).toBe("Ops");
    expect(lines.filter((l) => l.includes("reading it again"))).toEqual([
      "superset-7: reading dashboard 7 failed (Superset closed the connection mid-answer); reading it again in 0.5 s",
      "superset-7: reading dashboard 7 failed (Superset closed the connection mid-answer); reading it again in 1 s",
    ]);
  });

  it("fails after a few tries for the start-up to try again later, and stops the start on a dashboard Superset doesn't have", async () => {
    await expect(boards(superset(() => closed())).seed()).rejects.toThrow("fetch failed");
    const missing = await boards(superset(() => new SupersetError(404, "Superset GET /api/v1/dashboard/7 → 404: Not found"))).seed().catch((e) => e);
    expect(missing).toBeInstanceOf(StartupConfigError);
    expect(missing.message).toContain("dashboard 7 (in dashboards:) does not exist in Superset");
  });
});
