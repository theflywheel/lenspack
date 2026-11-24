#!/usr/bin/env python3
"""Hint vs no hint: WER both ways, and which language/script the no-hint output came back in.

OpenRouter's transcription response carries no detected-language field, so the
language is read off the text: Devanagari → hi, Arabic script → ur, Latin with
French / English / romanised-Hindi function words → fr / en / hi-latn.
"""
import json, re, sys
from collections import Counter, defaultdict
from pathlib import Path

import jiwer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from score import man, norm  # noqa: E402  (score.py prints its table on import; that's fine)

HERE = Path(__file__).resolve().parent
FR = set("le la les des un une est et de du que qui dans pour pas sur avec ce il elle nous vous je".split())
EN = set("the a an is and of to in that it for on with this be are was you i".split())
HI_LATN = set("hai hain ka ki ke ko mein se aur kya nahi tha thi".split())


def lang_of(text):
    t = text or ""
    if re.search(r"[ऀ-ॿ]", t):
        return "hi"
    if re.search(r"[؀-ۿ]", t):
        return "ur"
    w = re.findall(r"[a-zà-ÿ']+", t.lower())
    scores = {"fr": sum(x in FR for x in w), "en": sum(x in EN for x in w), "hi-latn": sum(x in HI_LATN for x in w)}
    best = max(scores, key=scores.get)
    return best if scores[best] else "?"


def load(path):
    return {r["id"]: r for r in map(json.loads, open(path, encoding="utf-8"))}


print("\n| system | set | WER hinted | WER no hint | output language, no hint |")
print("|---|---|---|---|---|")
for nh in sorted((HERE / "results").glob("or__*__nohint.jsonl")):
    hinted = HERE / "results" / nh.name.replace("__nohint", "")
    name = nh.stem.replace("__nohint", "").replace("or__", "").replace("_", "/", 1)
    a, b = load(hinted) if hinted.exists() else {}, load(nh)
    by = defaultdict(list)
    for cid, r in b.items():
        if cid in man and r.get("hyp") is not None:
            by[man[cid]["set"]].append(cid)
    for s in sorted(by):
        ids = [i for i in by[s] if a.get(i, {}).get("hyp") is not None]
        lang = man[by[s][0]]["lang"]
        ref = [norm(man[i]["ref"], lang) for i in ids]
        w_h = 100 * jiwer.wer(ref, [norm(a[i]["hyp"], lang) for i in ids]) if ids else float("nan")
        w_n = 100 * jiwer.wer(ref, [norm(b[i]["hyp"], lang) for i in ids]) if ids else float("nan")
        langs = Counter(lang_of(b[i]["hyp"]) for i in by[s])
        right = langs.get(lang, 0)
        print(f"| {name} | {s} | {w_h:.1f}% | {w_n:.1f}% | {right}/{len(by[s])} {lang}" + "".join(f", {n} {k}" for k, n in langs.most_common() if k != lang) + f" (n={len(ids)} paired) |")
