# Speech-to-text evaluation

How the chat mic's default model (`mistralai/voxtral-mini-transcribe-3-0`) was chosen, and how to rerun the
comparison on new clips. Run on 2026-11-22 against OpenRouter's `/api/v1/audio/transcriptions`. The whole run,
with and without a language hint, cost $1.51 as OpenRouter reported it.

## Data

| set | source | licence | clips | audio |
|---|---|---|---|---|
| Niger | [OpenSLR SLR57](https://www.openslr.org/57/) African Accented French, dev split (West African French) | Apache 2.0 | 80 from 23 speakers | 4.6 min |
| Central Africa | SLR57 test split, CA16 recordings (Gabon 40, Cameroon 24, Chad 8, Congo 8) | Apache 2.0 | 80 | 3.5 min |
| FLEURS fr | [Google FLEURS](https://huggingface.co/datasets/google/fleurs) `fr_fr` test | CC BY 4.0 | 25 | 4.7 min |
| FLEURS hi | FLEURS `hi_in` test | CC BY 4.0 | 25 | 5.3 min |

All four sets are read speech. The SLR57 clips are spread round-robin across speakers, and the FLEURS clips are the
first ones in the test archive. `data/manifest.jsonl` lists every clip with its reference text. The audio is not
in the repo: `fetch_audio.py` streams the archives, keeps only the listed clips and deletes them afterwards.

## Method

- **WER** with [jiwer](https://github.com/jitsi/jiwer), after normalising both sides: lower case, punctuation and
  the danda removed, apostrophes split, and French digits 0–10 written as words. Hindi numbers are not normalised.
- **With and without the hint.** Every model ran with `language` set to the clip's language. Each model also ran
  without it (auto-detect) on Niger and both FLEURS sets. OpenRouter returns no detected-language field, so the
  language of the output is read off the text: Devanagari is hi, Arabic script is ur, and for Latin script French,
  English and romanised-Hindi function words decide.
- **Latency** is the wall-clock time of one request from the 16c box: the median per model, and RTF (time ÷ audio
  length) over the run.
- **Cost** is OpenRouter's reported `usage.cost` summed over the hinted run, divided by the 18.1 minutes of audio.

## Results, with the language hint

| model | Central Africa WER | Niger WER | FLEURS fr WER | FLEURS hi WER | median latency (s) | RTF | $ per audio min |
| --- | --- | --- | --- | --- | --- | --- | --- |
| assemblyai/universal-3-6-pro | 6.6% | 8.5% | 3.9% | 9.4% | 0.37 | 0.09 | 0.0050 |
| deepgram/nova-3 | 5.1% | 8.6% | 7.5% | 14.0% | 0.65 | 0.15 | 0.0043 |
| elevenlabs/scribe-v2 | 7.5% | 8.6% | 3.0% | 11.7% | 0.75 | 0.17 | 0.0037 |
| google/chirp-3 | 6.4% | 9.6% | 3.9% | 7.8% | 1.91 | 0.43 | 0.0173 |
| google/gemini-3.5-transcribe | 7.7% | 8.6% | 3.4% | 7.4% | 2.31 | 0.45 | 0.0053 |
| **mistralai/voxtral-mini-transcribe-3-0** | 6.4% | 9.1% | 3.5% | 8.2% | 0.67 | 0.15 | 0.0032 |
| nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b | 7.5% | 11.1% | 12.1% | 13.3% | 1.33 | 0.28 | 0.0002 |
| openai/gpt-4o-mini-transcribe | 10.3% | 14.6% | 4.2% | 13.6% | 0.85 | 0.18 | 0.0018 |
| openai/gpt-transcribe | 5.5% | 8.2% | 3.7% | 10.4% | 0.84 | 0.18 | 0.0049 |
| openai/whisper-large-v3-turbo | 9.2% | 13.9% | 7.9% | 61.9% | 1.41 | 0.40 | 0.0003 |
| qwen/qwen3-asr-1.7b | 4.0% | 8.6% | 4.2% | 13.7% | 0.80 | 0.47 | 0.0004 |
Every model finished with no errors, after the reruns noted below. FLEURS has 25 clips per language, so a gap of
a point or two there is within noise.

## With and without the hint

| model | Niger | FLEURS fr | FLEURS hi | output language without the hint |
|---|---|---|---|---|
| **voxtral-mini-transcribe-3-0** | 9.1 → 9.6% | 3.5 → 3.3% | 8.2 → 8.0% | 72/80 fr; 25/25 fr; 25/25 hi |
| gemini-3.5-transcribe | 8.6 → 10.3% | 3.4 → 3.0% | 7.4 → 6.9% | 71/80 fr; 25/25 fr; 25/25 hi |
| gpt-transcribe | 8.2 → 10.3% | 3.7 → 4.1% | 10.4 → 10.1% | 72/80 fr; 25/25 fr; 25/25 hi |
| elevenlabs scribe-v2 | 8.6 → 9.4% | 3.0 → 3.3% | 11.7 → 11.6% | 70/80 fr; 25/25 fr; 25/25 hi |
| qwen3-asr-1.7b | 8.6 → 8.9% | 4.2 → 4.3% | 13.7 → 13.0% | 72/80 fr; 25/25 fr; 25/25 hi |
| chirp-3 | 9.6 → 9.7% | 3.9 → 4.3% | 7.8 → 7.2% | 72/80 fr; 25/25 fr; 25/25 hi |
| assemblyai universal-3-6-pro | 8.5 → **13.9%** | 3.9 → 4.1% | 9.4 → 9.3% | 68/80 fr, 3 en, 1 ur; 25/25 fr; 25/25 hi |
| gpt-4o-mini-transcribe | 14.6 → 16.2% | 4.2 → 4.6% | 13.6 → 11.9% | 67/80 fr; 25/25 fr; 25/25 hi |
| nemotron-3.5-asr 0.6b | 11.1 → 11.9% | 12.1 → 11.7% | 13.3 → 15.3% | 71/80 fr; 25/25 fr; 25/25 hi |
| whisper-large-v3-turbo | 13.9 → 17.4% | 7.9 → 16.4% | 61.9 → **75.0%** | 66/80 fr, 4 en; 23/25 fr; **12/25 hi, 5 ur** |
| deepgram nova-3 | 8.6 → **97.1%** | 7.5 → **96.0%** | 14.0 → **100.3%** | mostly empty or English |

Where the language counts don't add up, the rest are clips too short to classify (one- or two-word answers).
`score_detect.py` prints the full breakdown.

## Notable failures

- **Deepgram Nova-3 without a hint** falls back to English. It returned empty text on 75 of 130 clips (47 Niger,
  18 FLEURS fr, 10 FLEURS hi) and English for most of the rest, so WER was 96–100%. With the hint it is
  competitive. Since Auto sends no hint, it can't be the default.
- **Whisper large-v3-turbo writes Hindi in Urdu script.** Without the hint, 5 of 25 Hindi clips came back in
  Arabic script. The words are right, but they don't match the Devanagari reference.
- **Empty Hindi output.** Whisper also returned nothing for 8 of 25 Hindi clips with the hint, and 7 without.
  That is most of its 62–75% WER.
- **32-bit float WAV is refused.** FLEURS ships float WAV. Chirp 3 and AssemblyAI answered "Audio data does not
  appear to be in a supported encoding" until the clips were converted to 16-bit PCM and rerun.
  `fetch_audio.py` now converts them. The browser sends webm/opus or mp4, so the product doesn't hit this.
- **Whisper on the CPU is too slow.** faster-whisper large-v3-turbo (int8, 8 threads) on the shared 16-core box
  took about 21 s per 5 s clip (RTF about 6). That rules out self-hosting on the current hardware.

## Why Voxtral is the default

- It is in the top group on all four sets: 6.4 / 9.1 / 3.5 / 8.2% WER.
- It is barely affected by a missing hint, which matters because Auto sends none: Niger 9.6%, FLEURS fr 3.3%,
  FLEURS hi 8.0%, and every FLEURS clip came back in the right language.
- It answers in 0.67 s median, the third-fastest model in the comparison.
- Of the four models under 10% WER on Hindi, it is the cheapest: $0.0035 per minute at list price, so under half a
  cent for a minute of speech.

**Alternatives, chosen in Settings → AI assistant:**
- `google/gemini-3.5-transcribe` had the best Hindi (7.4%, or 6.9% with no hint) and good French, but it is 3–4
  times slower (2.3 s). Pick it where Hindi matters more than speed.
- `openai/gpt-transcribe` and `qwen/qwen3-asr-1.7b` did best on accented French (Niger 8.2%, Central 4.0%), but
  their Hindi is weaker.

## Rerunning it

```sh
cd bench/stt
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -I fetch_audio.py                     # the published sample
OPENROUTER_API_KEY=... .venv/bin/python -I stt_bench.py data/manifest.jsonl --systems or:mistralai/voxtral-mini-transcribe-3-0
OPENROUTER_API_KEY=... .venv/bin/python -I stt_bench.py data/manifest.jsonl --systems or:mistralai/voxtral-mini-transcribe-3-0 --nohint
.venv/bin/python -I score.py                            # the WER and latency table
.venv/bin/python -I score_detect.py data/manifest.jsonl # hint vs no hint, and the output language
.venv/bin/python -I fetch_audio.py --delete
```

Take the key from a secret store for the one command, and never write it to a file.

`stt_bench.py` is resumable: it skips clips already in a model's results file, and it stops after five errors in a
row (a bad key, model id or language) so a mistake doesn't keep spending. `--systems local:large-v3-turbo` runs
faster-whisper on the CPU instead (uncomment it in `requirements.txt`).

**On your own voice notes:** put the clips in a folder, in any format ffmpeg reads (phone m4a, ogg and opus are
fine). Next to them, write `refs.tsv` with one line per clip: `<file name>\t<fr|en|hi>\t<what was said>`. Then:

```sh
.venv/bin/python -I folder_manifest.py ~/voice-notes ~/voice-notes/refs.tsv > data/own.jsonl
OPENROUTER_API_KEY=... .venv/bin/python -I stt_bench.py data/own.jsonl --systems or:mistralai/voxtral-mini-transcribe-3-0,or:google/gemini-3.5-transcribe --nohint
.venv/bin/python -I score.py data/own.jsonl
```

`data/own.jsonl`, the converted audio and `results/` from such a run stay local. Commit results only if the
references hold nothing private.

## Not verified yet

- **Real transcription through the product.** `POST /api/_stt` is tested against a stub provider. The deployed
  stack has no speech-to-text key yet, so no live clip has gone mic → server → OpenRouter → input.
- **Field voice notes in the domain.** These sets are clean read speech. Voice notes from dashboard users have
  room noise, phone microphones, dashboard vocabulary (place names, indicator names, numbers) and code-switching,
  and WER will be higher. A small set of such notes, rerun as above, is the next check.
