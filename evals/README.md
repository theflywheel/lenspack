# evals

Scores language models on real board-building tasks: the commerce pack on an in-memory DuckDB, the same `boardTools()` and the same system prompt the demo uses, one fresh copy of the canonical board per task.

```bash
LENSPACK_LLM_PROVIDERS='[{"name":"…","baseUrl":"…","apiKey":"…","model":"…"}]' pnpm eval
pnpm eval --providers /etc/lenspack/providers.json --models glm --only kpi,fanout-recovery
```

Each task has a check on the resulting board or the reply (`tasks.ts`). Reported per model: pass rate, average latency, average steps, tool errors (refusals the model triggered), and whether the reply narrated its reasoning. Results land in `results/<timestamp>.{json,md}`.

The tasks cover the failure modes that matter for this design: naming a key that exists, recovering from a typo via `didYouMean`, recovering from a fan-out refusal by switching measure, multi-step edits in one turn, layout intent, and answering a question with a real number.

## Review and heal

`--review [name]` runs an adversarial text review after each task: the reviewer (another provider, or the builder itself) sees the instruction, the board before and after, and the receipt of versions gained, and lists its findings, each marked material (the board would mislead whoever reads it) or minor. The table reports how often the reviewer agrees with the deterministic check — a reviewer that says "satisfied" when the check fails is not worth its latency.

In the chat, a turn's edits are held until the reviewer has checked them. A material finding gets one fix round and a second check; a change still wrong after it is not saved, and the reply says so. Minor findings are saved and mentioned in the reply. `--heal` gives the builder one more round when the reviewer has any finding, with the findings as the instruction, and reports pass rates before and after (🩹 = passed only after healing).

`--escalate <name>` runs the heal round on a larger model instead of the builder: small model first, big model only when the reviewer has findings.

## Suites: accuracy against frozen truth

`pnpm eval:suite` scores answers rather than tool use. A suite (`evals/suites/*.yaml`, or a deployment's own file kept outside this repo) lists questions in a user's words. Each one says what a right query looks like and where the true answer comes from. Truth is SQL run straight against the database, never through Lenspack, and is frozen in a truth file: the runner refuses a truth file from another suite and prints its data fingerprint with the results.

```bash
pnpm eval:suite --suite evals/suites/commerce.yaml --stub              # the runner itself, no model, no spend
pnpm eval:suite --suite my-suite.yaml --truth truth.json --models claude-haiku-5-5 --max-usd 1 --judge claude-haiku-5-5
```

- **Rig:** `config:` points at a Lenspack-over-Superset config, read the way `packages/hosts/superset/bin/serve.ts` reads it. `example:` seeds one of the repo's examples into DuckDB, and the truth SQL then runs on that same database. Either way the runner hosts the real `createApp` on a loopback port. Each question gets one chat turn through `POST …/chat?review=off`, so it sees the production prompt, tools, step limit and metering. Every question starts from a fresh in-memory copy of the seed board (`board.dashboard` is read once from Superset, read-only; `--board-cache` keeps it), and nothing is written to the deployment.
- **Question:** `expect: answer | edit | decline`. `accept` lists measures, dimension, grain and filters, each as any-of. `truth` has a shape (`scalar`, `map`, `set` with an optional `universe_sql`, `list` with `k`, `series`, `table`), a unit (`count`, `ratio` or `number`) and optional `alternatives` for defensible other definitions. Tag such a question `ambiguous` and list the `disclose` words, one of which the reply must use to say which definition it took. Edits check `widget`/`widgets` (any-of fields), `layout`, `filter`, `title`, `removed`, `changed` and `absent`. `start_layout` places named widgets (by title) before the turn, and `moved: { title, beside }` wants that widget on the other one's row with nothing overlapping; on a move, a reply that says there's no room and leaves the board alone is declined ok, and one that claims a move the board doesn't show is confidently wrong. On any edit, a turn that changes the board and sends no reply is wrong, and a right board with changes nobody asked for (fill or density toggled; a widget outside the edited rows resized, slid or reordered; a widget in an edited row that the model itself moved out of the row or widened, with a layout call not undone by `restore_version`) is partial. Narrowing a row-mate to make room is what the packing does anyway, so it isn't counted. The report lists tool calls and latency per edit question. `turns:` makes a question multi-turn.
- **Scoring:**
  - Numbers are read from the reply. Counts must be exact, or within 0.5% when the reply rounds them ("31.6k"). Ratios get ±0.1 pp, or half the precision shown, and never more than ±0.5 pp.
  - When the reply is not enough, the data of the new or changed widget is scored instead.
  - `grounded` lists the reply's numbers that appear in no tool result.
  - On an `ambiguous` question, any alternative's value counts with a disclosure word. The right value without one is `partial`, and a short clarifying question that names the readings is `declined_ok`. So naming the definition and asking both pass; only a silent pick loses.
  - Declines are labelled declined, degraded, clarify or answered, by `--judge` or by a heuristic. A reply that says outright it can't ("no records in that window") overrules an `answered` label.
  - A turn whose every data call failed on the server (502, timeout) is an `error`, not a model answer.
  - Outcomes are `correct`, `partial`, `declined_ok`, `confidently_wrong`, `wrong` and `error`.
  - The report breaks results down by model and tier, groups expected fails by reason (engine, pack, data, scope), quotes every confidently wrong reply, and gives cost per turn and per right answer, latency p50/p95, steps and tool errors.
- **Stub:** `--stub` plays each question's `stub:` script (tool calls, then text, with `{{rows}}` for the last result). `evals/test/suite.test.ts` runs the commerce suite this way and checks that every outcome is the one the script aims for.
- **Stored runs:** each result keeps what the turn left behind (reply, tool calls and outputs, boards before and after, widget data, the judge label). `--rescore results/<run>.json` scores a stored run again after a scorer, suite or truth fix, with no model and no database.
- **Reviewer:** turns run with `review=off` unless `--review` is given. With it, each turn runs as production does: the deployment's reviewer (the builder model by default) checks edits, and a material finding gets one fix round. Each result records its cost by role (`build`, `review`, `escalate`, …), the build rounds and the reviewer's verdicts. `--reviewer <model>` and `--escalate <model>` pick other models for those two roles, as a deployment's `LENSPACK_LLM_ROLES` does; either one turns review on.
- **Cost:** models run interleaved per question, so a stopped run still compares them on the same questions. `--max-usd` is checked before each batch against the dearest batch so far, and progress is saved to `results/_partial.json`.
- **Superset rig check:** before trusting a pack, the rig checks that every dataset came back under its own name and retries otherwise. (A concurrent-lookup race in Flask-AppBuilder, in the versions Superset 5.0 and 6.1 pin, once returned one dataset for another.)
