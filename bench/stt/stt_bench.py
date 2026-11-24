#!/usr/bin/env python3
"""Speech-to-text bake-off for the Lenspack voice input.

  manifest.jsonl: {"id", "set", "lang", "audio", "ref"} per clip; audio paths are relative to this folder
  python -I stt_bench.py data/manifest.jsonl --systems or:mistralai/voxtral-mini-transcribe-3-0,local:large-v3-turbo [--limit N] [--nohint]

OpenRouter systems need OPENROUTER_API_KEY in the environment (from a secret store; never in a file).
Writes results/<system>.jsonl (one line per clip: hyp, latency, error) and is
resumable: clips already in a system's file are skipped. score.py reads them.
"""
import argparse, base64, json, os, sys, time
from pathlib import Path

import requests

OR_URL = "https://openrouter.ai/api/v1/audio/transcriptions"
HERE = Path(__file__).resolve().parent


def audio_path(clip):
    p = Path(clip["audio"])
    return p if p.is_absolute() else HERE / p


def openrouter(model, hint=True):
    key = os.environ["OPENROUTER_API_KEY"]
    s = requests.Session()

    def run(clip):
        audio = audio_path(clip).read_bytes()
        body = {"model": model, "input_audio": {"data": base64.b64encode(audio).decode(), "format": Path(clip["audio"]).suffix.lstrip(".")}}
        if hint:
            body["language"] = clip["lang"]
        r = s.post(OR_URL, json=body, headers={"Authorization": f"Bearer {key}", "X-Title": "lenspack-voice-bench"}, timeout=90)
        if r.status_code != 200:
            raise RuntimeError(f"{r.status_code} {r.text[:200]}")
        j = r.json()
        extra = {k: v for k, v in j.items() if k not in ("text", "usage", "segments", "words")}
        return j.get("text", ""), {**(j.get("usage") or {}), "extra": extra}

    return run


def local(size):
    from faster_whisper import WhisperModel

    m = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=int(os.environ.get("BENCH_THREADS", "8")))

    def run(clip):
        import subprocess, numpy as np
        pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(audio_path(clip)), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True).stdout
        segs, _ = m.transcribe(np.frombuffer(pcm, np.float32), language=clip["lang"], beam_size=1, vad_filter=False)
        return " ".join(s.text.strip() for s in segs), None

    return run


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("--systems", required=True)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--nohint", action="store_true", help="omit the language hint (auto-detect); results go to <system>__nohint.jsonl")
    a = ap.parse_args()
    clips = [json.loads(l) for l in open(a.manifest)][: a.limit]
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    for sysname in a.systems.split(","):
        kind, name = sysname.split(":", 1)
        fn = openrouter(name, hint=not a.nohint) if kind == "or" else local(name)
        path = out / (sysname.replace("/", "_").replace(":", "__") + ("__nohint" if a.nohint else "") + ".jsonl")
        done = {json.loads(l)["id"] for l in open(path)} if path.exists() else set()
        errs = streak = 0
        with open(path, "a") as f:
            for c in clips:
                if c["id"] in done:
                    continue
                t = time.time()
                try:
                    hyp, usage = fn(c)
                    rec = {"id": c["id"], "hyp": hyp, "latency": round(time.time() - t, 3), "usage": usage}
                except Exception as e:  # keep going; the error is recorded per clip
                    errs += 1
                    rec = {"id": c["id"], "hyp": None, "latency": round(time.time() - t, 3), "error": str(e)[:300]}
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                f.flush()
                streak = streak + 1 if rec.get("error") else 0
                if streak >= 5:  # likely auth, a bad model id or an unsupported language: stop spending
                    print(f"{sysname}: stopping after 5 errors in a row: {rec['error'][:160]}", file=sys.stderr)
                    break
        print(f"{sysname}: {len(clips) - len(done)} clips run, {errs} errors", file=sys.stderr)


if __name__ == "__main__":
    main()
