import type { IncomingMessage, ServerResponse } from "node:http";

import { type AppOptions, pickChatModel, pickEffort } from "./app";
import { type AuditLog, turnsReport } from "./audit";
import type { Principal } from "./auth";
import { type ExplainConfig, explainFrom } from "./config";
import { type FeatureValues, features as featureSwitches } from "./features";
import { NO_STORE, json, readJson } from "./http";
import { type Provider, effortFor, publicView } from "./llm";
import type { Budget } from "./metering";
import { type ReviewMountOptions, reviewMount } from "./review/mount";
import { settingsStore } from "./settings";
import { DEFAULT_SPEECH_MODEL, type SpeechOptions, speechKeyFromEnv, speechModelAllowed, speechModels } from "./speech";

// What an admin changes on a running server, from a host's settings page:
// the chat's default model, speech, languages and the off switches, kept in
// settings.json in the state directory; and the routes that page calls, under
// a prefix the host picks (/_superset), for its admins only. No secrets: which
// variable a key came from, never the key.

/** The chat menu's choices (auto: no speech hint, reply in the language used). */
export const LANGUAGES = ["auto", "en", "fr", "hi", "pt"] as const;
/** How long Space is held before the mic listens (a shorter press types a space). */
const HOLD_MS = { min: 500, max: 3000 };

type SpeechSettings = { model?: string; holdMs?: number };
type LanguageSettings = { default?: string; titles?: "board" | "speaker"; board?: string };
type ChatSetting = { model?: string; effort?: string };

/** A deployment's defaults for what the settings page can change. */
export type AdminConfig = {
  /** Speech to text for the mic. The model here is the default. */
  speech?: { model?: string; baseUrl?: string; maxSeconds?: number; holdMs?: number };
  /** Language defaults: the chat's, and whether new titles follow the board's language or the speaker's. */
  language?: LanguageSettings;
  /** Off switches, all on by default (see features.ts); LENSPACK_FEATURES and the settings page override them. */
  features?: FeatureValues;
  /** "How this was worked out" under each answer: false turns it off; `sql: false` keeps the words and rows but not the SQL. */
  explain?: ExplainConfig;
};

/** Where the LLM key came from, for the settings page. */
export const llmKeySource = (env: NodeJS.ProcessEnv = process.env) =>
  env.LENSPACK_LLM_KEY_SOURCE || (env.LENSPACK_LLM_PROVIDERS ? "LENSPACK_LLM_PROVIDERS" : env.LENSPACK_LLM_API_KEY ? "LENSPACK_LLM_API_KEY" : env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null);

export function adminSettings(stateDir: string, config: AdminConfig = {}, env: NodeJS.ProcessEnv = process.env) {
  const settings = settingsStore(stateDir);
  const features = featureSwitches({ config: config.features, env: env.LENSPACK_FEATURES, settings });
  const saved = <T>(section: string) => settings.get<T>(section);
  const defaultSpeechModel = config.speech?.model ?? DEFAULT_SPEECH_MODEL;
  const defaultHoldMs = Math.min(HOLD_MS.max, Math.max(HOLD_MS.min, config.speech?.holdMs ?? 2000));
  const speechModel = () => saved<SpeechSettings>("speech")?.model ?? defaultSpeechModel;
  const holdMs = () => saved<SpeechSettings>("speech")?.holdMs ?? defaultHoldMs;
  const speechKey = speechKeyFromEnv(env);
  // With voice switched off the key is withheld, so the mic is hidden and /api/_stt answers 503.
  const speech: SpeechOptions = {
    ...speechKey,
    get apiKey() {
      return features.on("voice") ? speechKey.apiKey : undefined;
    },
    baseUrl: config.speech?.baseUrl,
    maxSeconds: config.speech?.maxSeconds ?? 60,
    model: speechModel,
  };
  const languageDefaults: Required<LanguageSettings> = { default: config.language?.default ?? "auto", titles: config.language?.titles ?? "board", board: config.language?.board ?? "en" };
  const language = (): Required<LanguageSettings> => ({ ...languageDefaults, ...saved<LanguageSettings>("language") });
  const off = () => Object.entries(features.values()).filter(([, on]) => !on).map(([f]) => f);
  return {
    settings,
    features,
    speech,
    holdMs,
    language,
    /** The board API's per-turn reads of these settings. */
    app: {
      review: () => features.on("reviewer"),
      speech,
      language: () => ({ titles: language().titles, board: language().board }),
      chatDefault: () => saved<ChatSetting>("chat"),
      // The explain switch (settings page, env, config) and the config's explain.sql.
      explain: () => ({ ...explainFrom(config.explain), ...(features.on("explain") ? {} : { on: false }) }),
    } satisfies Partial<AppOptions>,
    /** The review system and admin panel over these settings (review/mount.ts), so a host wires it with no more imports. */
    review(o: ReviewMountOptions) {
      return reviewMount({ features, settings, app: { review: () => features.on("reviewer"), chatDefault: () => saved<ChatSetting>("chat") } }, o);
    },
    featuresLine: () => `features: ${off().length ? `off: ${off().join(", ")}` : "all on"}`,
    speechView: (writable: boolean) => ({
      enabled: !!speechKey.apiKey,
      keyFrom: speechKey.keyFrom,
      provider: "openrouter",
      model: speechModel(),
      defaultModel: defaultSpeechModel,
      source: saved<SpeechSettings>("speech")?.model ? "settings" : "default",
      holdMs: holdMs(),
      defaultHoldMs,
      holdMsRange: HOLD_MS,
      writable,
    }),
    languageView: (writable: boolean) => ({ ...language(), options: LANGUAGES, defaults: languageDefaults, source: saved("language") ? "settings" : "default", writable }),
  };
}
export type AdminSettings = ReturnType<typeof adminSettings>;

export type AdminRouteOptions = {
  /** Where the routes live: <prefix>/info, <prefix>/settings, … */
  prefix: string;
  settings: AdminSettings;
  providers: Provider[];
  budget?: Budget;
  audit: AuditLog | null;
  log: (line: string) => void;
  /** Who may change settings, in the host's words ("Superset admin"): a caller with the role admin. */
  adminName: string;
  /** Whether settings can be changed now, for the page. */
  writable: () => boolean;
  /** The host's own fields in <prefix>/info (any signed-in user) and <prefix>/settings (admins). */
  info?: (url: URL) => Record<string, unknown>;
  details?: () => Record<string, unknown>;
};

/** The settings page's routes, answering by responding. A caller who is not signed in never reaches them: the host answers 401 first. */
export function adminRoutes(o: AdminRouteOptions) {
  const s = o.settings;
  /** The chat section: what runs when the client asks for no model. */
  const chatSettings = () => {
    const saved = s.settings.get<ChatSetting>("chat");
    const current = pickChatModel(o.providers, null, saved);
    return {
      model: current?.name ?? null,
      effort: (current && effortFor(current, pickEffort(current, null, saved))) ?? null,
      defaultModel: pickChatModel(o.providers, null)?.name ?? null,
      source: saved?.model && current?.name === saved.model ? "settings" : "default",
      writable: o.writable(),
      options: o.providers.map(publicView),
    };
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL, who: Principal): Promise<void> => {
    if (!url.pathname.startsWith(`${o.prefix}/`)) return;
    const path = url.pathname.slice(o.prefix.length);
    const send = (status: number, body: unknown) => json(res, status, body, NO_STORE);
    const audit = (action: string, detail?: string, outcome: "ok" | "denied" = "ok") => o.audit?.audit({ at: new Date().toISOString(), user: who.user, action, outcome, ...(detail !== undefined ? { detail } : {}) });
    const writable = o.writable();

    if (path === "/info") {
      const speech = s.speech.apiKey ? { enabled: true, maxSeconds: s.speech.maxSeconds, holdMs: s.holdMs() } : { enabled: false };
      return send(200, { ...o.info?.(url), speech, language: { default: s.language().default, options: LANGUAGES }, features: s.features.values() });
    }
    if (path === "/settings/speech/models") return send(200, (await speechModels({ baseUrl: s.speech.baseUrl })).models);
    const put = req.method === "PUT";
    if (!["/settings", "/turns", "/audit"].includes(path) && !(put && ["/settings/features", "/settings/speech", "/settings/language", "/settings/chat"].includes(path))) return;
    if (!who.roles?.includes("admin")) {
      audit(`${req.method} ${url.pathname}`, `not a ${o.adminName}`, "denied");
      return send(403, { error: `only ${o.adminName}s can do this` });
    }

    if (path === "/settings")
      return send(200, {
        ...o.details?.(),
        providers: o.providers.map(publicView),
        llmFrom: llmKeySource(),
        budget: o.budget ?? null,
        audit: o.audit ? { file: o.audit.file, retentionDays: o.audit.retentionDays, months: o.audit.months() } : null,
        chat: chatSettings(),
        speech: s.speechView(writable),
        language: s.languageView(writable),
        features: s.features.view(writable),
      });
    // What chat has cost: the newest turns and the totals for today and the last 7 days, from the audit log.
    if (path === "/turns") {
      if (!o.audit) return send(200, { enabled: false });
      const now = new Date();
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 500));
      return send(200, { enabled: true, ...turnsReport(o.audit.since(new Date(now.getTime() - 7 * 86_400_000)), now, limit) });
    }
    // The audit log, newest first: ?month=YYYY-MM (default the current month), ?limit=N.
    if (path === "/audit") {
      if (!o.audit) return send(200, { enabled: false, events: [] });
      try {
        const events = o.audit.read({ month: url.searchParams.get("month") ?? undefined, limit: Number(url.searchParams.get("limit")) || 200 });
        return send(200, { enabled: true, retentionDays: o.audit.retentionDays, months: o.audit.months(), events });
      } catch (e) {
        return send(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Every change is a small JSON object.
    let b: Record<string, unknown>;
    try {
      b = (await readJson(req, 10_000)) as Record<string, unknown>;
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("body must be a JSON object");
    } catch (e) {
      return send(400, { error: e instanceof Error ? e.message : String(e) });
    }
    // Off switches: any of {feature: true|false|null}; null puts a switch back to the deployment's value.
    if (path === "/settings/features") {
      const r = s.features.update(b);
      if (!r.ok) return send(400, { error: r.error });
      o.log(s.featuresLine());
      audit("settings features", JSON.stringify(r.changed));
      return send(200, s.features.view(writable));
    }
    // Any of model, holdMs; a field left out is kept, and null or "" puts it back to the default.
    if (path === "/settings/speech") {
      const next: SpeechSettings = { ...s.settings.get<SpeechSettings>("speech") };
      if ("model" in b) {
        const model = b.model;
        if (model === null || model === "") delete next.model;
        else if (typeof model !== "string" || !(await speechModelAllowed(model, { baseUrl: s.speech.baseUrl }))) return send(400, { error: `not a transcription model: ${String(model)}` });
        else next.model = model;
      }
      if ("holdMs" in b) {
        const v = b.holdMs;
        if (v === null || v === "") delete next.holdMs;
        else if (typeof v !== "number" || !Number.isInteger(v) || v < HOLD_MS.min || v > HOLD_MS.max) return send(400, { error: `holdMs is a whole number of milliseconds from ${HOLD_MS.min} to ${HOLD_MS.max}` });
        else next.holdMs = v;
      }
      s.settings.set("speech", Object.keys(next).length ? next : undefined);
      o.log(`speech: model ${s.speech.model()}, hold ${s.holdMs()} ms`);
      audit("settings speech", JSON.stringify(next));
      return send(200, s.speechView(writable));
    }
    // Any of default, titles, board; null resets the field.
    if (path === "/settings/language") {
      const next: LanguageSettings = { ...s.settings.get<LanguageSettings>("language") };
      for (const [k, ok] of [["default", (v: unknown) => LANGUAGES.includes(v as never)], ["titles", (v: unknown) => v === "board" || v === "speaker"], ["board", (v: unknown) => LANGUAGES.includes(v as never) && v !== "auto"]] as const) {
        if (!(k in b)) continue;
        const v = b[k];
        if (v === null) delete next[k];
        else if (!ok(v)) return send(400, { error: `bad ${k}: ${String(v)}` });
        else (next as Record<string, unknown>)[k] = v;
      }
      s.settings.set("language", Object.keys(next).length ? next : undefined);
      o.log(`language: ${JSON.stringify(s.language())}`);
      audit("settings language", JSON.stringify(next));
      return send(200, s.languageView(writable));
    }
    // The chat model when the client asks for none: { model, effort? }, or { model: null } for the default.
    if (b.model === null) {
      s.settings.set("chat", undefined);
      o.log("settings: chat model reset to the default");
      audit("settings chat", "reset");
      return send(200, chatSettings());
    }
    const p = o.providers.find((x) => x.name === b.model);
    if (!p) return send(400, { error: `unknown model "${String(b.model)}": one of ${o.providers.map((x) => x.name).join(", ")}` });
    const effort = b.effort == null || b.effort === "" ? undefined : String(b.effort);
    if (effort && !p.efforts?.levels.includes(effort)) return send(400, { error: p.efforts ? `effort "${effort}" is not one ${p.name} takes: ${p.efforts.levels.join(", ")}` : `${p.name} has no effort setting` });
    s.settings.set("chat", { model: p.name, ...(effort ? { effort } : {}) });
    audit("settings chat", `${p.name}${effort ? ` (${effort})` : ""}`);
    o.log(`settings: chat model ${p.name}${effort ? ` (${effort})` : ""}`);
    return send(200, chatSettings());
  };
}
