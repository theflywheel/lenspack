# Voice

This page describes the mic in the chat: how people talk to it, where the audio goes, what it costs and how to
turn it off. It is for admins and for people using the chat.

The mic is in the chat panel inside Superset. The standalone server has the transcription route, but its board app
has no mic yet; a client of your own can use the route directly (see [below](#the-route)).

## Talking

- **Click** the mic to start and click again to stop, or **hold** it and release to stop.
- **Hold Space** for 2 seconds to talk, even while typing in the panel. A shorter press types a space, and the mic
  button fills up to show the hold. Space is left alone in Superset's own fields, on buttons and other controls,
  during IME composition and with a modifier key. The hold time is `speech.holdMs` (500 to 3,000 ms, 2,000 by
  default), and each person can pick their own in the menu.
- Recording shows a timer and a level meter, and stops at `speech.maxSeconds` (60 by default).
- **The text lands in the input to check before sending.** Nothing is sent until the person sends it.

Browsers allow the mic only on https pages or on localhost.

## Where the audio goes

The clip goes to Lenspack (`POST /api/_stt`), which sends it to an OpenAI-style transcription endpoint (OpenRouter
by default) and returns the text. The model is `speech.model`, by default `mistralai/voxtral-mini-transcribe-3-0`.

When the person picked a language, it is sent as a hint, and a transcript in another script is refused (`422
wrong_script`) rather than shown. With no pick, the panel names the languages it expects; a transcript outside them
is tried once more with a fallback language, and refused (`422 unsure_language`) if still wrong.

Audio is not kept by default. See [Privacy and data handling](../operating/privacy.md).

## The key

`LENSPACK_STT_API_KEY`, else `OPENROUTER_API_KEY`, on Lenspack's server only. Without one the mic is hidden and
`/api/_stt` answers 503.

## Cost

Transcriptions are metered as their own role (`speech`), included in the turn's cost line when the text is sent,
and counted against the daily budget. An over-budget request answers 429. The settings page lists the provider's
transcription models with a price per minute.

## Settings

`speech.model`, `speech.holdMs` and `speech.maxSeconds` in `superset.yaml` are defaults. An admin can change the
model and hold time on a running server from Superset's Settings → AI assistant page. See
[Settings and switches in Superset](../hosts/superset/settings.md#voice-and-language).

## Turning it off

- `voice` off: no mic, and `/api/_stt` answers 503 (the key is withheld).
- `spaceHold` off: holding Space does not talk; the mic button still does.

See [Feature switches](../operating/switches.md).

## The route

`POST /api/_stt?language=&pack=&expected=&fallback=` with the raw audio as the body (up to 10 MB). It returns
`{ text, model, … , clip }`; send the `clip` id with the chat request that carries the text, and the turn's cost
includes the clip. See [HTTP API](../reference/http-api.md#speech).

---

**Next:** [Languages](languages.md).

**Related:** [Languages](languages.md) · [Costs](../operating/costs.md)
