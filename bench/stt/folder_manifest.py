#!/usr/bin/env python3
"""A manifest from a folder of voice notes, for rerunning the bake-off on new clips.

  python -I folder_manifest.py ~/voice-notes refs.tsv > data/own.jsonl

refs.tsv: one line per clip, "<file name>\t<lang fr|en|hi>\t<what was said>". Clips not listed
are skipped. Any format ffmpeg reads works (m4a, ogg, opus, mp3 from phones); each is
converted to 16 kHz mono wav next to the manifest so every provider gets the same input.
Then:
  OPENROUTER_API_KEY=... python -I stt_bench.py data/own.jsonl --systems or:<model>,...   (key from a secret store)
  python -I score.py data/own.jsonl
  python -I fetch_audio.py --delete   # removes data/own_wav with the rest of the audio
"""
import json, subprocess, sys
from pathlib import Path

folder, refs = Path(sys.argv[1]).expanduser(), Path(sys.argv[2])
HERE = Path(__file__).resolve().parent
dest = HERE / "data/own_wav"
dest.mkdir(parents=True, exist_ok=True)
for line in refs.read_text(encoding="utf-8").splitlines():
    if not line.strip() or line.startswith("#"):
        continue
    name, lang, ref = line.split("\t", 2)
    src = folder / name
    if not src.exists():
        print(f"missing {src}", file=sys.stderr)
        continue
    wav = dest / (src.stem + ".wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000", str(wav)], check=True)
    secs = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(wav)], capture_output=True, text=True).stdout.strip() or 0)
    print(json.dumps({"id": f"own/{src.stem}", "set": f"own-{lang}", "lang": lang, "audio": str(wav.relative_to(HERE)), "ref": ref, "seconds": secs}, ensure_ascii=False))
