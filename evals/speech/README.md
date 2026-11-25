# Speech to text

Lenspack's chat panel has a microphone. A spoken question is sent to a speech-to-text model, and the text that comes
back goes into the chat box for the user to check and send. This folder measures how well each model turns speech into
the right words, so a deployment can choose one.

It runs any model offered on [OpenRouter](https://openrouter.ai/)'s transcription endpoint, or Whisper on your own
CPU, over a fixed set of public recordings. For each model it reports:

- **word error rate (WER):** the share of words in the transcript that differ from what was said;
- **latency:** how long the model took to answer;
- **cost:** as OpenRouter reports it;
- **with and without a language hint:** whether the model gets the right words when it isn't told the language.

The last matters because a panel set to "Auto" sends no hint.

## Results

The published results and the full write-up (method, findings, and which model Lenspack uses by default) are in
[egovernments/innovations, `nl-dashboard/evals/speech`](https://github.com/egovernments/innovations/tree/570b1e4/nl-dashboard/evals/speech).
In short, Mistral's Voxtral Mini Transcribe 3.0 is the default. On these clips it has a 2.3–9.1% word error rate and
costs $0.0032 per audio minute, and it loses little accuracy without the language hint.

## The recordings

The clips are read speech: people reading a given sentence aloud. [`data/manifest.jsonl`](data/manifest.jsonl) lists
315 clips, one per line, with:
- the clip's id, set and language;
- the speaker, where the dataset gives one (as a short hash for Common Voice);
- the audio file's path;
- the reference text, which is what was said;
- the clip's length in seconds.

The audio itself is not in this repository. [`fetch_audio.py`](fetch_audio.py) downloads it from the original
datasets.

| Set | What it is | Source | Clips | Audio |
|---|---|---|---|---|
| `slr57-niger` | French with a West African accent (Niger) | African Accented French, dev split | 80, from 23 speakers | 4.6 min |
| `slr57-central` | French with a Central African accent: Gabon, Cameroon, Chad, Congo | African Accented French, test split | 80 | 3.5 min |
| `fleurs-fr` | French (France) | FLEURS `fr_fr`, test split | 25 | 4.7 min |
| `fleurs-hi` | Hindi | FLEURS `hi_in`, test split | 25 | 5.3 min |
| `fleurs-pt` | Brazilian Portuguese | FLEURS `pt_br`, test split | 25 | 5.7 min |
| `cv-pt-pt` | European Portuguese | Common Voice 22.0, test split, speakers who chose "Portuguese (Portugal)" or named Lisbon or Porto as their accent | 40, from 37 speakers | 3.4 min |
| `cv-pt-br` | Brazilian Portuguese | Common Voice 22.0, test split, "Portuguese (Brasil)" | 40, from 40 speakers | 3.5 min |

- **How the clips were chosen.** The African Accented French and Common Voice clips are taken in turn across
  speakers, so no one voice dominates. [`pick_pt.py`](pick_pt.py) chose the Portuguese ones and can choose them again.
  The FLEURS clips are the first 25 in each test archive.
- **Format.** FLEURS ships 32-bit float WAV, which some providers refuse, so `fetch_audio.py` rewrites those clips as
  16-bit PCM. Common Voice clips stay mp3, which is closer to what a browser sends.
- **Coverage.** No open dataset we found labels Mozambican or Angolan speakers, so European Portuguese stands in for
  the Portuguese spoken there.

## Running it

You need Python 3 and [ffmpeg](https://ffmpeg.org/). Work from this folder:

```sh
cd evals/speech
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -I fetch_audio.py              # downloads the clips into data/
```

`fetch_audio.py --sets fleurs-pt,cv-pt-pt,cv-pt-br` downloads only some sets. The African Accented French archive is
1.8 GB, but it is streamed and only the listed clips are kept.

Then transcribe with one or more models (comma-separated), with the hint and without it:

```sh
export OPENROUTER_API_KEY=...                   # from your secret store; never write it to a file
.venv/bin/python -I stt_bench.py data/manifest.jsonl --systems or:mistralai/voxtral-mini-transcribe-3-0
.venv/bin/python -I stt_bench.py data/manifest.jsonl --systems or:mistralai/voxtral-mini-transcribe-3-0 --nohint
```

- Each model's transcripts go to `results/<model>.jsonl` (`…__nohint.jsonl` without the hint): one line per clip
  with the transcript, the time taken, and OpenRouter's usage and cost. `results/` is ignored by git.
- A run can be stopped and started again: clips already in a model's file are skipped.
- It stops after 5 failed requests in a row, such as a key without credit.
- `--sets fleurs-pt,cv-pt-pt` limits a run to some sets, and `--limit 10` to the first clips.
- One pass of one model over all 315 clips cost between $0.01 and $0.53 in our run: Voxtral about $0.10, Google
  Chirp 3 the most.

Score them:

```sh
.venv/bin/python -I score.py                            # WER per model and set, latency, errors (a markdown table)
.venv/bin/python -I score_detect.py data/manifest.jsonl # with vs without the hint, and which language came back
.venv/bin/python -I per_clip.py .                       # results/per_clip.csv: every clip's reference, transcript and WER
.venv/bin/python -I fetch_audio.py --delete             # remove the audio when done
```

- **How WER is computed.** `score.py` lower-cases both texts, strips punctuation and splits words at apostrophes (so
  "l'homme" and "l' homme" score the same). In French and Portuguese it writes the digits 0 to 10 as words. A model
  isn't penalised for formatting alone.
- **Detecting the language.** OpenRouter does not say which language a model detected. `score_detect.py` reads it off
  the transcript: from the script (Devanagari, Arabic, Latin…) and, for Latin text, from common function words in
  French, English, Portuguese, Spanish and romanised Hindi.

### Without OpenRouter

`--systems local:large-v3-turbo` runs Whisper on your CPU through faster-whisper, with no key and no cost. Uncomment
the extra packages in `requirements.txt` first. `BENCH_THREADS` sets the CPU threads (8 by default). It is slow: in our
test it took several times as long as the audio.

### On your own recordings

Recordings from your own users (phones, room noise, your place names) tell you more than read speech does.

1. Put the clips in a folder. Any format ffmpeg reads works, including the m4a, ogg and opus files phones make.
2. In the same folder, write `refs.tsv` with one line per clip: `<file name>`, a tab, the language code (`fr`, `en`,
   `hi`, `pt`…), a tab, then exactly what was said.
3. Run:

```sh
.venv/bin/python -I folder_manifest.py ~/voice-notes ~/voice-notes/refs.tsv > data/own.jsonl
.venv/bin/python -I stt_bench.py data/own.jsonl --systems or:mistralai/voxtral-mini-transcribe-3-0 --nohint
.venv/bin/python -I score.py data/own.jsonl
```

`folder_manifest.py` converts each clip to 16 kHz mono WAV under `data/own_wav/`, so every model gets the same input.
`data/own.jsonl`, the converted audio and the results are all ignored by git. Recordings of real users can hold
personal information, so keep them out of the repository.

## API keys

| Variable | Needed for | Where |
|---|---|---|
| `OPENROUTER_API_KEY` | any `or:<model>` system | an OpenRouter key with credit, https://openrouter.ai/keys |

Nothing else is needed. The datasets download without an account, and the local Whisper system needs no key.

## Files

| File | What it does |
|---|---|
| [`fetch_audio.py`](fetch_audio.py) | downloads the clips in the manifest, and `--delete` removes them |
| [`stt_bench.py`](stt_bench.py) | sends each clip to each model and writes the transcripts to `results/` |
| [`score.py`](score.py) | word error rate per model and set, latency and errors |
| [`score_detect.py`](score_detect.py) | accuracy with and without the language hint, and the language each transcript came back in |
| [`per_clip.py`](per_clip.py) | one row per clip, model and pass in `results/per_clip.csv` |
| [`pick_pt.py`](pick_pt.py) | chooses the Portuguese clips and prints their manifest lines |
| [`folder_manifest.py`](folder_manifest.py) | builds a manifest from a folder of your own recordings |
| [`data/manifest.jsonl`](data/manifest.jsonl) | the 315 clips and what was said in each |
| [`requirements.txt`](requirements.txt) | Python packages |

## Sources and licences

The reference texts in `data/manifest.jsonl` come from three datasets. They are redistributed here for evaluation,
under each dataset's licence. No audio is included.

- **African Accented French** (OpenSLR SLR57), https://www.openslr.org/57/.
  - Licence: Apache License 2.0; a copy is in [`data/LICENSE-SLR57-Apache-2.0.txt`](data/LICENSE-SLR57-Apache-2.0.txt).
  - The references are copied unchanged from the dataset's transcript files, which are already lower-case with
    apostrophes split off.
  - Used for `slr57-niger` and `slr57-central`.
- **FLEURS** (Conneau et al., 2022, "FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech"),
  https://huggingface.co/datasets/google/fleurs.
  - Licence: Creative Commons Attribution 4.0 International, https://creativecommons.org/licenses/by/4.0/.
  - **Changes:** 25 utterances per language are kept from the test split, with their transcription as distributed
    (for `pt_br`, the raw transcription column). `score.py` normalises texts only when scoring; the stored references
    are unchanged.
  - Used for `fleurs-fr`, `fleurs-hi` and `fleurs-pt`.
- **Mozilla Common Voice 22.0, Portuguese**, https://commonvoice.mozilla.org/, read from the mirror at
  https://huggingface.co/datasets/fsicoli/common_voice_22_0.
  - Licence: CC0 1.0, a public domain dedication.
  - The sentences are copied unchanged. The manifest keeps a short hash of each speaker id rather than the id itself.
  - Used for `cv-pt-pt` and `cv-pt-br`.
