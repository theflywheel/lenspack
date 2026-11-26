// Where browsers reach Lenspack and Superset, per request: Superset at its host's root, or below a path
// (SUPERSET_APP_ROOT=/superset), as the plugin says in the headers it forwards.
import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { plainPath, requestPaths } from "../src/paths";

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

describe("request paths", () => {
  it("reads plain paths, without a trailing slash", () => {
    expect(plainPath("")).toBe("");
    expect(plainPath("/")).toBe("");
    expect(plainPath("/lenspack")).toBe("/lenspack");
    expect(plainPath("/superset/lenspack/")).toBe("/superset/lenspack");
    expect(plainPath("/a-b/c_d/e.f~g")).toBe("/a-b/c_d/e.f~g");
    // A proxy that adds its own value after the plugin's: the first one counts.
    expect(plainPath("/superset/lenspack, /other")).toBe("/superset/lenspack");
  });

  it("refuses anything that could leave a path, an attribute or a script", () => {
    for (const v of ['/x"><script>', "/x y", "lenspack", "//evil.example", "/a/../b", "/a/./b", "/%2e%2e", "/a\\b", "https://evil.example/x", "/a?b", "/a#b", "/é"]) expect(plainPath(v), v).toBeNull();
    expect(plainPath(undefined)).toBeNull();
    expect(plainPath(["/a"])).toBeNull();
  });

  it("takes this server's address and Superset's root from the plugin, and the configured base otherwise", () => {
    expect(requestPaths(req({ "x-forwarded-prefix": "/superset/lenspack", "x-lenspack-superset-root": "/superset" }), "/lenspack")).toEqual({ base: "/superset/lenspack", root: "/superset" });
    // At the root, as every plugin before Superset-root support sent it.
    expect(requestPaths(req({ "x-forwarded-prefix": "/lenspack" }), "")).toEqual({ base: "/lenspack", root: "" });
    expect(requestPaths(req({ "x-forwarded-prefix": "/lenspack", "x-lenspack-superset-root": "" }), "")).toEqual({ base: "/lenspack", root: "" });
    // Reached on its own port, or with headers that aren't plain paths.
    expect(requestPaths(req({}), "/lenspack")).toEqual({ base: "/lenspack", root: "" });
    expect(requestPaths(req({ "x-forwarded-prefix": '/x"><script>', "x-lenspack-superset-root": "/a/../b" }), "/lenspack")).toEqual({ base: "/lenspack", root: "" });
  });
});
