#!/usr/bin/env python3
"""WER per system and set from results/*.jsonl against the manifest. Prints a markdown table."""
import json, re, statistics, sys, unicodedata
from collections import defaultdict
from pathlib import Path

import jiwer

HERE = Path(__file__).resolve().parent
man = {c["id"]: c for c in map(json.loads, open(sys.argv[1] if len(sys.argv) > 1 else HERE / "data/manifest.jsonl", encoding="utf-8"))}

# Portuguese: the masculine form (um, dois), so "1" against "uma" still counts as an error.
NUM_PT = {"0": "zero", "1": "um", "2": "dois", "3": "três", "4": "quatro", "5": "cinco", "6": "seis", "7": "sete", "8": "oito", "9": "nove", "10": "dez"}
NUM_FR = {"0": "zéro", "1": "un", "2": "deux", "3": "trois", "4": "quatre", "5": "cinq", "6": "six", "7": "sept", "8": "huit", "9": "neuf", "10": "dix"}


def norm(s, lang):
    s = unicodedata.normalize("NFC", s or "").lower()
    s = s.replace("’", "'")
    s = re.sub(r"[^\w\s'ऀ-ॿ]", " ", s)  # keep letters, digits, apostrophes, Devanagari (incl. matras)
    s = s.replace("'", " ")
    s = re.sub(r"[।॥]", " ", s)  # danda
    words = s.split()
    if lang == "fr":
        words = [NUM_FR.get(w, w) for w in words]
    elif lang == "pt":
        words = [NUM_PT.get(w, w) for w in words]
    return " ".join(words)


rows = defaultdict(lambda: defaultdict(lambda: {"ref": [], "hyp": [], "lat": [], "err": 0, "sec": 0.0}))
for f in sorted((HERE / "results").glob("*.jsonl")):
    name = f.stem.replace("__", ":").replace("_", "/", 1)
    for r in map(json.loads, open(f, encoding="utf-8")):
        c = man.get(r["id"])
        if not c:
            continue
        b = rows[name][c["set"]]
        if r.get("hyp") is None:
            b["err"] += 1
            continue
        b["ref"].append(norm(c["ref"], c["lang"]))
        b["hyp"].append(norm(r["hyp"], c["lang"]))
        b["lat"].append(r["latency"])
        b["sec"] += c.get("seconds", 0)

sets = sorted({c["set"] for c in man.values()}, key=lambda x: ("-pt" in x or x.endswith("pt"), not x.startswith("slr57"), x))
print("| system | " + " | ".join(f"{s} WER" for s in sets) + " | median latency (s) | RTF | errors |")
print("|---|" + "---|" * (len(sets) + 3))
for name, by in sorted(rows.items()):
    cells, lats, secs, errs = [], [], 0.0, 0
    for s in sets:
        b = by.get(s)
        if not b or not b["ref"]:
            cells.append("—" if not b else f"all {b['err']} failed")
            if b:
                errs += b["err"]
            continue
        cells.append(f"{100 * jiwer.wer(b['ref'], b['hyp']):.1f}%")
        lats += b["lat"]; secs += b["sec"]; errs += b["err"]
    rtf = f"{sum(lats) / secs:.2f}" if secs else "—"
    print(f"| {name} | " + " | ".join(cells) + f" | {statistics.median(lats):.2f} | {rtf} | {errs} |" if lats else f"| {name} | " + " | ".join(cells) + " | — | — | {errs} |")
