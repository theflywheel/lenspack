import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { type CacheSettings, type ChecklistInput, fieldNotices, type QueueSettings, type TelemetryLine, type TranscriptLine, type TurnLine, cacheSettings, localTurnGate, queueSettings, reuseLayer, telemetryChecklist, withoutNames } from "@lenspack/agent";
import { type DeploymentContext, adminRights, adminUsersFrom, deploymentContextSchema, mayUse, offeredModels, recordRights } from "@lenspack/policy";

import type { AdminAccessSetup, UserAccessSetup } from "./admin-access";

import { type AppOptions, pickChatModel, pickEffort } from "./app";
import { type AudioSettings, audioManifest, fileAudioStore } from "./audio";
import { type AuditEvent, type AuditLog, turnRow, turnsReport } from "./audit";
import { type BrandConfig, brandAuditDetail, brandSettings } from "./brand";
import type { Principal } from "./auth";
import type { ExplainConfig } from "./config";
import { type FeatureValues, features as featureSwitches } from "./features";
import { NO_STORE, json, readJson } from "./http";
import { type Provider, effortFor, modelLabel, publicView } from "./llm";
import type { Budget } from "./metering";
import { budgetFromEnv } from "./runtime";
import { runtimeConfig } from "./runtime-config";
import { cacheRoutes } from "./reuse";
import { type ReviewMountOptions, reviewMount } from "./review/mount";
import { asSettingsWriter, revisionTag, settingsStore } from "./settings";
import { DEFAULT_SPEECH_MODEL, SPEECH_MEASURED, type SpeechOptions, speechKeyFromEnv, speechModelAllowed, speechModels } from "./speech";
import { PageError, pageAsk, pageFrom, pageOf, pagedAsk } from "./paging";
import { fileTelemetry } from "./telemetry";
import { type TelemetryConfig, telemetrySwitches } from "./telemetry-switches";

// What an admin changes on a running server, from a host's settings page:
// the chat's default model, speech, languages and the off switches, kept in
// settings.json in the state directory; and the routes that page calls, under
// a prefix the host picks (/_superset), for its admins only. No secrets: which
// variable a key came from, never the key.

/** The settings routes for the deploy config's options an admin changes while the server runs (runtime-config.ts). */
const RUNTIME_AREAS = ["/settings/budget", "/settings/models", "/settings/audit", "/settings/history", "/settings/explain", "/settings/context"];

/** The chat menu's choices (auto: no speech hint, reply in the language used). */
export const LANGUAGES = ["auto", "en", "fr", "hi", "pt"] as const;
/** How long Space is held before the mic listens (a shorter press types a space). */
const HOLD_MS = { min: 500, max: 3000 };

type SpeechSettings = { model?: string; holdMs?: number; maxSeconds?: number } & Partial<AudioSettings>;
/** The longest recording the mic takes, in seconds. */
const MAX_SECONDS = { min: 5, max: 300 };
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
   * else LENSPACK_TELEMETRY_RETENTION_DAYS); fields: the switchboard's starting values (every key and its default are
   * in docs/features/telemetry.md; the older items and groups still read), which admins change on the Telemetry tab.
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
  /** Daily caps on chat spend (else LENSPACK_BUDGET_*); the settings page overrides them (runtime-config.ts). */
  budget?: Budget;
  /** The audit log: false turns it off (deploy config only); retentionDays the settings page may change. */
  audit?: false | { retentionDays?: number };
  /** How many recent turns the chat model is sent (8); the settings page overrides it. */
  historyTurns?: number;
};

/** Where the LLM key came from, for the settings page. */
export const llmKeySource = (env: NodeJS.ProcessEnv = process.env) =>
  env.LENSPACK_LLM_KEY_SOURCE || (env.LENSPACK_LLM_PROVIDERS ? "LENSPACK_LLM_PROVIDERS" : env.LENSPACK_LLM_API_KEY ? "LENSPACK_LLM_API_KEY" : env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null);

export function adminSettings(stateDir: string, config: AdminConfig = {}, env: NodeJS.ProcessEnv = process.env) {
  const settings = settingsStore(stateDir);
  const features = featureSwitches({ config: config.features, env: env.LENSPACK_FEATURES, settings });
  const brand = brandSettings({ config: config.brand, env, settings });
  const saved = <T>(section: string) => settings.get<T>(section);
  // The deploy config's options an admin also changes while the server runs (runtime-config.ts).
  const configBudget = config.budget ?? budgetFromEnv(env);
  const roles = (() => {
    try {
      return env.LENSPACK_LLM_ROLES ? (JSON.parse(env.LENSPACK_LLM_ROLES) as Record<string, string>) : undefined;
    } catch {
      return undefined;
    }
  })();
  const runtime = runtimeConfig(settings, {
    budget: configBudget,
    budgetFrom: config.budget ? "config" : "env",
    auditRetentionDays: Number(env.LENSPACK_AUDIT_RETENTION_DAYS) || (config.audit ? config.audit.retentionDays : undefined) || 90,
    historyTurns: config.historyTurns,
    explain: config.explain,
    roles: roles ? { reviewer: roles.reviewer, escalate: roles.escalate, router: roles.router } : undefined,
  });
  const defaultSpeechModel = config.speech?.model ?? DEFAULT_SPEECH_MODEL;
  const defaultHoldMs = Math.min(HOLD_MS.max, Math.max(HOLD_MS.min, config.speech?.holdMs ?? 2000));
  const speechModel = () => saved<SpeechSettings>("speech")?.model ?? defaultSpeechModel;
  const holdMs = () => saved<SpeechSettings>("speech")?.holdMs ?? defaultHoldMs;
  const speechKey = speechKeyFromEnv(env);
  const defaultMaxSeconds = config.speech?.maxSeconds ?? 60;
  // With voice switched off the key is withheld, so the mic is hidden and /api/_stt answers 503.
  const speech: SpeechOptions = {
    ...speechKey,
    get apiKey() {
      return features.on("voice") ? speechKey.apiKey : undefined;
    },
    baseUrl: config.speech?.baseUrl,
    // The longest recording: the config's (60 s), unless an admin set one.
    get maxSeconds() {
      return saved<SpeechSettings>("speech")?.maxSeconds ?? defaultMaxSeconds;
    },
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
  // The telemetry switchboard (telemetry-switches.ts): telemetry as a whole, and each field group.
  const parsedContext = deploymentContextSchema.safeParse(config.context ?? {});
  if (!parsedContext.success) throw new Error(`context: ${parsedContext.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`);
  const configContext = parsedContext.data;
  // The context labels: the config's, unless an admin replaced them (PUT settings/context).
  const contextNow = (): DeploymentContext => saved<DeploymentContext>("context") ?? configContext;
  const switches = telemetrySwitches({
    settings,
    features,
    config: config.telemetry,
    env,
    context: contextNow,
    // Kept recordings were speech.keepAudio before they were a field switch: that is still the field's starting value.
    keepAudio: () => saved<SpeechSettings>("speech")?.keepAudio ?? flag(env.LENSPACK_SPEECH_KEEP_AUDIO) ?? cs.keepAudio,
    voiceReady: () => features.on("voice") && !!speechKey.apiKey,
    consentNotice: () => audioSettings().consentNotice,
  });
  const audioSettings = (): AudioSettings => {
    const saved_ = saved<SpeechSettings>("speech") ?? {};
    return {
      // The voice-audio field (and with it telemetry as a whole).
      keepAudio: switches.on().has("voice-audio"),
      audioRetentionDays: saved_.audioRetentionDays ?? audioDefaults.audioRetentionDays,
      maxStoredMb: saved_.maxStoredMb ?? audioDefaults.maxStoredMb,
      consentNotice: saved_.consentNotice !== undefined ? saved_.consentNotice || null : audioDefaults.consentNotice,
    };
  };
  const audio = fileAudioStore({ dir: stateDir, settings: audioSettings });
  const { store: telemetryLog, telemetry } = fileTelemetry(stateDir, {
    on: () => features.on("telemetry"),
    fields: () => switches.on(),
    retentionDays: () => switches.retentionDays(),
    context: contextNow,
  });
  const cache = cacheSettings(settings, config.cache);
  const queue = queueSettings(settings, config.queue);
  const cacheNow = () => ({ ...cache.get(), on: features.on("cache") });
  // Saved answers beside settings.json, and the turn gate, both read their settings on every turn (docs/features/saved-answers.md).
  const reuse = reuseLayer({ store: join(stateDir, "reuse.json"), settings: cacheNow, log: (m) => console.error(`lenspack: ${m}`) });
  const gate = localTurnGate(queue.get);
  // What reads each telemetry field: the usage board's widgets, once the review mount has made it.
  let telemetryUses: (() => Promise<Record<string, { id: string; label: string }[]>>) | null = null;
  const notices = () => fieldNotices({ switches: switches.values(), features: switches.featureValues(true), context: contextNow() });
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
    get context() {
      return contextNow();
    },
    /** The context as the config writes it, for the settings page's reset. */
    configContext,
    contextView: (writable: boolean) => ({ context: contextNow(), defaults: configContext, source: saved("context") ? "settings" : "default", writable }),
    runtime,
    audio,
    audioSettings,
    /** By telemetry field group id, the widgets of the usage board that read it ({} before the board is made). */
    telemetryUses: async () => (telemetryUses ? await telemetryUses().catch(() => ({})) : {}),
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
      // The explain switch (settings page, env, config) and explain.sql (the config's, or an admin's).
      explain: () => ({ ...runtime.explain.get(), ...(features.on("explain") ? {} : { on: false }) }),
      historyTurns: runtime.history.turns,
      models: { offered: runtime.models.offered, roles: runtime.models.roles },
      brand: brand.get,
    } satisfies Partial<AppOptions>,
    /** The review system and admin panel over these settings (review/mount.ts), so a host wires it with no more imports. */
    review(o: ReviewMountOptions) {
      return reviewMount(
        { features, settings, brand, app: { review: () => features.on("reviewer"), chatDefault: () => saved<ChatSetting>("chat") }, telemetry: { notices, setUses: (f) => (telemetryUses = f) } },
        o,
      );
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
      maxSeconds: speech.maxSeconds,
      defaultMaxSeconds,
      maxSecondsRange: MAX_SECONDS,
      ...audioSettings(),
      audioDefaults,
      audioRetentionRange: AUDIO_DAYS,
      maxStoredMbRange: AUDIO_MB,
      stored: await audio.stats(),
      // Measured word error rate and latency per model (speech.ts), shown beside the picker.
      measured: SPEECH_MEASURED,
      writable,
    }),
    languageView: (writable: boolean) => ({ ...language(), options: LANGUAGES, defaults: languageDefaults, source: saved("language") ? "settings" : "default", writable }),
    telemetryView: (writable: boolean) => ({ ...switches.view(writable), file: telemetryLog.file, context: Object.keys(contextNow()).length }),
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
  info?: (url: URL, req: IncomingMessage) => Record<string, unknown>;
  details?: () => Record<string, unknown>;
  /** The host's view of Superset's action log for the telemetry checklist: exports and shares on Lenspack's dashboards since a date. */
  supersetLogs?: (since: Date) => Promise<ChecklistInput["supersetLogs"]>;
  /** What features that own a checklist item counted since a date (review runs, proposals, open questions). */
  owned?: (since: Date) => Promise<ChecklistInput["owned"]>;
  /** Who is an admin (admin-access.ts): shown on the settings, and under named users, the owners' grants (<prefix>/settings/admins). */
  access?: AdminAccessSetup;
  /** Who may use the assistant (admin-access.ts): shown on the settings, and under granted, the people admins let in (<prefix>/settings/users). */
  users?: UserAccessSetup;
  /** More in <prefix>/settings/revision, for an open admin page to notice a change made elsewhere (the pack's version). */
  revisionExtras?: () => Record<string, unknown>;
};


/** The settings page's routes, answering by responding. A caller who is not signed in never reaches them: the host answers 401 first. */
export function adminRoutes(o: AdminRouteOptions) {
  const s = o.settings;
  /** The chat section: what runs when the client asks for no model. */
  const chatSettings = () => {
    const saved = s.settings.get<ChatSetting>("chat");
    // Only the models offered (PUT settings/models) answer, the default among them.
    const offered = offeredModels(o.providers, s.runtime.models.offered());
    const current = pickChatModel(offered, null, saved);
    // The deployment's default is the first model it configures, whether or not it answers right now; when it is down,
    // another answers in its place, and `fallback` says so. (Before, the default named whichever model answered first.)
    const configured = offered[0] ?? null;
    const source = saved?.model && current?.name === saved.model ? "settings" : "default";
    return {
      model: current?.name ?? null,
      label: current ? modelLabel(current) : null,
      effort: (current && effortFor(current, pickEffort(current, null, saved))) ?? null,
      defaultModel: configured?.name ?? null,
      defaultLabel: configured ? modelLabel(configured) : null,
      fallback: source === "default" && !!current && !!configured && current.name !== configured.name,
      source,
      writable: o.writable(),
      options: offered.map(publicView),
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
    // Superset's action log is read only while its field is on.
    const logsOn = s.switches.on().has("superset-actions");
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
      uses: await s.telemetryUses?.(),
    });
  }
  /** Every setting, as GET <prefix>/settings answers (and a refused write's `current`). */
  async function settingsView(who: Principal) {
    const writable = o.writable();
    const rights = adminRights(who, o.access?.state());
    const me = { ...rights, user: who.user };
    return {
      ...o.details?.(),
      providers: o.providers.map(publicView),
      llmFrom: llmKeySource(),
      // Each with its value, the deployment's, where it comes from, and whether it can be saved now.
      budget: s.runtime.budget.view(writable),
      audit: o.audit ? { file: o.audit.file, months: o.audit.months(), ...s.runtime.audit.view(writable) } : null,
      models: s.runtime.models.view(o.providers, writable),
      history: s.runtime.history.view(writable),
      explain: s.runtime.explain.view(writable),
      context: s.contextView(writable),
      chat: chatSettings(),
      speech: await s.speechView(writable),
      language: s.languageView(writable),
      features: s.features.view(writable),
      brand: s.brand.view(writable),
      telemetry: s.telemetryView(writable),
      cache: s.cache.view(writable),
      queue: s.queue.view(writable),
      ...(o.access ? { adminAccess: o.access.view(me) } : {}),
      ...(o.users ? { userAccess: o.users.view() } : {}),
      // The revision these values are at (also the ETag): send it back as If-Match on a change.
      revision: s.settings.revision(),
      lastChange: s.settings.lastChange(),
    };
  }
  return async (req: IncomingMessage, res: ServerResponse, url: URL, who: Principal): Promise<void> => {
    if (!url.pathname.startsWith(`${o.prefix}/`)) return;
    await cachePage(req, res, url, who);
    if (res.headersSent) return;
    const path = url.pathname.slice(o.prefix.length);
    // A write that says which revision it was made on (If-Match) is refused when the setting it changes moved since
    // (settings.ts); one that doesn't writes as before. Every write is attributed to the caller.
    if (!path.startsWith("/settings")) return handle(req, res, url, who, path);
    return asSettingsWriter(s.settings, req, res, who, () => handle(req, res, url, who, path), () => settingsView(who));
  };
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, who: Principal, path: string): Promise<void> {
    // The settings' answers carry the revision they are at, so a page can send it back (If-Match).
    const send = (status: number, body: unknown) => json(res, status, body, path.startsWith("/settings") ? { ...NO_STORE, ETag: revisionTag(s.settings.revision()) } : NO_STORE);
    const audit = (action: string, detail?: string, outcome: "ok" | "denied" = "ok") => o.audit?.audit({ at: new Date().toISOString(), user: who.user, action, outcome, ...(detail !== undefined ? { detail } : {}) });
    const writable = o.writable();

    if (path === "/info") {
      // consent: the notice this user must acknowledge before the mic records, while recordings are kept; else null.
      const speech = s.speech.apiKey ? { enabled: true, maxSeconds: s.speech.maxSeconds, holdMs: s.holdMs(), consent: await s.audio.consentNeeded(who.user) } : { enabled: false };
      return send(200, { ...o.info?.(url, req), speech, language: { default: s.language().default, options: LANGUAGES }, features: s.features.values(), brand: s.brand.get() });
    }
    // Who the caller is here and what they may do, changing nothing: a script checks its admin API key with it.
    if (path === "/whoami" && req.method === "GET") {
      const r = adminRights(who, o.access?.state());
      return send(200, { user: who.user, administer: r.administer, users: r.users, owner: r.owner, via: r.via ?? null, detail: r.detail ?? null, usesAssistant: mayUse(who) });
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
      if (req.method === "GET" && !id) {
        // Newest first; ?cursor=/?offset= and ?limit= page it (page in the answer), as every admin list.
        const clips = (await s.audio.list()).map(({ id: cid, user, at, bytes, format }) => ({ id: cid, user, at, bytes, format })).sort((a, b) => b.at.localeCompare(a.at));
        const base = { ...(await s.audio.stats()), settings: s.audioSettings() };
        if (!pagedAsk(url)) return send(200, { ...base, clips });
        try {
          const { items, page } = pageFrom(clips, url);
          return send(200, { ...base, clips: items, page });
        } catch (e) {
          return send(400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
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
    if (!["/settings", "/settings/revision", "/settings/admins", "/settings/users", "/turns", "/audit", "/telemetry", "/telemetry/checklist"].includes(path) && !(put && ["/settings/admins", "/settings/users", "/settings/features", "/settings/speech", "/settings/language", "/settings/chat", "/settings/cache", "/settings/queue", "/settings/telemetry", "/settings/brand", ...RUNTIME_AREAS].includes(path))) return;
    const may = recordRights(who);
    // The settings and every switch: the admin role (adminRights in @lenspack/policy); the records: recordRights.
    const access = o.access?.state();
    const rights = adminRights(who, access);
    if (path.startsWith("/telemetry") ? !may.telemetry : !rights.administer) {
      audit(`${req.method} ${url.pathname}`, `not a ${o.adminName}`, "denied");
      return send(403, { error: `only ${o.adminName}s can do this` });
    }
    // On the admins roster, with how they qualify; the first time, an audit line (admin-access.ts).
    if (rights.administer) o.access?.seen(who);
    const me = { ...rights, user: who.user };

    if (path === "/settings") return send(200, await settingsView(who));
    // Cheap enough to ask every few seconds: an open admin page reloads what changed elsewhere.
    if (path === "/settings/revision") return send(200, { revision: s.settings.revision(), lastChange: s.settings.lastChange(), ...o.revisionExtras?.() });
    // Who may use the assistant. GET: the modes, and under granted the people let in, newest first, ?q= to search, paged
    // (?cursor=, ?limit=). PUT { add } or { remove }: any admin, under granted; seeded people stay.
    if (path === "/settings/users" && !put) {
      if (!o.users) return send(200, { modes: null });
      const q = url.searchParams.get("q")?.trim().toLowerCase();
      const all = [...o.users.grants.list()].filter((g) => !o.users!.seeded.includes(g.user)).reverse().filter((g) => !q || g.user.toLowerCase().includes(q) || g.by.toLowerCase().includes(q));
      try {
        const { items, page } = pageFrom(all, url, { limit: 20 });
        return send(200, { ...o.users.view(), seeded: o.users.seeded.filter((u) => !q || u.toLowerCase().includes(q)), users: items, page });
      } catch (e) {
        return send(e instanceof PageError ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/settings/users") {
      if (!o.users?.granting) return send(409, { error: `people are granted only when user access includes granted (now ${o.users?.modes.join(",") ?? "not set"})` });
      let b: Record<string, unknown>;
      try {
        b = (await readJson(req, 2_000)) as Record<string, unknown>;
        if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("body must be a JSON object");
      } catch (e) {
        return send(400, { error: e instanceof Error ? e.message : String(e) });
      }
      const op = typeof b.add === "string" ? "add" : typeof b.remove === "string" ? "remove" : null;
      let user: string | undefined;
      try {
        user = op ? adminUsersFrom([String(b[op])])[0] : undefined;
      } catch (e) {
        return send(400, { error: e instanceof Error ? e.message : String(e) });
      }
      if (!op || !user) return send(400, { error: 'send { "add": "<Superset user name or id:n>" } or { "remove": "<…>" }' });
      if (o.users.seeded.includes(user)) return send(400, { error: `${user} is seeded from ${o.users.seededFrom ?? "the deployment"}: change it there, then restart` });
      if (op === "add") {
        if (!o.users.grants.add({ user, by: who.user, at: new Date().toISOString() })) return send(409, { error: `${user} may already use the assistant` });
        audit("settings users grant", user);
        o.log(`users: ${who.user} let ${user} use the assistant`);
      } else {
        if (!o.users.grants.remove(user)) return send(404, { error: `${user} was not granted` });
        audit("settings users revoke", user);
        o.log(`users: ${who.user} removed ${user}`);
      }
      return send(200, o.users.view());
    }
    // Who is an admin, and under named Superset users the grants: GET for any admin; PUT { add } or { remove } for owners.
    if (path === "/settings/admins" && !put) return send(200, o.access ? o.access.view(me) : { mode: null });
    if (path === "/settings/admins") {
      if (!o.access || !o.access.has("superset-users")) return send(409, { error: `admins are granted only when admin access includes superset-users (now ${o.access?.modes.join(",") ?? "not set"})` });
      if (!rights.owner) {
        audit("PUT settings admins", "not an owner", "denied");
        return send(403, { error: "only owners (LENSPACK_ADMIN_USERS), or an admin signed in with a password, can grant or remove admins" });
      }
      let b: Record<string, unknown>;
      try {
        b = (await readJson(req, 2_000)) as Record<string, unknown>;
        if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("body must be a JSON object");
      } catch (e) {
        return send(400, { error: e instanceof Error ? e.message : String(e) });
      }
      const op = typeof b.add === "string" ? "add" : typeof b.remove === "string" ? "remove" : null;
      let user: string | undefined;
      try {
        user = op ? adminUsersFrom([String(b[op])])[0] : undefined;
      } catch (e) {
        return send(400, { error: e instanceof Error ? e.message : String(e) });
      }
      if (!op || !user) return send(400, { error: 'send { "add": "<Superset user name or id:n>" } or { "remove": "<…>" }' });
      if (o.access.owners.includes(user)) return send(400, { error: `${user} is an owner, from ${o.access.ownersFrom ?? "the deployment"}: change owners there, then restart` });
      if (op === "add") {
        if (!o.access.grants.add({ user, by: who.user, at: new Date().toISOString() })) return send(409, { error: `${user} is already an admin` });
        audit("settings admins grant", user);
        o.log(`admins: ${who.user} granted admin to ${user}`);
      } else {
        if (!o.access.grants.remove(user)) return send(404, { error: `${user} is not a granted admin` });
        audit("settings admins revoke", user);
        o.log(`admins: ${who.user} removed admin from ${user}`);
      }
      return send(200, o.access.view(me));
    }
    // What chat has cost: the newest turns and the totals for today and the last 7 days, from the audit log.
    // Paged (any of from, to, user, cursor, offset): the turns in [from, to) newest first (default the last 7 days),
    // one page of them as `recent`, the range's totals as `range`, and page. Asked the old way (?limit=N), as before.
    if (path === "/turns") {
      if (!o.audit) return send(200, { enabled: false });
      const now = new Date();
      if (!pagedAsk(url, ["from", "to", "user"])) {
        const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 500));
        return send(200, { enabled: true, ...turnsReport(o.audit.since(new Date(now.getTime() - 7 * 86_400_000)), now, limit) });
      }
      try {
        const { from, to } = range(url, now, 7);
        const user = url.searchParams.get("user")?.trim();
        const report = turnsReport(o.audit.since(new Date(Math.min(from.getTime(), now.getTime() - 7 * 86_400_000))), now, 0);
        const rows = o.audit
          .since(from)
          .filter((e) => e.at < to.toISOString() && (!user || e.user === user))
          .map(turnRow)
          .filter((r): r is NonNullable<typeof r> => !!r);
        const totals = rows.reduce((t, r) => ({ turns: t.turns + 1, costUsd: t.costUsd + r.costUsd, sttUsd: t.sttUsd + r.sttUsd, tokensIn: t.tokensIn + r.tokens.in, tokensOut: t.tokensOut + r.tokens.out, unpriced: t.unpriced + r.unpriced }), { turns: 0, costUsd: 0, sttUsd: 0, tokensIn: 0, tokensOut: 0, unpriced: 0 });
        const { items, page } = pageFrom(rows, url);
        return send(200, { enabled: true, today: report.today, week: report.week, estimate: report.estimate, from: from.toISOString(), to: to.toISOString(), range: { ...totals, costUsd: Math.round(totals.costUsd * 1e6) / 1e6, sttUsd: Math.round(totals.sttUsd * 1e6) / 1e6 }, recent: items, page });
      } catch (e) {
        return send(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    // The audit log, newest first. The old way: ?month=YYYY-MM (default the current month), ?limit=N. Paged (any of
    // cursor, offset, from, to, user, action, outcome, q): every month on file, filtered, one page at a time.
    if (path === "/audit") {
      if (!o.audit) return send(200, { enabled: false, events: [] });
      try {
        const head = { enabled: true, retentionDays: o.audit.retentionDays, months: o.audit.months() };
        if (!pagedAsk(url, ["from", "to", "user", "action", "outcome", "q"])) {
          const events = o.audit.read({ month: url.searchParams.get("month") ?? undefined, limit: Number(url.searchParams.get("limit")) || 200 });
          return send(200, { ...head, events });
        }
        const ask = pageAsk(url, { limit: 50 });
        const f = (k: string) => url.searchParams.get(k)?.trim() || undefined;
        const [user, action, outcome, q] = [f("user"), f("action"), f("outcome"), f("q")?.toLowerCase()];
        const from = f("from") ? dateParam(url, "from") : new Date(0);
        const to = f("to") ? dateParam(url, "to") : undefined;
        const toIso = to?.toISOString();
        const keep = (e: AuditEvent) =>
          (!toIso || e.at < toIso) &&
          (!user || e.user === user) &&
          (!action || e.action === action || e.action.startsWith(`${action} `)) &&
          (!outcome || e.outcome === outcome) &&
          (!q || `${e.user} ${e.action} ${e.board ?? ""} ${e.detail ?? ""}`.toLowerCase().includes(q));
        const all = o.audit.since(from!).filter(keep);
        const { items, page } = pageOf(all, ask);
        return send(200, { ...head, events: items, page });
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
        // ?cursor= (a page's next or prev) works as everywhere; ?offset= as before.
        const at = url.searchParams.get("cursor") ? pageAsk(url, { limit: 500, max: 5000 }) : { offset: Number(url.searchParams.get("offset")) || 0, limit: Number(url.searchParams.get("limit")) || 500 };
        const page = await s.telemetry.read({ from, to, type: type as TelemetryLine["type"] | undefined, offset: at.offset, limit: at.limit });
        // User names only for a reader policy lets see them; else a stable stand-in per name.
        const records = may.usernames ? page.records : withoutNames(page.records, s.telemetry.hash);
        return send(200, { enabled: s.telemetry.enabled(), retentionDays: s.telemetryLog.retentionDays, fields: [...s.telemetry.fields()], usernames: may.usernames, from: from.toISOString(), to: (to ?? new Date()).toISOString(), ...page, records });
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
    // The deploy config's options an admin changes while the server runs (runtime-config.ts): each area's body names the
    // fields it changes, null hands one back. Applied from the next request on, logged and audited with who did it.
    if (path === "/settings/budget" || path === "/settings/audit" || path === "/settings/history" || path === "/settings/explain") {
      const area = path.slice("/settings/".length) as "budget" | "audit" | "history" | "explain";
      const r = s.runtime[area].update(b);
      if (!r.ok) return send(400, { error: r.error });
      if (area === "audit") o.audit?.prune?.();
      o.log(`${area}: ${r.detail} (by ${who.user})`);
      audit(`settings ${area}`, r.detail);
      return send(200, s.runtime[area].view(writable));
    }
    if (path === "/settings/models") {
      const r = s.runtime.models.update(b, o.providers.map((p) => p.name), s.settings.get<ChatSetting>("chat")?.model);
      if (!r.ok) return send(400, { error: r.error });
      o.log(`models: ${r.detail} (by ${who.user})`);
      audit("settings models", r.detail);
      return send(200, { ...s.runtime.models.view(o.providers, writable), chat: chatSettings() });
    }
    // The context labels for telemetry, as a whole: { context: { <board, dataset or role:name>: { campaign, … } } }, or
    // { context: null } for the config's.
    if (path === "/settings/context") {
      if (!("context" in b) || Object.keys(b).length !== 1) return send(400, { error: 'send { "context": { "<board, dataset or role:name>": { "campaign": "…" } } }, or { "context": null } for the deployment\'s' });
      if (b.context === null) s.settings.set("context", undefined);
      else {
        const parsed = deploymentContextSchema.safeParse(b.context);
        if (!parsed.success) return send(400, { error: `context: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}` });
        s.settings.set("context", parsed.data);
      }
      const n = Object.keys(s.context).length;
      o.log(`context: ${n} label${n === 1 ? "" : "s"}${b.context === null ? " (the deployment's)" : ""} (by ${who.user})`);
      audit("settings context", b.context === null ? "reset" : `${n} labels`);
      return send(200, s.contextView(writable));
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
      // are kept at all is the voice-audio field, switched on the Telemetry tab (PUT settings/telemetry) with a confirm step.
      if ("keepAudio" in b) return send(409, { error: 'keeping recordings is the voice-audio telemetry field: PUT settings/telemetry {"fields.voice-audio": true, "confirm": true}' });
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
      if ("maxSeconds" in b) {
        const v = b.maxSeconds;
        if (v === null || v === "") delete next.maxSeconds;
        else if (!whole(v, MAX_SECONDS)) return send(400, { error: `maxSeconds is a whole number of seconds from ${MAX_SECONDS.min} to ${MAX_SECONDS.max}` });
        else next.maxSeconds = v;
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
    // The switchboard: any of {"telemetry", "fields.<field>": true|false|null, "categories.<category>": true|false,
    // "retentionDays": n|null}; null puts a switch back to the deployment's value. A category turns on every field in it
    // that is not privacy-sensitive, or turns every one off. A privacy-sensitive field turns on only with "confirm": true.
    // Applied at once (every record reads the switches), audited, and answered with the checklist as it now stands.
    if (path === "/settings/telemetry") {
      const r = s.switches.update(b, who.user, { superset: !!o.supersetLogs });
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
    const offered = offeredModels(o.providers, s.runtime.models.offered());
    const p = offered.find((x) => x.name === b.model);
    if (!p) return send(400, { error: o.providers.some((x) => x.name === b.model) ? `"${String(b.model)}" is not offered: offer it first (PUT settings/models)` : `unknown model "${String(b.model)}": one of ${offered.map((x) => x.name).join(", ")}` });
    const effort = b.effort == null || b.effort === "" ? undefined : String(b.effort);
    if (effort && !p.efforts?.levels.includes(effort)) return send(400, { error: p.efforts ? `effort "${effort}" is not one ${p.name} takes: ${p.efforts.levels.join(", ")}` : `${p.name} has no effort setting` });
    s.settings.set("chat", { model: p.name, ...(effort ? { effort } : {}) });
    audit("settings chat", `${p.name}${effort ? ` (${effort})` : ""}`);
    o.log(`settings: chat model ${p.name}${effort ? ` (${effort})` : ""}`);
    return send(200, chatSettings());
  };
}

/** A date or time from the query (2026-11-01, or an ISO time); a bad one is a 400. */
function dateParam(url: URL, k: string): Date {
  const v = url.searchParams.get(k)!;
  // A bare day means that whole day: "to=2026-11-03" reads up to the end of the 3rd.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) && k === "to" ? `${v}T24:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw new PageError(`${k} must be a date or time, like 2026-11-01`);
  return d;
}

/** ?from= and ?to= (to defaults to now, from to `days` before to). */
function range(url: URL, now: Date, days: number) {
  const to = url.searchParams.get("to") ? dateParam(url, "to") : now;
  const from = url.searchParams.get("from") ? dateParam(url, "from") : new Date(to.getTime() - days * 86_400_000);
  return { from, to };
}
