# Eval results

Latest run: `2026-09-24T03-18-04.json` — prompt v3, commerce pack, 8 tasks, review + heal (escalation: glm-5.3-flashx).

| model | pass | after heal | reviewer agrees | avg latency | avg steps | verdict |
|---|---|---|---|---|---|---|
| glm-5.3-flash (amul) | — | — | — | — | — | unavailable |
| glm-5.3-flashx (openrouter) | 8/8 | 8/8 | 4/7 | 10518 ms | 2.1 | good builder |
| gemma-4-31b-it (amul) | 8/8 | 7/8 | 4/7 | 2276 ms | 2.0 | good builder |
| glm-5.3-flash (openrouter) | 8/8 | 8/8 | 5/7 | 9963 ms | 2.1 | good builder |
| gpt-oss-120b (openrouter) | 8/8 | 8/8 | 6/7 | 26121 ms | 3.8 | capable but slow |
| qwen3.7-flash (openrouter) | 8/8 | 8/8 | 6/7 | 14727 ms | 3.1 | good builder |
| deepseek-v4-flash (openrouter) | 8/8 | 8/8 | 6/7 | 11350 ms | 3.5 | good builder |
| gemini-2.5-flash-lite (openrouter) | 2/8 | 7/8 | 5/7 | 4528 ms | 1.0 | needs escalation |
| gpt-5-nano (openrouter) | 8/8 | 8/8 | 4/7 | 24452 ms | 3.0 | capable but slow |
| gemma-4-31b-it:free (openrouter) | — | — | — | — | — | unavailable |
| qwen3-30b-a3b-instruct (openrouter) | 7/8 | 7/8 | 2/7 | 2611 ms | 2.4 | good builder |

Reading the table:

- Prompt v3 (schema in context) removed the discovery calls: average steps fell from 3–5 to about 2, and seven of nine reachable models pass 8/8.
- Self-review by a small model is unreliable: agreement with the deterministic check is 2/7–6/7, and a wrong "not satisfied" costs a heal round (15–95 s) — and once broke a passing board. The reviewer should be a stronger model than the builder.
- Escalation works as designed: gemini-2.5-flash-lite never calls tools on its own (2/8) but heals to 7/8 when the heal round runs on glm-5.3-flashx.
- Fast, accurate builders: gemma-4-31b-it (~2.3 s/task), qwen3-30b-a3b-instruct (~2.6 s, weak on the data question), glm-5.3-flash and deepseek-v4-flash (~10 s).

## Round 4 — a stronger reviewer (`2026-09-24T03-39-30`)

Same builders, reviewer = `gpt-5-mini`, heal on the builder's own escalation model (glm-5.3-flashx).

| builder | pass | after heal | reviewer agrees | avg latency |
|---|---|---|---|---|
| gemma-4-31b-it (AMUL) | 8/8 | — (never flagged) | **7/7** | 2.3 s |
| deepseek-v4-flash | 8/8 | — | 6/7 | 18 s |
| glm-5.3-flash | 8/8 | 7/8 | 5/7 | 9 s |
| glm-5.3-flashx | 7/8 (one OpenRouter timeout) | 6/8 | 5/6 | 26 s |
| qwen3-30b-a3b-instruct | 7/8 | 7/8 | 5/7 | 13 s |
| gemini-2.5-flash-lite | 2/8 | 7/8 | 6/7 | 4 s |

What changed versus self-review: agreement rose across the board (gemma from 4/7 to 7/7), so a stronger reviewer is worth its single call per turn. What did not change: a false "not satisfied" still costs a heal round, and twice the heal round damaged a board that was already correct (flashx `layout`, glm-5.3-flash `kpi`). The disagreements cluster on placement intent, where the reviewer reads row numbers from a summary.

Decision taken from this: the reviewer's verdict and the receipt are shown on every turn; automatic healing is opt-in (`?rounds=2`), and the default UI offers the review's findings as a one-click "Apply fixes" that the person chooses.

## hcm round 1 — the awkward schema (`2026-09-24T07-24-59-hcm`)

Ten harder tasks on the `hcm` pack (reviewer gpt-5-mini, heal on flashx):

| builder | pass | notes |
|---|---|---|
| glm-5.3-flash (OpenRouter) | 9/10 | recovered from the fan-out trap; refused the radius map; explained the two-dimension ask |
| glm-5.3-flashx | 8/10 | fan-out recovered; answered "Stock-out" (a check bug) |
| qwen3.7-flash | 8/10 | did not recover from the fan-out trap |
| gemma-4-31b-it | 6/10 | fan-out not recovered; one 137 s timeout; dropped the 10-week window once |
| deepseek-v4-flash | 6/10 | fan-out not recovered; one timeout |

Everything passed by everyone: percentiles over epoch differences, the hierarchy dimension plus a filter, the soft-delete-aware count, the worst-locality data question, and — notably — the honest refusal of the radius map.

What the round found, in order of what it says about the *system* rather than the models:

1. **`delivery-by-locality` failed for every model** because the `add_widget` tool had no `sort` argument: "lowest first" was inexpressible. Fixed — a tool-surface gap, caught only by a task that asked for it.
2. **Fan-out refusals were too vague** to recover from for three of five models ("measure something on resources instead"). The refusal now names the answerable measures on the far entity and the dimensions on the root, and carries the first as `nearest`.
3. **The reviewer marked honest refusals and answered questions "not satisfied"** (agreement 3/7–4/8). The review prompt now states that a refusal of an inexpressible ask, and an answered question, are satisfied outcomes; evals only review edit tasks.
4. The `question-top-reason` check demanded the literal `STOCK_OUT`; two models answered "Stock-out" correctly. Check loosened.

Round 2 re-runs the same set with those four changes.
