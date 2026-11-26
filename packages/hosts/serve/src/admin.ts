import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { type CacheSettings, type ChecklistInput, type QueueSettings, type TelemetryLine, type TranscriptLine, type TurnLine, cacheSettings, localTurnGate, queueSettings, reuseLayer, telemetryChecklist, withoutNames } from "@lenspack/agent";
import { type DeploymentContext, adminRights, deploymentContextSchema, recordRights } from "@lenspack/policy";

import { type AppOptions, pickChatModel, pickEffort } from "./app";
import { type AudioSettings, audioManifest, fileAudioStore } from "./audio";
import { type AuditLog, turnsReport } from "./audit";
import { type BrandConfig, brandAuditDetail, brandSettings } from "./brand";
import type { Principal } from "./auth";
import { type ExplainConfig, explainFrom } from "./config";
import { type FeatureValues, features as featureSwitches } from "./features";
import { NO_STORE, json, readJson } from "./http";
import { type Provider, effortFor, publicView } from "./llm";
import type { Budget } from "./metering";
import { cacheRoutes } from "./reuse";
import { type ReviewMountOptions, reviewMount } from "./review/mount";
import { settingsStore } from "./settings";
import { DEFAULT_SPEECH_MODEL, type SpeechOptions, speechKeyFromEnv, speechModelAllowed, speechModels } from "./speech";
import { fileTelemetry } from "./telemetry";
import { type TelemetryConfig, telemetrySwitches } from "./telemetry-switches";

// What an admin changes on a running server, from a host's settings page:
// the chat's default model, speech, languages and the off switches, kept in
// settings.json in the state directory; and the routes that page calls, under
// a prefix the host picks (/_superset), for its admins only. No secrets: which
// variable a key came from, never the key.

/** The chat menu's choices (auto: no speech hint, reply in the language used). */
export const LANGUAGES = ["auto", "en", "fr", "hi", "pt"] as const;
/** How long Space is held before the mic listens (a shorter press types a space). */
const HOLD_MS = { min: 500, max: 3000 };

type SpeechSettings = { model?: string; holdMs?: number } & Partial<AudioSettings>;
const AUDIO_DAYS = { min: 1, max: 3650 };
const AUDIO_MB = { min: 1, max: 100_000 };
const whole = (v: unknown, r: { min: number; max: number }): v is number => typeof v === "number" && Number.isInteger(v) && v >= r.min && v <= r.max;
type LanguageSettings = { default?: string; titles?: "board" | "speaker"; board?: string };
type ChatSetting = { model?: string; effort?: string };

/** A deployment's defaults for what the settings page can change. */
export type AdminConfig = {
  /** Speech to text for the mic. The model here is the default. */
  speech?: {
    model?: string;
    baseUrl?: string;
    maxSeconds?: number;
    holdMs?: number;
    /** Keep each spoken question's recording (default false; LENSPACK_SPEECH_KEEP_AUDIO). See docs/features/telemetry.md. */
    keepAudio?: boolean;
    /** Days a kept recording stays (default 30; LENSPACK_SPEECH_AUDIO_RETENTION_DAYS). */
    audioRetentionDays?: number;
    /** The most the kept recordings may take, in MB, the oldest deleted first (default 1000; LENSPACK_SPEECH_MAX_STORED_MB). */
    maxStoredMb?: number;
    /** Shown once to each user, and acknowledged, before the mic records while recordings are kept (LENSPACK_SPEECH_CONSENT_NOTICE). */
    consentNotice?: string;
  };
  /** Language defaults: the chat's, and whether new titles follow the board's language or the speaker's. */
  language?: LanguageSettings;
  /** Off switches, all on by default (see features.ts); LENSPACK_FEATURES and the settings page override them. */
  features?: FeatureValues;
  /**
   * Usage telemetry (docs/features/telemetry.md), on unless the telemetry feature switch is off. retentionDays (default 90,
   * else LENSPACK_TELEMETRY_RETENTION_DAYS); groups and items: the switchboard's starting values (every key and its
   * default are in docs/features/telemetry.md), which admins change on the admin panel's Telemetry tab.
   */
  telemetry?: TelemetryConfig;
  /**
   * The deployment's context (@lenspack/policy): a board id, a dataset name or "role:<name>" (and "*") mapped to the
   * campaign, campaign type and country it belongs to. Part of the deployment's policy; telemetry reads it.
   */
  context?: DeploymentContext;
  /** Saved answers (docs/features/saved-answers.md): the defaults the settings page starts from. */
  cache?: Partial<CacheSettings>;
  /** The turn queue (docs/features/busy-hours.md): model turns at once, and how many wait and for how long. */
  queue?: Partial<QueueSettings>;
  /** "How this was worked out" under each answer: false turns it off; `sql: false` keeps the words and rows but not the SQL. */
  explain?: ExplainConfig;
  /** What the assistant is called and its button says (brand.ts); LENSPACK_BRAND_* and the settings page override it. */
  brand?: BrandConfig;
};

/** Where the LLM key came from, for the settings page. */
export const llmKeySource = (env: NodeJS.ProcessEnv = process.env) =>
  env.LENSPACK_LLM_KEY_SOURCE || (env.LENSPACK_LLM_PROVIDERS ? "LENSPACK_LLM_PROVIDERS" : env.LENSPACK_LLM_API_KEY ? "LENSPACK_LLM_API_KEY" : env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null);

export function adminSettings(stateDir: string, config: AdminConfig = {}, env: NodeJS.ProcessEnv = process.env) {
  const settings = settingsStore(stateDir);
  const features = featureSwitches({ config: config.features, env: env.LENSPACK_FEATURES, settings });
  const brand = brandSettings({ config: config.brand, env, settings });
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
  // Kept recordings: off unless the config, the environment or the settings page turns them on.
  const flag = (v: string | undefined) => (["true", "on", "1", "yes"].includes((v ?? "").trim().toLowerCase()) ? true : ["false", "off", "0", "no"].includes((v ?? "").trim().toLowerCase()) ? false : undefined);
  const cs = config.speech ?? {};
  if (cs.keepAudio !== undefined && typeof cs.keepAudio !== "boolean") throw new Error("speech.keepAudio must be true or false");
  if (cs.audioRetentionDays !== undefined && !whole(cs.audioRetentionDays, AUDIO_DAYS)) throw new Error(`speech.audioRetentionDays must be a whole number of days from ${AUDIO_DAYS.min} to ${AUDIO_DAYS.max}`);
  if (cs.maxStoredMb !== undefined && !whole(cs.maxStoredMb, AUDIO_MB)) throw new Error(`speech.maxStoredMb must be a whole number of MB from ${AUDIO_MB.min} to ${AUDIO_MB.max}`);
  const envNum = (v: string | undefined, r: { min: number; max: number }) => (whole(Number(v), r) && v?.trim() ? Number(v) : undefined);
  const audioDefaults: AudioSettings = {
    keepAudio: false,
    audioRetentionDays: envNum(env.LENSPACK_SPEECH_AUDIO_RETENTION_DAYS, AUDIO_DAYS) ?? cs.audioRetentionDays ?? 30,
    maxStoredMb: envNum(env.LENSPACK_SPEECH_MAX_STORED_MB, AUDIO_MB) ?? cs.maxStoredMb ?? 1000,
    consentNotice: env.LENSPACK_SPEECH_CONSENT_NOTICE?.trim() || cs.consentNotice?.trim() || null,
  };
  // The telemetry switchboard (telemetry-switches.ts): telemetry as a whole, each section, each item.
  const parsedContext = deploymentContextSchema.safeParse(config.context ?? {});
  if (!parsedContext.success) throw new Error(`context: ${parsedContext.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`);
  const context = parsedContext.data;
  const switches = telemetrySwitches({
    settings,
    features,
    config: config.telemetry,
    env,
    // Kept recordings were speech.keepAudio before they were an item: that is still the item's starting value.
    keepAudio: () => saved<SpeechSettings>("speech")?.keepAudio ?? flag(env.LENSPACK_SPEECH_KEEP_AUDIO) ?? cs.keepAudio,
    voiceReady: () => features.on("voice") && !!speechKey.apiKey,
    consentNotice: () => audioSettings().consentNotice,
  });
  const audioSettings = (): AudioSettings => {
    const saved_ = saved<SpeechSettings>("speech") ?? {};
    return {
      // The voice-audio item (and with it its section and telemetry as a whole).
      keepAudio: switches.on().has("voice-audio"),
      audioRetentionDays: saved_.audioRetentionDays ?? audioDefaults.audioRetentionDays,
      maxStoredMb: saved_.maxStoredMb ?? audioDefaults.maxStoredMb,
      consentNotice: saved_.consentNotice !== undefined ? saved_.consentNotice || null : audioDefaults.consentNotice,
    };
  };
  const audio = fileAudioStore({ dir: stateDir, settings: audioSettings });
  const { store: telemetryLog, telemetry } = fileTelemetry(stateDir, {
    on: () => features.on("telemetry"),
    items: () => switches.on(),
    retentionDays: () => switches.retentionDays(),
    context: () => context,
  });
  const cache = cacheSettings(settings, config.cache);
  const queue = queueSettings(settings, config.queue);
  const cacheNow = () => ({ ...cache.get(), on: features.on("cache") });
  // Saved answers beside settings.json, and the turn gate, both read their settings on every turn (docs/features/saved-answers.md).
  const reuse = reuseLayer({ store: join(stateDir, "reuse.json"), settings: cacheNow, log: (m) => console.error(`lenspack: ${m}`) });
  const gate = localTurnGate(queue.get);
  return {
    settings,
    features,
    brand,
    cache,
    /** The answer store's effective settings: the section, and the cache feature switch. */
    cacheNow,
    queue,
    reuse,
    gate,
    speech,
    holdMs,
    language,
    telemetry,
    telemetryLog,
    switches,
    context,
    audio,
    audioSettings,
    /** The board API's per-turn reads of these settings. */
    app: {
      review: () => features.on("reviewer"),
      speech,
      language: () => ({ titles: language().titles, board: language().board }),
      chatDefault: () => saved<ChatSetting>("chat"),
      telemetry,
      audio,
      reuse,
      queue: gate,
      // The explain switch (settings page, env, config) and the config's explain.sql.
      explain: () => ({ ...explainFrom(config.explain), ...(features.on("explain") ? {} : { on: false }) }),
      brand: brand.get,
    } satisfies Partial<AppOptions>,
    /** The review system and admin panel over these settings (review/mount.ts), so a host wires it with no more imports. */
    review(o: ReviewMountOptions) {
      return reviewMount({ features, settings, brand, app: { review: () => features.on("reviewer"), chatDefault: () => saved<ChatSetting>("chat") } }, o);
    },
    featuresLine: () => `features: ${off().length ? `off: ${off().join(", ")}` : "all on"}`,
    speechView: async (writable: boolean) => ({
      enabled: !!speechKey.apiKey,
      keyFrom: speechKey.keyFrom,
      provider: "openrouter",
      model: speechModel(),
      defaultModel: defaultSpeechModel,
      source: saved<SpeechSettings>("speech")?.model ? "settings" : "default",
      holdMs: holdMs(),
      defaultHoldMs,
      holdMsRange: HOLD_MS,
      ...audioSettings(),
      audioDefaults,
      audioRetentionRange: AUDIO_DAYS,
      maxStoredMbRange: AUDIO_MB,
      stored: await audio.stats(),
      writable,
    }),
    languageView: (writable: boolean) => ({ ...language(), options: LANGUAGES, defaults: languageDefaults, source: saved("language") ? "settings" : "default", writable }),
    telemetryView: (writable: boolean) => ({ ...switches.view(writable), file: telemetryLog.file, context: Object.keys(context).length }),
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
  /** The host's view of Superset's action log for the telemetry checklist: exports and shares on Lenspack's dashboards since a date. */
  supersetLogs?: (since: Date) => Promise<ChecklistInput["supersetLogs"]>;
  /** What features that own a checklist item counted since a date (review runs, proposals, open questions). */
  owned?: (since: Date) => Promise<ChecklistInput["owned"]>;
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
  // Saved answers' admin routes (<prefix>/cache…), beside the settings.
  const cachePage = cacheRoutes({ prefix: o.prefix, reuse: s.reuse, queue: s.gate, audit: o.audit, adminName: o.adminName });
  /** The checklist and switchboard as they stand: the switches, the last 7 days of records, what features counted. */
  async function checklistNow() {
    const now = new Date();
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const sinceIso = since.toISOString();
    const audio = s.audioSettings();
    const sw = s.switches.values();
    // Superset's action log is read only while its item is on.
    const logsOn = s.switches.on().has("trust-superset-actions");
    const supersetLogs = !o.supersetLogs ? null : logsOn ? await o.supersetLogs(since).catch((e: unknown) => ({ available: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e), count: 0, lastSeen: null })) : { available: true, count: 0, lastSeen: null };
    return telemetryChecklist({
      now,
      switches: sw,
      changed: s.switches.changed(),
      settings: { retentionDays: sw.retentionDays, audioRetentionDays: audio.audioRetentionDays, consentNotice: audio.consentNotice },
      features: s.switches.featureValues(true),
      context: s.context,
      lines: await s.telemetryLog.find({ from: since }),
      audioSaved: (await s.audio.list()).filter((c) => c.at >= sinceIso).map((c) => c.at),
      supersetLogs,
      owned: await o.owned?.(since),
    });
  }
  return async (req: IncomingMessage, res: ServerResponse, url: URL, who: Principal): Promise<void> => {
    if (!url.pathname.startsWith(`${o.prefix}/`)) return;
    await cachePage(req, res, url, who);
    if (res.headersSent) return;
    const path = url.pathname.slice(o.prefix.length);
    const send = (status: number, body: unknown) => json(res, status, body, NO_STORE);
    const audit = (action: string, detail?: string, outcome: "ok" | "denied" = "ok") => o.audit?.audit({ at: new Date().toISOString(), user: who.user, action, outcome, ...(detail !== undefined ? { detail } : {}) });
    const writable = o.writable();

    if (path === "/info") {
      // consent: the notice this user must acknowledge before the mic records, while recordings are kept; else null.
      const speech = s.speech.apiKey ? { enabled: true, maxSeconds: s.speech.maxSeconds, holdMs: s.holdMs(), consent: await s.audio.consentNeeded(who.user) } : { enabled: false };
      return send(200, { ...o.info?.(url), speech, language: { default: s.language().default, options: LANGUAGES }, features: s.features.values(), brand: s.brand.get() });
    }
    if (path === "/settings/speech/models") return send(200, (await speechModels({ baseUrl: s.speech.baseUrl })).models);
    const put = req.method === "PUT";
    // Kept recordings: GET /audio (what is kept), GET or DELETE /audio/<transcriptId>, DELETE /audio?user=<name> or
    // ?all=1, POST /audio/export (a benchmark manifest). Admins only, each play and deletion audited. No other route serves audio.
    const clip = /^\/audio(?:\/([\w-]{1,64}))?$/.exec(path);
    if (clip) {
      if (!recordRights(who).audio) {
        audit(`${req.method} ${url.pathname}`, `not a ${o.adminName}`, "denied");
        return send(403, { error: `only ${o.adminName}s can do this` });
      }
      const id = clip[1];
      if (id === "export" && req.method === "POST") {
        const all = await s.telemetryLog.find({ from: new Date(0) });
        const transcripts = new Map(all.filter((l): l is TranscriptLine => l.type === "transcript").map((l) => [l.transcriptId, l]));
        const turns = all.filter((l): l is TurnLine => l.type === "turn" && !!l.transcriptIds?.length);
        const { lines, flagged } = audioManifest(
          await s.audio.list(),
          (tid) => {
            const t = transcripts.get(tid);
            if (!t) return null;
            const turn = turns.find((x) => x.transcriptIds?.includes(tid));
            return {
              // Texts only while their items were on (transcript-text, question-text).
              transcript: t.transcript ?? null,
              sent: turn?.question ?? null,
              lang: t.languageDetected ?? t.languageRequested ?? turn?.questionLanguage ?? null,
              seconds: t.seconds ?? null,
              edits: turn?.transcriptEditDistance ?? null,
              several: (turn?.transcriptIds?.length ?? 0) > 1,
            };
          },
          (user) => s.telemetry.hash(`speaker:${user}`).slice(0, 12),
        );
        const write = (name: string, rows: unknown[]) => s.audio.saveExport(name, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
        const file = await write("manifest.jsonl", lines);
        const flaggedFile = await write("manifest-flagged.jsonl", flagged);
        audit("audio export", `${lines.length} clips, ${flagged.length} flagged`);
        return send(200, { file, flaggedFile, clips: lines.length, flagged: flagged.length, note: "Audio paths are relative to the audio folder in the state directory; copy it beside evals/speech/data to score." });
      }
      if (req.method === "GET" && !id) return send(200, { ...(await s.audio.stats()), settings: s.audioSettings(), clips: (await s.audio.list()).map(({ id: cid, user, at, bytes, format }) => ({ id: cid, user, at, bytes, format })) });
      if (req.method === "GET" && id) {
        const found = await s.audio.read(id);
        audit("audio play", id, found ? "ok" : "denied");
        if (!found) return send(404, { error: "no kept recording with that id" });
        res.writeHead(200, { "content-type": found.type, "content-length": String(found.data.byteLength), "content-disposition": `inline; filename="${found.id}.${found.file.split(".").pop()}"`, ...NO_STORE });
        return void res.end(found.data);
      }
      if (req.method === "DELETE" && id) {
        const n = await s.audio.delete(id);
        audit("audio delete", id);
        return send(n ? 200 : 404, n ? { deleted: n } : { error: "no kept recording with that id" });
      }
      if (req.method === "DELETE" && !id) {
        const user = url.searchParams.get("user");
        if (user) {
          const n = await s.audio.deleteUser(user);
          audit("audio delete user", `${user}: ${n}`);
          return send(200, { deleted: n });
        }
        if (url.searchParams.get("all") === "1") {
          const n = await s.audio.deleteAll();
          audit("audio delete all", String(n));
          return send(200, { deleted: n });
        }
        return send(400, { error: "name ?user=<name>, or ?all=1 to delete every kept recording" });
      }
      return send(405, { error: "not a method this route takes" });
    }
    if (!["/settings", "/turns", "/audit", "/telemetry", "/telemetry/checklist"].includes(path) && !(put && ["/settings/features", "/settings/speech", "/settings/language", "/settings/chat", "/settings/cache", "/settings/queue", "/settings/telemetry", "/settings/brand"].includes(path))) return;
    const may = recordRights(who);
    // The settings and every switch: the admin role (adminRights in @lenspack/policy); the records: recordRights.
    if (path.startsWith("/telemetry") ? !may.telemetry : !adminRights(who).administer) {
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
        speech: await s.speechView(writable),
        language: s.languageView(writable),
        features: s.features.view(writable),
        brand: s.brand.view(writable),
        telemetry: s.telemetryView(writable),
        cache: s.cache.view(writable),
        queue: s.queue.view(writable),
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

    // What telemetry records for this deployment, item by item, each with its switch: the Telemetry tab (docs/features/telemetry.md).
    if (path === "/telemetry/checklist") return send(200, await checklistNow());

    // Usage telemetry, newest first: ?from=&to= (ISO dates or times; default the last 7 days), ?type=turn|event|transcript, ?offset=&limit= (a page, at most 5000).
    if (path === "/telemetry") {
      const date = (k: string) => {
        const v = url.searchParams.get(k);
        if (!v) return undefined;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new Error(`${k} must be a date or time, like 2026-11-01`);
        return d;
      };
      try {
        const to = date("to");
        const from = date("from") ?? new Date((to ?? new Date()).getTime() - 7 * 86_400_000);
        const type = url.searchParams.get("type") || undefined;
        if (type && !["turn", "event", "transcript"].includes(type)) throw new Error("type must be turn, event or transcript");
        const page = await s.telemetry.read({ from, to, type: type as TelemetryLine["type"] | undefined, offset: Number(url.searchParams.get("offset")) || 0, limit: Number(url.searchParams.get("limit")) || 500 });
        // User names only for a reader policy lets see them; else a stable stand-in per name.
        const records = may.usernames ? page.records : withoutNames(page.records, s.telemetry.hash);
        return send(200, { enabled: s.telemetry.enabled(), retentionDays: s.telemetryLog.retentionDays, items: [...s.telemetry.items()], usernames: may.usernames, from: from.toISOString(), to: (to ?? new Date()).toISOString(), ...page, records });
      } catch (e) {
        return send(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Every change is a small JSON object.
    let b: Record<string, unknown>;
    try {
      // A brand change may carry a small icon as a data URI.
      b = (await readJson(req, path === "/settings/brand" ? 50_000 : 10_000)) as Record<string, unknown>;
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
    // The assistant's name, button label, icon and attribution line: any of them, null puts one back. Pages pick it up on their next load.
    if (path === "/settings/brand") {
      const r = s.brand.update(b);
      if (!r.ok) return send(400, { error: r.error });
      o.log(`brand: ${r.brand.name} ("${r.brand.buttonLabel}")`);
      audit("settings brand", brandAuditDetail(b));
      return send(200, s.brand.view(writable));
    }
    // Saved answers: any of enabled, ttlHours, router, maxEntries, freshMinutes; null puts a field back to the default.
    if (path === "/settings/cache") {
      const r = s.cache.update(b);
      if (!r.ok) return send(400, { error: r.error });
      o.log(`cache: ${JSON.stringify(s.cache.get())}`);
      audit("settings cache", JSON.stringify(b));
      return send(200, s.cache.view(writable));
    }
    // The turn queue: any of maxConcurrent, maxWaiting, maxWaitSeconds; read on every turn.
    if (path === "/settings/queue") {
      const r = s.queue.update(b);
      if (!r.ok) return send(400, { error: r.error });
      o.log(`queue: ${JSON.stringify(s.queue.get())}`);
      audit("settings queue", JSON.stringify(b));
      return send(200, s.queue.view(writable));
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
      // Kept recordings: audioRetentionDays, maxStoredMb, consentNotice ("" or null for none… null resets). Whether they
      // are kept at all is the voice-audio item, switched on the Telemetry tab (PUT settings/telemetry) with a confirm step.
      if ("keepAudio" in b) return send(409, { error: 'keeping recordings is the voice-audio telemetry item: PUT settings/telemetry {"items.voice-audio": true, "confirm": true}' });
      for (const [k, r] of [["audioRetentionDays", AUDIO_DAYS], ["maxStoredMb", AUDIO_MB]] as const) {
        if (!(k in b)) continue;
        const v = b[k];
        if (v === null) delete next[k];
        else if (!whole(v, r)) return send(400, { error: `${k} is a whole number from ${r.min} to ${r.max}` });
        else next[k] = v;
      }
      if ("consentNotice" in b) {
        const v = b.consentNotice;
        if (v === null) delete next.consentNotice;
        else if (typeof v !== "string" || v.length > 2000) return send(400, { error: "consentNotice is a text of at most 2000 characters" });
        else next.consentNotice = v.trim();
      }
      if ("holdMs" in b) {
        const v = b.holdMs;
        if (v === null || v === "") delete next.holdMs;
        else if (typeof v !== "number" || !Number.isInteger(v) || v < HOLD_MS.min || v > HOLD_MS.max) return send(400, { error: `holdMs is a whole number of milliseconds from ${HOLD_MS.min} to ${HOLD_MS.max}` });
        else next.holdMs = v;
      }
      s.settings.set("speech", Object.keys(next).length ? next : undefined);
      o.log(`speech: model ${s.speech.model()}, hold ${s.holdMs()} ms, keep audio ${s.audioSettings().keepAudio ? `on (${s.audioSettings().audioRetentionDays} days, ${s.audioSettings().maxStoredMb} MB)` : "off"}`);
      await s.audio.sweep();
      audit("settings speech", JSON.stringify(next));
      return send(200, await s.speechView(writable));
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
    // The switchboard: any of {"telemetry", "groups.<section>", "items.<item>": true|false|null, "retentionDays": n|null};
    // null puts a switch back to the deployment's value. A privacy-sensitive item turns on only with "confirm": true.
    // Applied at once (every record reads the switches), audited, and answered with the checklist as it now stands.
    if (path === "/settings/telemetry") {
      const r = s.switches.update(b, who.user);
      if (!r.ok) {
        if (r.confirm) audit("settings telemetry", `${r.confirm.key}: needs confirming`, "denied");
        return send(r.status, { error: r.error, ...(r.confirm ? { confirm: r.confirm } : {}) });
      }
      const words = r.changes.map((c) => `${c.key} ${c.from} → ${c.to}`).join("; ");
      o.log(`telemetry: ${words}`);
      audit("settings telemetry", JSON.stringify({ changes: r.changes, confirmed: b.confirm === true }));
      return send(200, await checklistNow());
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
