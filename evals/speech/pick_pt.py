#!/usr/bin/env python3
"""Picks the Portuguese clips and prints their manifest lines (appended to data/manifest.jsonl).

  python -I pick_pt.py >> data/manifest.jsonl

- fleurs-pt: FLEURS pt_br, test split, the first 25 clips in the archive (as for fr and hi).
- cv-pt-pt:  Common Voice 22 Portuguese, test split, speakers who chose the "Portuguese (Portugal)" variant or
             named Lisbon / Porto as their accent: 40 clips, round-robin across speakers.
- cv-pt-br:  the same split, the "Portuguese (Brasil)" variant: 40 clips, round-robin across speakers.

Common Voice has no speakers labelled Mozambican or Angolan Portuguese, so European Portuguese stands in for the
European-pattern Portuguese spoken there. Speakers are ordered by a hash of their id, so the pick is fixed.

Sources: Google FLEURS (CC BY 4.0), https://huggingface.co/datasets/google/fleurs
         Mozilla Common Voice 22.0 (CC0 1.0), mirrored at https://huggingface.co/datasets/fsicoli/common_voice_22_0
"""
import csv, hashlib, io, json, re, sys, tarfile
from collections import defaultdict

import requests

FLEURS = "https://huggingface.co/datasets/google/fleurs/resolve/main/data/pt_br/{}"
CV = "https://huggingface.co/datasets/fsicoli/common_voice_22_0/resolve/main/{}"
PER_CV_SET = 40
csv.field_size_limit(10**7)


def tsv(url, **kw):
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    return list(csv.reader(io.StringIO(r.content.decode("utf-8")), delimiter="\t", quoting=csv.QUOTE_NONE, **kw))


def fleurs():
    refs = {row[1]: row for row in tsv(FLEURS.format("test.tsv"))}  # id, file name, raw text, normalised, ...
    names = []
    with requests.get(FLEURS.format("audio/test.tar.gz"), stream=True, timeout=60) as r:
        r.raise_for_status()
        with tarfile.open(fileobj=r.raw, mode="r|gz") as tf:
            for m in tf:
                if m.isfile() and m.name.endswith(".wav"):
                    names.append(m.name.split("/")[-1])
                    if len(names) == 25:
                        break
    for n in names:
        row = refs[n]
        yield {"id": f"fleurs-pt/{n[:-4]}", "set": "fleurs-pt", "lang": "pt", "audio": f"data/fleurs/pt_br/{n}", "ref": row[2], "seconds": round(int(row[5]) / 16000, 2)}


def common_voice():
    rows = list(csv.DictReader(io.StringIO(requests.get(CV.format("transcript/pt/test.tsv"), timeout=120).content.decode("utf-8")), delimiter="\t", quoting=csv.QUOTE_NONE))
    ms = {r[0]: int(r[1]) for r in tsv(CV.format("transcript/pt/clip_durations.tsv"))[1:]}
    european = re.compile(r"lisb|porto\b|portugu[eê]s de portugal", re.I)
    groups = {
        "cv-pt-pt": [r for r in rows if r.get("variant") == "Portuguese (Portugal)" or european.search(r.get("accents") or "")],
        "cv-pt-br": [r for r in rows if r.get("variant") == "Portuguese (Brasil)"],
    }
    for name, rs in groups.items():
        by = defaultdict(list)
        for r in sorted(rs, key=lambda r: r["path"]):
            by[r["client_id"]].append(r)
        speakers = sorted(by, key=lambda c: hashlib.sha256(c.encode()).hexdigest())
        picked, i = [], 0
        while len(picked) < PER_CV_SET and any(by.values()):
            q = by[speakers[i % len(speakers)]]
            if q:
                picked.append(q.pop(0))
            i += 1
        for r in picked:
            yield {"id": f"{name}/{r['path'][:-4]}", "set": name, "lang": "pt", "speaker": hashlib.sha256(r["client_id"].encode()).hexdigest()[:12],
                   "audio": f"data/cv/pt/{r['path']}", "ref": r["sentence"], "seconds": round(ms[r["path"]] / 1000, 2)}


for clip in [*fleurs(), *common_voice()]:
    print(json.dumps(clip, ensure_ascii=False))
