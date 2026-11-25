"""Per-clip transcripts and WER for every model, with and without the hint -> results/per_clip.csv.

Uses score.py's normalisation and manifest, so the WER per clip is computed exactly as the tables are.

  python -I per_clip.py .
"""
import csv, json, sys
from pathlib import Path
import jiwer
HERE = Path(sys.argv[1]); sys.argv = [sys.argv[0]]
src = (HERE / "score.py").read_text()
ns = {}
exec(src.split("rows = defaultdict")[0].replace("HERE = Path(__file__).resolve().parent", f"HERE = Path({str(HERE)!r})"), ns)
norm, man = ns["norm"], ns["man"]
out = csv.writer(open(HERE / "results/per_clip.csv", "w", newline="", encoding="utf-8"))
out.writerow(["clip_id", "set", "lang", "seconds", "model", "hint", "reference", "transcript", "reference_normalised", "transcript_normalised", "wer", "latency_s", "cost_usd"])
n = 0
for f in sorted((HERE / "results").glob("*.jsonl")):
    stem = f.stem
    hint = "no" if stem.endswith("__nohint") else "yes"
    model = stem.removesuffix("__nohint").removeprefix("or__").replace("_", "/", 1)
    for r in map(json.loads, open(f, encoding="utf-8")):
        c = man.get(r["id"])
        if not c: continue
        ref, hyp = norm(c["ref"], c["lang"]), (norm(r["hyp"], c["lang"]) if r.get("hyp") is not None else None)
        wer = "" if hyp is None else (f"{jiwer.wer(ref, hyp):.4f}" if ref else "")
        out.writerow([c["id"], c["set"], c["lang"], c.get("seconds", ""), model, hint, c["ref"], r.get("hyp") if r.get("hyp") is not None else f"(error: {r.get('error','')[:80]})", ref, hyp or "", wer, r.get("latency", ""), (r.get("usage") or {}).get("cost", "")])
        n += 1
print(n, "rows")
