#!/usr/bin/env -S npx tsx
// Lenspack over Superset: the chat beside a Superset dashboard (in an iframe),
// or floating on Superset's own pages (one script tag in Superset's
// tail_js_custom_extra.html). Superset is not forked; it is the record for
// boards and the engine for numbers.
//
//   npx tsx --tsconfig tsconfig.base.json packages/superset/bin/serve.ts superset.yaml

import { mkdirSync, readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { memoryStore } from "@lenspack/core";
import { DEFAULT_SPEECH_MODEL, addUsageSink, buildProvider, createApp, effortFor, pickChatModel, probe, providersFromEnv, publicView, speechKeyFromEnv, speechModelAllowed, speechModels, usageLedger } from "@lenspack/serve";
import YAML from "yaml";

import { type Overlay, fetchDatasets, packFromDatasets, supersetBoards, supersetClient, supersetConnector } from "../src/index";
import { readJson, settingsStore, settingsToken } from "../src/settings";

type Config = {
  superset: {
    /** Where this server reaches Superset's API (in compose: http://superset:8088). */
    url: string;
    /** Where browsers reach Superset, when that differs from url (behind an ingress: https://superset.example.org). */
    publicUrl?: string;
    /** Superset's port as browsers see it, when publicUrl is not set (same host, another port). */
    publicPort?: number;
    username: string;
    passwordEnv?: string;
    password?: string;
  };
  /** Superset datasets by id, or by table name (schema.table or table). */
  datasets: (number | string)[];
  dashboards?: number[];
  overlay?: Overlay;
  host?: string;
  port?: number;
  /** The path browsers reach this server under, when a proxy mounts it below Superset's own host (/lenspack). */
  publicPath?: string;
  state?: string;
  budget?: { usdPerDay?: number; usdPerUserPerDay?: number };
  /** Speech to text for the mic. The model here is the default; the settings page can change it (state/settings.json). */
  speech?: { model?: string; baseUrl?: string; maxSeconds?: number; holdMs?: number };
  /** Language defaults; the settings page can change them (state/settings.json). */
  language?: { default?: string; titles?: "board" | "speaker"; board?: string };
};

const file = resolve(process.argv[2] ?? "superset.yaml");
const dir = dirname(file);
// Any string "env:NAME" in the config reads the environment variable NAME, so secrets and
// per-deployment URLs stay out of the file.
const fromEnv = (v: unknown): unknown => {
  if (typeof v === "string" && v.startsWith("env:")) {
    const value = process.env[v.slice(4)];
    if (value === undefined) throw new Error(`${file}: environment variable ${v.slice(4)} is not set`);
    return value;
  }
  if (Array.isArray(v)) return v.map(fromEnv);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromEnv(x)]));
  return v;
};
const config = fromEnv(YAML.parse(readFileSync(file, "utf8"))) as Config;
const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "web");
const log = (s: string) => console.error(`lenspack-superset: ${s}`);

const password = config.superset.password ?? process.env[config.superset.passwordEnv ?? "LENSPACK_SUPERSET_PASSWORD"];
if (!password) throw new Error("No Superset password: set superset.passwordEnv");
const client = supersetClient({ url: config.superset.url, username: config.superset.username, password });

// Superset can answer partially under load (a busy worker, a restart). Each dataset is retried inside
// fetchDatasets; the whole build is retried here too before giving up, so a transient answer doesn't
// turn into a crash loop.
async function loadPack() {
  const waits = [2000, 5000, 10_000];
  for (let i = 0; ; i++) {
    try {
      const datasets = await fetchDatasets(client, config.datasets, { log });
      return { datasets, ...packFromDatasets(datasets, config.overlay) };
    } catch (e) {
      if (i >= waits.length) throw e;
      log(`building the pack failed (${e instanceof Error ? e.message : String(e)}); trying again in ${waits[i]! / 1000} s`);
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}
const { datasets, pack, packYaml, binding } = await loadPack();
log(`pack ${pack.pack}: ${Object.keys(pack.entities).length} datasets, ${pack.dimensions.length} dimensions, ${pack.measures.length} measures`);
const connector = supersetConnector(client, binding);

const statePath = resolve(dir, config.state ?? "state/superset-boards.json");
mkdirSync(dirname(statePath), { recursive: true });
const dashboards: Record<string, number> = Object.fromEntries((config.dashboards ?? []).map((d) => [`superset-${d}`, d]));
const store = supersetBoards({ inner: memoryStore(), client, pack, binding, dashboards, stateFile: statePath, log });
await store.seed();

// Settings an admin changes on a running server (Superset's AI assistant page), kept beside the board state.
const settings = settingsStore(dirname(statePath));
const token = settingsToken();

type SpeechSettings = { model?: string; holdMs?: number };
const defaultSpeechModel = config.speech?.model ?? DEFAULT_SPEECH_MODEL;
const speechModel = () => settings.get<SpeechSettings>("speech")?.model ?? defaultSpeechModel;
// How long Space is held before the mic listens (a shorter press types a space); each user may pick their own.
const HOLD_MS = { min: 500, max: 3000 };
const defaultHoldMs = Math.min(HOLD_MS.max, Math.max(HOLD_MS.min, config.speech?.holdMs ?? 2000));
const holdMs = () => settings.get<SpeechSettings>("speech")?.holdMs ?? defaultHoldMs;
const speechKey = speechKeyFromEnv();
const speech = { ...speechKey, baseUrl: config.speech?.baseUrl, maxSeconds: config.speech?.maxSeconds ?? 60, model: speechModel };
const speechView = () => ({
  enabled: !!speechKey.apiKey,
  keyFrom: speechKey.keyFrom,
  provider: "openrouter",
  model: speechModel(),
  defaultModel: defaultSpeechModel,
  source: settings.get<SpeechSettings>("speech")?.model ? "settings" : "default",
  holdMs: holdMs(),
  defaultHoldMs,
  holdMsRange: HOLD_MS,
  writable: token.writable,
});

// Languages: the chat menu's choices and default (auto: no speech hint, reply in the language used),
// and whether new titles follow the board's language or the speaker's.
const LANGUAGES = ["auto", "en", "fr", "hi"] as const;
type LanguageSettings = { default?: string; titles?: "board" | "speaker"; board?: string };
const languageDefaults: Required<LanguageSettings> = { default: config.language?.default ?? "auto", titles: config.language?.titles ?? "board", board: config.language?.board ?? "en" };
const language = (): Required<LanguageSettings> => ({ ...languageDefaults, ...settings.get<LanguageSettings>("language") });
const languageView = () => ({ ...language(), options: LANGUAGES, defaults: languageDefaults, source: settings.get("language") ? "settings" : "default", writable: token.writable });

const ledger = usageLedger();
addUsageSink(ledger);
const providers = providersFromEnv().map(buildProvider);
void Promise.all(providers.map((p) => probe(p))).then((probed) => probed.forEach((p, i) => (providers[i] = p)));
const roles = process.env.LENSPACK_LLM_ROLES ? JSON.parse(process.env.LENSPACK_LLM_ROLES) : undefined;
type ChatSetting = { model?: string; effort?: string };
const api = createApp([{ name: pack.pack, pack, packYaml, connector, store, ctx: {}, boards: [] }], { providers, roles, ledger, budget: config.budget, log, chatDefault: () => settings.get<ChatSetting>("chat"), speech, language: () => ({ titles: language().titles, board: language().board }) });
/** The chat section of the settings page: what runs when the client asks for no model. */
function chatSettings() {
  const saved = settings.get<ChatSetting>("chat");
  const fallback = pickChatModel(providers, null);
  const current = pickChatModel(providers, null, saved);
  const effort = current ? effortFor(current, saved?.model === current.name && saved.effort && current.efforts?.levels.includes(saved.effort) ? saved.effort : null) : undefined;
  return {
    model: current?.name ?? null,
    effort: effort ?? null,
    defaultModel: fallback?.name ?? null,
    source: saved?.model && current?.name === saved.model ? "settings" : "default",
    writable: token.writable,
    options: providers.map(publicView),
  };
}

/** Binds a dashboard (by id or slug) to a board on first use, so the overlay works on any dashboard. */
async function bind(idOrSlug: string): Promise<{ board: string; dashboard: number; title: string; notes: string[] }> {
  const head = await client.get<{ result: { id: number; dashboard_title: string } }>(`/api/v1/dashboard/${encodeURIComponent(idOrSlug)}`);
  const id = head.result.id;
  const board = `superset-${id}`;
  if (dashboards[board] === undefined) {
    dashboards[board] = id;
    await store.pull(board, true);
    log(`bound dashboard ${id} (${head.result.dashboard_title})`);
  }
  return { board, dashboard: id, title: head.result.dashboard_title, notes: store.notes.get(board) ?? [] };
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };
const send = (res: ServerResponse, status: number, body: string, type = "application/json") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const base = (config.publicPath ?? "").replace(/\/+$/, "");
const page = (name: string, vars: Record<string, unknown>) =>
  readFileSync(join(web, name), "utf8")
    .replaceAll("__BASE__", base)
    .replace("/*__VARS__*/", `window.__lp=${JSON.stringify(vars).replace(/</g, "\\u003c")};`);

// The overlay runs on Superset's origin and calls this server: allow exactly
// that origin (publicUrl's, else the same host on Superset's port). Mounted
// under Superset's own host (publicPath), the calls are same-origin and need none of this.
function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const o = new URL(origin);
    const supersetPort = String(config.superset.publicPort ?? new URL(config.superset.url).port);
    const allowed = config.superset.publicUrl ? o.origin === new URL(config.superset.publicUrl).origin : o.port === supersetPort;
    if (allowed) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("vary", "origin");
    }
  } catch {
    /* not a URL */
  }
}

const port = Number(config.port ?? 8795);
const host = config.host ?? "127.0.0.1";
createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return send(res, 204, "");
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res);
    const supersetPort = config.superset.publicPort ?? Number(new URL(config.superset.url).port);
    const panel = config.overlay?.panel === "dock" ? "dock" : "float";
    const vars = { pack: pack.pack, panel, supersetPort, supersetUrl: config.superset.publicUrl?.replace(/\/+$/, "") ?? null, base, examples: (config.overlay?.examples ?? []).map((e: any) => e.question).filter(Boolean) };
    if (url.pathname === "/_superset/info") return send(res, 200, JSON.stringify({ pack: vars.pack, examples: vars.examples, panel, speech: speechKey.apiKey ? { enabled: true, maxSeconds: speech.maxSeconds, holdMs: holdMs() } : { enabled: false }, language: { default: language().default, options: LANGUAGES } }));
    if (url.pathname === "/_superset/settings/speech/models") return send(res, 200, JSON.stringify((await speechModels({ baseUrl: speech.baseUrl })).models));
    if (req.method === "PUT" && (url.pathname === "/_superset/settings/speech" || url.pathname === "/_superset/settings/language")) {
      const denied = token.check(req);
      if (denied) return send(res, 403, JSON.stringify({ error: denied }));
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, 400, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      if (url.pathname.endsWith("/speech")) {
        // Any of model, holdMs; a field left out is kept, and null or "" puts it back to the default.
        const next: SpeechSettings = { ...settings.get<SpeechSettings>("speech") };
        if ("model" in body) {
          const model = body.model;
          if (model === null || model === "") delete next.model;
          else if (typeof model !== "string" || !(await speechModelAllowed(model, { baseUrl: speech.baseUrl }))) return send(res, 400, JSON.stringify({ error: `not a transcription model: ${String(model)}` }));
          else next.model = model;
        }
        if ("holdMs" in body) {
          const v = body.holdMs;
          if (v === null || v === "") delete next.holdMs;
          else if (typeof v !== "number" || !Number.isInteger(v) || v < HOLD_MS.min || v > HOLD_MS.max) return send(res, 400, JSON.stringify({ error: `holdMs is a whole number of milliseconds from ${HOLD_MS.min} to ${HOLD_MS.max}` }));
          else next.holdMs = v;
        }
        settings.set("speech", Object.keys(next).length ? next : undefined);
        log(`speech: model ${speechModel()}, hold ${holdMs()} ms`);
        return send(res, 200, JSON.stringify(speechView()));
      }
      // Language: any of default, titles, board; null resets the field.
      const next: LanguageSettings = { ...settings.get<LanguageSettings>("language") };
      for (const [k, ok] of [["default", (v: unknown) => LANGUAGES.includes(v as never)], ["titles", (v: unknown) => v === "board" || v === "speaker"], ["board", (v: unknown) => LANGUAGES.includes(v as never) && v !== "auto"]] as const) {
        if (!(k in body)) continue;
        const v = body[k];
        if (v === null) delete next[k];
        else if (!ok(v)) return send(res, 400, JSON.stringify({ error: `bad ${k}: ${String(v)}` }));
        else (next as Record<string, unknown>)[k] = v;
      }
      settings.set("language", Object.keys(next).length ? next : undefined);
      log(`language: ${JSON.stringify(language())}`);
      return send(res, 200, JSON.stringify(languageView()));
    }
    // What a settings page (Superset's Settings → Manage → AI assistant) shows. No secrets: which
    // variable the LLM key came from, never the key.
    if (url.pathname === "/_superset/settings") {
      const llmFrom = process.env.LENSPACK_LLM_KEY_SOURCE || (process.env.LENSPACK_LLM_PROVIDERS ? "LENSPACK_LLM_PROVIDERS" : process.env.LENSPACK_LLM_API_KEY ? "LENSPACK_LLM_API_KEY" : process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null);
      return send(res, 200, JSON.stringify({
        pack: pack.pack,
        datasets: datasets.map((d) => ({ id: d.id, table: d.table_name, schema: d.schema ?? null, entity: binding.entityOf.get(d.id) ?? null })),
        dimensions: pack.dimensions.length,
        measures: pack.measures.map((m) => ({ key: m.key, label: m.label, agg: m.agg })),
        providers: providers.map(publicView),
        llmFrom,
        budget: config.budget ?? null,
        superset: { url: config.superset.url, username: config.superset.username },
        dashboards: Object.values(dashboards),
        publicPath: base,
        panel,
        chat: chatSettings(),
        speech: speechView(),
        language: languageView(),
      }));
    }
    if (url.pathname === "/_superset/settings/chat" && req.method === "PUT") {
      const denied = token.check(req);
      if (denied) return send(res, 403, JSON.stringify({ error: denied }));
      const body = await readJson(req);
      if (body.model === null) {
        settings.set("chat", undefined);
        log("settings: chat model reset to the default");
        return send(res, 200, JSON.stringify(chatSettings()));
      }
      const p = providers.find((x) => x.name === body.model);
      if (!p) return send(res, 400, JSON.stringify({ error: `unknown model "${String(body.model)}": one of ${providers.map((x) => x.name).join(", ")}` }));
      const effort = body.effort == null || body.effort === "" ? undefined : String(body.effort);
      if (effort && !p.efforts?.levels.includes(effort)) return send(res, 400, JSON.stringify({ error: p.efforts ? `effort "${effort}" is not one ${p.name} takes: ${p.efforts.levels.join(", ")}` : `${p.name} has no effort setting` }));
      settings.set("chat", { model: p.name, ...(effort ? { effort } : {}) });
      log(`settings: chat model ${p.name}${effort ? ` (${effort})` : ""}`);
      return send(res, 200, JSON.stringify(chatSettings()));
    }
    if (url.pathname === "/_superset/bind") return send(res, 200, JSON.stringify(await bind(url.searchParams.get("dashboard") ?? "")));
    if (url.pathname === "/_superset/dashboards") {
      const list = await client.get<{ result: { id: number; dashboard_title: string; changed_on_delta_humanized: string }[] }>("/api/v1/dashboard/?q=(page_size:100,order_column:changed_on_delta_humanized,order_direction:desc)");
      return send(res, 200, JSON.stringify(list.result.map((d) => ({ id: d.id, title: d.dashboard_title, changed: d.changed_on_delta_humanized }))));
    }
    const embed = /^\/superset\/(\d+)\/?$/.exec(url.pathname);
    if (embed) return send(res, 200, page("embed.html", { ...vars, dashboard: Number(embed[1]) }), TYPES[".html"]);
    if (url.pathname === "/") return send(res, 200, page("index.html", vars), TYPES[".html"]);
    const asset = /^\/(chat\.js|overlay\.js|chat\.css)$/.exec(url.pathname);
    if (asset) return send(res, 200, readFileSync(join(web, asset[1]!), "utf8"), TYPES[asset[1]!.slice(asset[1]!.lastIndexOf("."))]);
    return send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (e) {
    log(`${req.method} ${url.pathname}: ${e instanceof Error ? e.message : String(e)}`);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}).listen(port, host, () => log(`http://${host}:${port}/ (Superset ${config.superset.url}, ${Object.keys(dashboards).length} dashboard(s) bound, chat ${providers.length ? "on" : "off"})`));
