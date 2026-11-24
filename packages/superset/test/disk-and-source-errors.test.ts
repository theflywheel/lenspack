import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SupersetError } from "../src/client";
import { features } from "@lenspack/serve";
import { SettingsSaveError, diskProblem, settingsStore } from "@lenspack/serve";
import { scrubAddresses, sourceError } from "../src/source-errors";
import { savedStates } from "../src/store";

const fresh = () => mkdtempSync(join(tmpdir(), "lp-disk-"));

describe("when the disk refuses a write", () => {
  it("settings: nothing changes, in memory or on disk, and the error says why", () => {
    const dir = join(fresh(), "state");
    const s = settingsStore(dir);
    s.set("speech", { holdMs: 1500 });
    // The state directory goes away under the server (a lost mount): every write now fails.
    rmSync(dir, { recursive: true });
    expect(() => s.set("speech", { holdMs: 900 })).toThrow(SettingsSaveError);
    expect(() => s.set("speech", undefined)).toThrow(/can't save settings: .*Nothing was changed/);
    expect(s.get("speech")).toEqual({ holdMs: 1500 });
    // An off switch saved through the same store fails the same way, and stays as it was.
    const f = features({ settings: s });
    expect(() => f.update({ voice: false })).toThrow(SettingsSaveError);
    expect(f.on("voice")).toBe(true);
  });

  it("names the usual reasons in words", () => {
    expect(diskProblem({ code: "ENOSPC" })).toBe("the disk is full");
    expect(diskProblem({ code: "EROFS" })).toBe("the disk is read-only");
    expect(diskProblem({ code: "EACCES" })).toMatch(/no permission/);
    expect(new SettingsSaveError({ code: "ENOSPC" }).message).toBe("Lenspack can't save settings: the disk is full. Nothing was changed.");
  });

  it("board links: a failed save doesn't throw, is logged once, and the next good save catches up", () => {
    const dir = join(fresh(), "state");
    mkdirSync(dir);
    const file = join(dir, "boards.json");
    const lines: string[] = [];
    const { states, save } = savedStates(file, (l) => lines.push(l));
    states["superset-1"] = { dashboardId: 1, charts: {}, created: [], locked: [], markdown: {} } as never;
    expect(save()).toBe(true);
    rmSync(dir, { recursive: true });
    states["superset-2"] = { dashboardId: 2, charts: {}, created: [], locked: [], markdown: {} } as never;
    expect(save()).toBe(false);
    expect(save()).toBe(false);
    expect(lines.filter((l) => l.startsWith("could not save"))).toHaveLength(1);
    mkdirSync(dir);
    expect(save()).toBe(true);
    expect(lines.at(-1)).toMatch(/saved .* again/);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["superset-1", "superset-2"]);
    expect(readdirSync(dir)).toEqual(["boards.json"]);
  });

  it("board links: a half-written file is set aside and the server starts anyway", () => {
    const dir = fresh();
    const file = join(dir, "boards.json");
    writeFileSync(file, '{"superset-1": {"dashboardId": 1, "char');
    const lines: string[] = [];
    const { states } = savedStates(file, (l) => lines.push(l));
    expect(states).toEqual({});
    expect(lines[0]).toMatch(/could not read .*set aside/);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith("boards.json.unreadable-"))).toBe(true);
  });
});

describe("what the model hears when a query fails", () => {
  const driver = (inner: string) => new SupersetError(400, `Superset POST /api/v1/chart/data → 400: ${inner}`);

  it("an unreachable data source: a reason, no hosts or ports; the raw error goes to the log", () => {
    const logged: string[] = [];
    const e = sourceError(
      driver("Error: HTTPConnectionPool(host='db-proxy', port=8123): Max retries exceeded with url: /?query_id=1 (Caused by NewConnectionError('Failed to establish a new connection: [Errno 111] Connection refused'))"),
      (l) => logged.push(l),
    );
    expect(e.message).toBe("The data source is unreachable (connection refused). The data could not be read; try again shortly.");
    expect(e.message).not.toMatch(/db-proxy|8123/);
    expect(logged[0]).toMatch(/db-proxy/);
    expect(sourceError(driver("[Errno -2] Name or service not known")).message).toMatch(/unreachable \(host not found\)/);
    expect(sourceError(driver("Code: 516. DB::Exception: default: Authentication failed")).message).toMatch(/unreachable \(sign-in refused\)/);
  });

  it("Superset itself out of reach or failing", () => {
    const fetchFailed = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(sourceError(fetchFailed).message).toMatch(/unreachable \(Superset is unreachable: connection refused\)/);
    expect(sourceError(new SupersetError(502, "Superset POST /api/v1/chart/data → 502: Bad Gateway")).message).toMatch(/unreachable \(Superset is unavailable\)/);
  });

  it("a slow query is not called unreachable", () => {
    expect(sourceError(driver("Code: 159. DB::Exception: Timeout exceeded: elapsed 30.1 seconds")).message).toMatch(/did not answer in time/);
  });

  it("any other failure keeps its words, minus addresses; a clean one is handed on as it is", () => {
    const logged: string[] = [];
    const e = sourceError(driver("Unknown column 'wardz' (from http://10.1.2.3:8123/q at db.internal:9000)"), (l) => logged.push(l));
    expect(e.message).toBe("Superset POST /api/v1/chart/data → 400: Unknown column 'wardz' (from [address] at [address])");
    expect(logged).toHaveLength(1);
    const plain: string[] = [];
    expect(sourceError(driver("Unknown column 'wardz'"), (l) => plain.push(l)).message).toMatch(/Unknown column 'wardz'$/);
    expect(plain).toHaveLength(0);
    expect(scrubAddresses("ran at 10:05, host=db-proxy port=8123")).toBe("ran at 10:05, host=[address] port=[port]");
  });
});
