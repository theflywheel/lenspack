// Where browsers reach this server and Superset, for one request. Superset can run below a path of its host
// (SUPERSET_APP_ROOT=/superset), and its /lenspack route is then /superset/lenspack. The plugin says both on every
// request it forwards: X-Forwarded-Prefix (this server's address, /superset/lenspack) and X-Lenspack-Superset-Root
// (Superset's own, /superset; "" at the root). Every address on a page or in an answer is built from these, so the
// same server works at the root and under a path without a setting. Older plugins send X-Forwarded-Prefix only, as
// /lenspack, which is what they served at.
import type { IncomingMessage } from "node:http";

// A plain path, segment by segment: nothing that could leave an attribute, a script or a URL's path.
const SAFE = /^(?:\/[A-Za-z0-9._~-]+)*$/;

/** A path from a header or the config, without its trailing slash ("" for the root); null when it isn't a plain path. */
export function plainPath(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const p = v.split(",")[0]!.trim().replace(/\/+$/, "");
  if (!SAFE.test(p) || p.split("/").some((s) => s === "." || s === "..")) return null;
  return p;
}

export type RequestPaths = {
  /** Where browsers reach this server: "/superset/lenspack", "/lenspack", or "" when they reach its port directly. */
  base: string;
  /** Where Superset runs on its host: "/superset", or "" at the root. */
  root: string;
};

/** This request's paths: the plugin's headers when they are plain paths, else the configured base and the root. */
export function requestPaths(req: IncomingMessage, configured: string): RequestPaths {
  return {
    base: plainPath(req.headers["x-forwarded-prefix"]) ?? configured,
    root: plainPath(req.headers["x-lenspack-superset-root"]) ?? "",
  };
}
