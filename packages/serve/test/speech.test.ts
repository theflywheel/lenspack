import { type Server, createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { type CallRecord, DEFAULT_SPEECH_MODEL, addUsageSink, audioFormat, createApp, speechKeyFromEnv, speechModels, transcribe, usageLedger } from "../src";

// A stand-in for the provider: records each request and answers as OpenRouter does.
function fakeProvider(answer: (body: any) => { status?: number; json?: unknown; text?: string }) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const a = answer(body);
    return new Response(a.text ?? JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

const clip = new Uint8Array([26, 69, 223, 163, 1, 2, 3]); // a few bytes; the fake provider never decodes them

describe("transcribe", () => {
  it("sends the clip as base64 with the format, the model from settings and the language hint", async () => {
    const { f, calls } = fakeProvider(() => ({ json: { text: " montre les doses par district ", usage: { seconds: 2.5, cost: 0.0002 } } }));
    let model = DEFAULT_SPEECH_MODEL;
    const opts = { apiKey: "k", model: () => model, fetch: f };
    const t = await transcribe(opts, clip, "audio/webm;codecs=opus", "fr-FR");
    expect(t).toMatchObject({ text: "montre les doses par district", model: DEFAULT_SPEECH_MODEL, language: "fr", seconds: 2.5, usd: 0.0002 });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(calls[0]!.headers.authorization).toBe("Bearer k");
    expect(calls[0]!.body).toEqual({ model: DEFAULT_SPEECH_MODEL, input_audio: { data: Buffer.from(clip).toString("base64"), format: "webm" }, language: "fr" });
    // A settings change applies to the next clip.
    model = "google/gemini-3.5-transcribe";
    await transcribe(opts, clip, "audio/mp4");
    expect(calls[1]!.body.model).toBe("google/gemini-3.5-transcribe");
    expect(calls[1]!.body.input_audio.format).toBe("m4a");
    // No hint: auto-detect.
    expect("language" in calls[1]!.body).toBe(false);
  });

  it("refuses what it cannot send, before any call", async () => {
    const { f, calls } = fakeProvider(() => ({ json: { text: "x" } }));
    const opts = { apiKey: "k", model: () => DEFAULT_SPEECH_MODEL, fetch: f };
    await expect(transcribe({ ...opts, apiKey: undefined }, clip, "audio/webm")).rejects.toMatchObject({ status: 503 });
    await expect(transcribe(opts, clip, "text/plain")).rejects.toMatchObject({ status: 415 });
    await expect(transcribe(opts, new Uint8Array(), "audio/webm")).rejects.toMatchObject({ status: 400 });
    await expect(transcribe({ ...opts, maxBytes: 3 }, clip, "audio/webm")).rejects.toMatchObject({ status: 413 });
    await expect(transcribe(opts, clip, "audio/webm", "french; drop")).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it("reports a provider failure as 502 with its status", async () => {
    const { f } = fakeProvider(() => ({ status: 400, text: '{"error":{"message":"Audio data does not appear to be in a supported encoding"}}' }));
    await expect(transcribe({ apiKey: "k", model: () => "google/chirp-3", fetch: f }, clip, "audio/wav")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("(400)") });
  });

  it("maps MediaRecorder types to formats", () => {
    expect(audioFormat("audio/webm;codecs=opus")).toBe("webm");
    expect(audioFormat("audio/ogg; codecs=opus")).toBe("ogg");
    expect(audioFormat("audio/mp4")).toBe("m4a");
    expect(audioFormat("AUDIO/WAV")).toBe("wav");
    expect(audioFormat(undefined)).toBeNull();
  });
});

describe("speechModels", () => {
  it("lists the provider's transcription models with a per-minute price, and falls back when it cannot", async () => {
    const { f } = fakeProvider(() => ({
      json: {
        data: [
          { id: "mistralai/voxtral-mini-transcribe-3-0", name: "Voxtral", pricing: { prompt: "0.0000583333", completion: "0" } },
          { id: "openai/gpt-4o-mini-transcribe", name: "4o mini", pricing: { prompt: "0.00000125", completion: "0.000005" } },
        ],
      },
    }));
    const { models, live } = await speechModels({ fetch: f, baseUrl: "http://one" }, 1);
    expect(live).toBe(true);
    expect(models).toEqual([
      { id: "mistralai/voxtral-mini-transcribe-3-0", name: "Voxtral", usdPerMinute: 0.0035 },
      { id: "openai/gpt-4o-mini-transcribe", name: "4o mini", usdPerMinute: null },
    ]);
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    // Past the hour's cache, an unreachable list gives the fallback.
    const again = await speechModels({ fetch: down }, 1 + 3_600_001);
    expect(again.live).toBe(false);
    expect(again.models.map((m) => m.id)).toContain(DEFAULT_SPEECH_MODEL);
  });
});

describe("speechKeyFromEnv", () => {
  it("names the variable the key came from, preferring the dedicated one", () => {
    expect(speechKeyFromEnv({ OPENROUTER_API_KEY: "a", LENSPACK_STT_API_KEY: "b" })).toEqual({ apiKey: "b", keyFrom: "LENSPACK_STT_API_KEY" });
    expect(speechKeyFromEnv({ OPENROUTER_API_KEY: "a" })).toEqual({ apiKey: "a", keyFrom: "OPENROUTER_API_KEY" });
    expect(speechKeyFromEnv({})).toEqual({ keyFrom: null });
  });
});

describe("POST /api/_stt", () => {
  let server: Server | undefined;
  let remove: (() => void) | undefined;
  afterEach(() => {
    server?.close();
    remove?.();
  });
  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
  };

  it("transcribes a clip, meters it, and says the mic is on", async () => {
    const { f, calls } = fakeProvider(() => ({ json: { text: "दिखाओ", usage: { seconds: 1, cost: 0.0001 } } }));
    const ledger = usageLedger();
    const seen: CallRecord[] = [];
    remove = addUsageSink({ record: (r) => seen.push(r) });
    const base = await listen(createApp([], { ledger, speech: { apiKey: "k", model: () => DEFAULT_SPEECH_MODEL, fetch: f, maxSeconds: 45 } }));
    expect((await (await fetch(base)).json()).speech).toEqual({ maxSeconds: 45 });
    const res = await fetch(`${base}/_stt?language=hi&pack=hcm`, { method: "POST", headers: { "content-type": "audio/webm" }, body: clip });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: "दिखाओ", language: "hi", usd: 0.0001 });
    expect(calls[0]!.body.language).toBe("hi");
    // Once, to the ledger and the process-wide sink alike.
    expect(seen.filter((r) => r.role === "speech")).toHaveLength(1);
    expect(seen[0]).toMatchObject({ role: "speech", pack: "hcm", model: DEFAULT_SPEECH_MODEL, usd: 0.0001, ok: true });
    expect(ledger.report().total.usd).toBeCloseTo(0.0001);
  });

  it("answers 503 without a key, and the listing says the mic is off", async () => {
    const base = await listen(createApp([], { speech: { model: () => DEFAULT_SPEECH_MODEL } }));
    expect((await (await fetch(base)).json()).speech).toBeNull();
    const res = await fetch(`${base}/_stt`, { method: "POST", headers: { "content-type": "audio/webm" }, body: clip });
    expect(res.status).toBe(503);
  });

  it("refuses a clip over the size limit without calling the provider", async () => {
    const { f, calls } = fakeProvider(() => ({ json: { text: "x" } }));
    const base = await listen(createApp([], { speech: { apiKey: "k", model: () => DEFAULT_SPEECH_MODEL, fetch: f, maxBytes: 4 } }));
    const res = await fetch(`${base}/_stt`, { method: "POST", headers: { "content-type": "audio/webm" }, body: clip }).catch(() => null);
    // The server may close the socket mid-upload; either way nothing reaches the provider.
    if (res) expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("stops at the budget before transcribing", async () => {
    const { f, calls } = fakeProvider(() => ({ json: { text: "x" } }));
    const ledger = usageLedger();
    ledger.record({ at: new Date().toISOString(), role: "build", provider: "p", model: "m", kind: "k", inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, usd: 5, priced: true, ms: 1, ok: true });
    const base = await listen(createApp([], { ledger, budget: { usdPerDay: 1 }, speech: { apiKey: "k", model: () => DEFAULT_SPEECH_MODEL, fetch: f } }));
    const res = await fetch(`${base}/_stt`, { method: "POST", headers: { "content-type": "audio/webm" }, body: clip });
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(0);
  });
});
