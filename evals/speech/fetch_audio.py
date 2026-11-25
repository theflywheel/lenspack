#!/usr/bin/env python3
"""Downloads the audio for data/manifest.jsonl (the clips the published results used).

Both archives are streamed and only the listed clips are kept, so the 1.8 GB SLR57
tarball is never stored. FLEURS ships 32-bit float WAV, which some providers refuse,
so those clips are rewritten as 16-bit PCM (what the results were measured on).

  python -I fetch_audio.py            # into data/slr57/ and data/fleurs/
  python -I fetch_audio.py --sets fleurs-pt,cv-pt-pt,cv-pt-br   # only some sets
  python -I fetch_audio.py --delete   # remove the audio again when done

Sources: OpenSLR SLR57 African Accented French (Apache 2.0), https://www.openslr.org/57/
         Google FLEURS (CC BY 4.0), https://huggingface.co/datasets/google/fleurs
         Mozilla Common Voice 22.0 Portuguese (CC0 1.0), mirrored at https://huggingface.co/datasets/fsicoli/common_voice_22_0
         (its mp3 clips are kept as they are: compressed audio, closer to what a browser sends)
"""
import json, shutil, subprocess, sys, tarfile
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
SLR57 = "https://www.openslr.org/resources/57/African_Accented_French.tar.gz"
FLEURS = "https://huggingface.co/datasets/google/fleurs/resolve/main/data/{lang}/audio/test.tar.gz"
CV_PT = "https://huggingface.co/datasets/fsicoli/common_voice_22_0/resolve/main/audio/pt/test/pt_test_0.tar"

if "--delete" in sys.argv:
    for d in ("slr57", "fleurs", "cv", "own_wav"):
        shutil.rmtree(DATA / d, ignore_errors=True)
    sys.exit(0)

only = sys.argv[sys.argv.index("--sets") + 1].split(",") if "--sets" in sys.argv else None
clips = [c for c in map(json.loads, open(DATA / "manifest.jsonl", encoding="utf-8")) if not only or c["set"] in only]
want = {c["audio"]: c for c in clips if not (HERE / c["audio"]).exists()}


def stream(url, member_to_audio, mode="r|gz"):
    """Extracts tar members whose name maps to a wanted audio path; stops once all are found."""
    need = {a for a in member_to_audio.values() if a in want}
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with tarfile.open(fileobj=r.raw, mode=mode) as tf:
            for m in tf:
                a = member_to_audio.get(m.name) or member_to_audio.get(Path(m.name).name)
                if not m.isfile() or a not in need:
                    continue
                out = HERE / a
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(tf.extractfile(m).read())
                need.discard(a)
                if not need:
                    break
    return need


slr = {a[len("data/slr57/"):]: a for a in want if a.startswith("data/slr57/")}
if slr:
    left = stream(SLR57, slr)
    print(f"SLR57: {len(slr) - len(left)} clips", file=sys.stderr)
cv = {a[len("data/cv/pt/"):]: a for a in want if a.startswith("data/cv/pt/")}
if cv:
    left = stream(CV_PT, cv, mode="r|")
    print(f"Common Voice pt: {len(cv) - len(left)} clips", file=sys.stderr)
for lang in ("fr_fr", "hi_in", "pt_br"):
    fl = {Path(a).name: a for a in want if a.startswith(f"data/fleurs/{lang}/")}
    if not fl:
        continue
    left = stream(FLEURS.format(lang=lang), fl)
    for a in fl.values():  # the paths (the keys are bare file names)
        p = HERE / a
        if p.exists():
            tmp = p.with_suffix(".s16.wav")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(p), "-c:a", "pcm_s16le", str(tmp)], check=True)
            tmp.replace(p)
    print(f"FLEURS {lang}: {len(fl) - len(left)} clips", file=sys.stderr)
missing = [a for a in want if not (HERE / a).exists()]
print(f"{len(clips) - len(missing)}/{len(clips)} clips present", file=sys.stderr)
