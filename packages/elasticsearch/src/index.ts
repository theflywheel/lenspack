import { type BoundPlan, type Capabilities, type Connector, type Plan, type SourceSchema, shapeRows } from "@lenspack/engine";
import type { Pack } from "@lenspack/spec";

import { type Env, type SearchRequest, toRequest } from "./request";

export { toRequest, type Env, type SearchRequest } from "./request";

// Elasticsearch and OpenSearch over plain HTTP: no client library, so one
// connector covers 6.x through 8.x and OpenSearch, which differ in client
// packages far more than in the search API this uses.

export type ElasticsearchOptions = {
  url: string;
  /** `Authorization: ApiKey …` (Elastic's base64 id:key form). */
  apiKey?: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
  defaultTimeoutMs?: number;
  fetch?: typeof fetch;
};

export const ELASTICSEARCH_CAPABILITIES: Capabilities = { joins: false, exactDistinct: false, exactPercentiles: false };

type Mapping = Map<string, string>;

// An index, a pattern or a comma-separated list: commas and wildcards are the
// search API's own syntax, so only the rest is escaped.
const indexPath = (index: string) => index.split(",").map((i) => encodeURIComponent(i).replace(/%2A/g, "*")).join(",");

/** Flattens an index mapping into field path → type, including multi-fields (`.keyword`). */
export function flattenMapping(mappings: Record<string, any>): Mapping {
  const out: Mapping = new Map();
  // 6.x nests properties under a document type; 7.x+ does not.
  const root = mappings.properties ? mappings : (Object.values(mappings).find((v: any) => v && typeof v === "object" && v.properties) ?? {});
  const walk = (props: Record<string, any>, prefix: string) => {
    for (const [name, def] of Object.entries(props ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (def.type) out.set(path, def.type);
      else if (def.properties) out.set(path, "object");
      if (def.properties) walk(def.properties, path);
      for (const [sub, subDef] of Object.entries((def.fields ?? {}) as Record<string, any>)) if (subDef.type) out.set(`${path}.${sub}`, subDef.type);
    }
  };
  walk((root as any).properties ?? {}, "");
  return out;
}

export function elasticsearchConnector(opts: ElasticsearchOptions): Connector & { request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<any> } {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.apiKey) headers.authorization = `ApiKey ${opts.apiKey}`;
  else if (opts.username) headers.authorization = `Basic ${Buffer.from(`${opts.username}:${opts.password ?? ""}`).toString("base64")}`;

  async function request(method: string, path: string, body?: unknown, timeoutMs = opts.defaultTimeoutMs ?? 15_000) {
    // A string body is sent as is: newline-delimited JSON for _bulk.
    const raw = typeof body === "string";
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: raw ? { ...headers, "content-type": "application/x-ndjson" } : headers,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const reason = json?.error?.root_cause?.[0]?.reason ?? json?.error?.reason ?? (typeof json?.error === "string" ? json.error : text.slice(0, 200));
      throw new Error(`search ${res.status}: ${reason}`);
    }
    return json;
  }

  let version: Promise<{ major: number; minor: number }> | null = null;
  const getVersion = () =>
    (version ??= request("GET", "/").then((r) => {
      // OpenSearch forked from 7.10 and keeps that search API.
      if (r?.version?.distribution === "opensearch") return { major: 7, minor: 10 };
      const [major, minor] = String(r?.version?.number ?? "7.10").split(".").map(Number);
      return { major: major ?? 7, minor: minor ?? 0 };
    }));
  const mappings = new Map<string, Promise<Mapping>>();
  const getMapping = (index: string) => {
    let m = mappings.get(index);
    if (!m) {
      m = request("GET", `/${indexPath(index)}/_mapping`).then((r) => {
        // An alias or a pattern answers with several indexes; their fields merge.
        const merged: Mapping = new Map();
        for (const idx of Object.values(r ?? {}) as any[]) for (const [k, v] of flattenMapping(idx.mappings ?? {})) if (!merged.has(k)) merged.set(k, v);
        return merged;
      });
      m.catch(() => mappings.delete(index));
      mappings.set(index, m);
    }
    return m;
  };

  return {
    kind: "elasticsearch",
    capabilities: ELASTICSEARCH_CAPABILITIES,
    request,
    async compile(bound: BoundPlan, pack: Pack): Promise<Plan> {
      const [v, mapping] = await Promise.all([getVersion(), getMapping(bound.rootEntity.source)]);
      const env: Env = { version: v, typeOf: (p) => mapping.get(p) };
      const req = toRequest(bound, pack, env);
      return { text: `POST /${req.index}/_search\n${JSON.stringify(req.body, null, 2)}`, native: req, bound, approximate: req.approximate };
    },
    async execute(plan, o) {
      const req = plan.native as SearchRequest;
      const timeoutMs = o?.timeoutMs ?? opts.defaultTimeoutMs ?? 15_000;
      const response = await request("POST", `/${indexPath(req.index)}/_search`, { ...req.body, timeout: `${Math.max(1, Math.floor(timeoutMs / 1000))}s` }, timeoutMs);
      const def = plan.bound.measure?.def;
      const data = shapeRows(req.decode(response), plan.bound.query, def?.format ?? "number", def?.key);
      return req.approximate ? { ...data, approximate: true } : data;
    },
    async introspect(): Promise<SourceSchema> {
      const indices = (await request("GET", "/_cat/indices?format=json&h=index,docs.count")) as { index: string; "docs.count": string }[];
      const visible = indices.filter((i) => !i.index.startsWith(".")).sort((a, b) => a.index.localeCompare(b.index));
      const collections = [];
      for (const i of visible) {
        const mapping = await getMapping(i.index);
        const fields = [...mapping.entries()].filter(([, t]) => t !== "object").map(([path, type]) => ({ path, type, aggregatable: type !== "text" }));
        collections.push({ name: i.index, rows: Number(i["docs.count"]), fields });
      }
      return { collections };
    },
  };
}
