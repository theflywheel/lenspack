// Speech to text for the chat's mic. The browser records a short clip and
// posts it to POST /api/_stt; this module sends it to an OpenAI-style
// transcription endpoint (OpenRouter's /audio/transcriptions by default) and
// returns the text for the user to check before sending. The key stays on the
// server, and the model is whatever the deployment's settings say, so any
// transcription model the provider lists can be swapped in without a release.

import type { CallRecord } from "./metering";

/** Measured best all-rounder for French (incl. African-accented), English and Hindi; safe without a language hint. */
export const DEFAULT_SPEECH_MODEL = "mistralai/voxtral-mini-transcribe-3-0";
export const DEFAULT_SPEECH_BASE_URL = "https://openrouter.ai/api/v1";

export type SpeechOptions = {
  /** The provider key. Absent: speech is off (the mic hides, POST /api/_stt answers 503). */
  apiKey?: string;
  /** The name of the environment variable the key came from, for a settings page; never the key. */
  keyFrom?: string | null;
  baseUrl?: string;
  /** The model to use now. A function, so a settings change applies on the next clip. */
  model: () => string;
  /** Largest clip accepted, in bytes. A minute of opus is well under 1 MB. */
  maxBytes?: number;
  /** Longest clip the browser should record, in seconds; told to the client. */
  maxSeconds?: number;
  fetch?: typeof fetch;
};

export type Transcript = { text: string; model: string; language: string | null; seconds: number | null; usd: number | null; ms: number };

/** A clip's MIME type as the provider's `format`. MediaRecorder gives webm/opus (Chrome, Firefox) or mp4/aac (Safari). */
export function audioFormat(contentType: string | undefined): string | null {
  const t = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    "audio/webm": "webm",
    "video/webm": "webm",
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/m4a": "m4a",
    "audio/aac": "aac",
    "audio/flac": "flac",
  };
  return map[t] ?? null;
}

/** A BCP 47 primary language ("fr", "hi", "en", optionally "fr-FR"): what a `language` hint may be. */
export const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2})?$/;

/** A provider's model id: "vendor/model" with the characters OpenRouter uses. */
export const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/;

/** Transcribes one clip. `language` is a hint; leave it out to let the model detect the language. */
export async function transcribe(opts: SpeechOptions, audio: Uint8Array, contentType: string | undefined, language?: string): Promise<Transcript> {
  if (!opts.apiKey) throw new SpeechError(503, "speech to text is not configured on this server");
  const format = audioFormat(contentType);
  if (!format) throw new SpeechError(415, `unsupported audio type ${contentType ?? "(none)"}`);
  if (audio.byteLength === 0) throw new SpeechError(400, "empty clip");
  if (audio.byteLength > (opts.maxBytes ?? 10_000_000)) throw new SpeechError(413, "clip too long");
  if (language !== undefined && !LANGUAGE.test(language)) throw new SpeechError(400, `bad language ${language}`);
  const model = opts.model();
  const body: Record<string, unknown> = { model, input_audio: { data: Buffer.from(audio).toString("base64"), format } };
  if (language) body.language = language.split("-")[0];
  const started = Date.now();
  const res = await (opts.fetch ?? fetch)(`${(opts.baseUrl ?? DEFAULT_SPEECH_BASE_URL).replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", "x-title": "lenspack" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const ms = Date.now() - started;
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new SpeechError(502, `transcription failed (${res.status}): ${detail}`, ms);
  }
  const j = (await res.json()) as { text?: string; language?: string; usage?: { seconds?: number; cost?: number } };
  return { text: (j.text ?? "").trim(), model, language: j.language ?? (language ? language.split("-")[0]! : null), seconds: j.usage?.seconds ?? null, usd: j.usage?.cost ?? null, ms };
}

export class SpeechError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly ms = 0,
  ) {
    super(message);
  }
}

/** A transcription as a usage record, so speech shows on the usage page and counts against the budget. */
export function speechRecord(t: Pick<Transcript, "model" | "usd" | "ms"> & { ok?: boolean; error?: string }, who: { user?: string; pack?: string }): CallRecord {
  return {
    at: new Date().toISOString(),
    role: "speech",
    user: who.user,
    pack: who.pack,
    provider: "speech",
    model: t.model,
    kind: "transcription",
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    usd: t.usd,
    priced: t.usd !== null,
    ms: t.ms,
    ok: t.ok ?? true,
    ...(t.error ? { error: t.error } : {}),
  };
}

export type SpeechModel = { id: string; name: string; usdPerMinute: number | null };

/** Used when the provider's list cannot be fetched: the models measured for fr/en/hi. */
export const FALLBACK_SPEECH_MODELS: SpeechModel[] = [
  { id: "mistralai/voxtral-mini-transcribe-3-0", name: "Mistral: Voxtral Mini Transcribe 3.0", usdPerMinute: 0.0035 },
  { id: "google/gemini-3.5-transcribe", name: "Google: Gemini 3.5 Transcribe", usdPerMinute: null },
  { id: "openai/gpt-transcribe", name: "OpenAI: GPT Transcribe", usdPerMinute: 0.0045 },
  { id: "elevenlabs/scribe-v2", name: "ElevenLabs: Scribe v2", usdPerMinute: 0.0037 },
];

let cached: { at: number; models: SpeechModel[] } | null = null;

/**
 * The transcription models OpenRouter lists (a public endpoint, no key), cached
 * for an hour; the fallback list when it cannot be reached. A per-second
 * prompt price is shown per minute; token-priced models show null.
 */
export async function speechModels(opts: Pick<SpeechOptions, "baseUrl" | "fetch"> = {}, now = Date.now()): Promise<{ models: SpeechModel[]; live: boolean }> {
  if (cached && now - cached.at < 3_600_000) return { models: cached.models, live: true };
  try {
    const res = await (opts.fetch ?? fetch)(`${(opts.baseUrl ?? DEFAULT_SPEECH_BASE_URL).replace(/\/+$/, "")}/models?output_modalities=transcription`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { data: { id: string; name?: string; pricing?: { prompt?: string; completion?: string } }[] };
    const models = j.data
      .filter((m) => MODEL_ID.test(m.id))
      .map((m) => {
        const perSecond = Number(m.pricing?.prompt);
        // Per-second pricing has no completion price; a token-priced model's prompt price is per token.
        const bySecond = Number.isFinite(perSecond) && Number(m.pricing?.completion ?? 0) === 0;
        return { id: m.id, name: m.name ?? m.id, usdPerMinute: bySecond ? Math.round(perSecond * 60 * 1e5) / 1e5 : null };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    if (models.length === 0) throw new Error("empty list");
    cached = { at: now, models };
    return { models, live: true };
  } catch {
    return { models: FALLBACK_SPEECH_MODELS, live: false };
  }
}

/** Whether a model id may be set: on the provider's list when it could be read, else any well-formed id. */
export async function speechModelAllowed(id: string, opts: Pick<SpeechOptions, "baseUrl" | "fetch"> = {}): Promise<boolean> {
  if (!MODEL_ID.test(id)) return false;
  const { models, live } = await speechModels(opts);
  return live ? models.some((m) => m.id === id) : true;
}

/** The key and the variable it came from: LENSPACK_STT_API_KEY first, then OPENROUTER_API_KEY. */
export function speechKeyFromEnv(env = process.env): { apiKey?: string; keyFrom: string | null } {
  for (const name of ["LENSPACK_STT_API_KEY", "OPENROUTER_API_KEY"]) if (env[name]) return { apiKey: env[name], keyFrom: name };
  return { keyFrom: null };
}
