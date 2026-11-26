# Evals

This page explains how Lenspack measures chat models on real tasks, and how to run the measurements. It is for
developers changing the prompt, the tools or a pack, and for operators choosing a model. The full runner manual is
[evals/README.md](../../evals/README.md).

There are three kinds, all in `evals/`.

## Board building: `pnpm eval`

Scores models on board-building tasks: a pack seeded into an in-memory DuckDB, the same `boardTools()` and system
prompt the chat uses, and a fresh copy of the starting board per task. Each task has a check on the resulting board
or the reply (`evals/tasks.ts`). The tasks cover what matters for this design: naming a key that exists, recovering
from a typo through the nearest key, recovering from a fan-out refusal by switching measure, several edits in one
turn, layout intent, and answering a question with a real number.

```bash
LENSPACK_LLM_PROVIDERS='[{"name":"…","baseUrl":"…","apiKey":"…","model":"…"}]' pnpm eval
pnpm eval --providers /etc/lenspack/providers.json --models small --only kpi,fanout-recovery
```

Reported per model: pass rate, average latency, average steps, tool errors (refusals the model triggered), and
whether the reply narrated its reasoning. Results land in `evals/results/<timestamp>.{json,md}`, and
[evals/results/README.md](../../evals/results/README.md) keeps the history and what each round changed.

- `--review [name]` has a reviewer read each task's instruction, the board before and after, and the list of changes,
  and list findings marked material or minor. The report says how often it agrees with the check.
- `--heal` gives the builder one more round when the reviewer has any finding; `--escalate <name>` runs that round on
  a larger model instead.

## Accuracy: `pnpm eval:suite`

Scores answers rather than tool use. A suite (a YAML file) lists questions in a user's words, what a right query
looks like, and where the true answer comes from: SQL run straight against the database, never through Lenspack,
frozen in a truth file. Each question gets one real chat turn through a real server (the production prompt, tools,
step limit and metering), from a fresh copy of the seed board, and nothing is written to the deployment.

```bash
pnpm eval:suite --suite evals/suites/commerce.yaml --stub              # the runner itself: no model, no spend
pnpm eval:suite --suite my-suite.yaml --truth truth.json --models <model> --max-usd 1 --judge <model>
```

- Questions expect an answer, an edit or a decline. Numbers are read from the reply: counts exact (or within 0.5%
  when rounded, "31.6k"), ratios within ±0.1 percentage points or half the precision shown, never more than ±0.5.
- Outcomes are `correct`, `partial`, `declined_ok`, `confidently_wrong`, `wrong` and `error` (every data call failed
  on the server). A question with two sane readings passes when the reply names the definition it took, or asks.
- Runs can be scored again after a fix with `--rescore`, with no model and no database.
- `--max-usd` stops the run before a batch that could pass the cap. Models run interleaved per question, so a
  stopped run still compares them fairly.
- Against Superset, the turns run as a Superset user (`--as-user`), with that person's access, as in production.

The commerce suite runs in the tests with `--stub`. Suites built on other data hold only for that data on the
suite's `now:` date: to use one elsewhere, point its config at your own datasets and recompute the answers. Results
for a deployment's own suites are published with that deployment, not in this repository.

## Speech to text

[evals/speech](../../evals/speech/README.md) measures the transcription models behind the chat's microphone: word
error rate, latency and cost on public recordings in several languages, with and without a language hint. It is
Python, separate from the rest.

Every eval that calls a model costs money. The repository's tests never call one: they run the commerce suite with
`--stub`.

---

**Next:** [Design notes](../design/README.md).

**Related:** [Chat models](../operating/models.md) · [Review](../features/open-questions.md) ·
[Languages](../features/languages.md)
