# evals

Scores language models on real board-building tasks: the commerce pack on an in-memory DuckDB, the same `boardTools()` and the same system prompt the demo uses, one fresh copy of the canonical board per task.

```bash
LENSPACK_LLM_PROVIDERS='[{"name":"…","baseUrl":"…","apiKey":"…","model":"…"}]' pnpm eval
pnpm eval --providers /etc/lenspack/providers.json --models glm --only kpi,fanout-recovery
```

Each task has a check on the resulting board or the reply (`tasks.ts`). Reported per model: pass rate, average latency, average steps, tool errors (refusals the model triggered), and whether the reply narrated its reasoning. Results land in `results/<timestamp>.{json,md}`.

The tasks cover the failure modes that matter for this design: naming a key that exists, recovering from a typo via `didYouMean`, recovering from a fan-out refusal by switching measure, multi-step edits in one turn, layout intent, and answering a question with a real number.

## Review and heal

`--review [name]` runs an adversarial text review after each task: the reviewer (another provider, or the builder itself) sees the instruction, the board before and after, and the receipt of versions gained, and lists what is missing or wrong. The table reports how often the reviewer agrees with the deterministic check — a reviewer that says "satisfied" when the check fails is not worth its latency.

`--heal` gives the builder one more round when the reviewer is not satisfied, with the review as the instruction, and reports pass rates before and after (🩹 = passed only after healing).

`--visual <name>` is the optional extra: Playwright screenshots the resulting board through the demo server (`--demo`, default `http://127.0.0.1:8787`) and a vision model judges it against a fixed rubric.
