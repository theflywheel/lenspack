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

## hcm round 2 — after the four fixes (`2026-09-24T07-49-20-hcm`)

| builder | round 1 | round 2 | remaining misses |
|---|---|---|---|
| glm-5.3-flashx | 8/10 | **10/10** | — |
| deepseek-v4-flash | 6/10 | **10/10** | — |
| glm-5.3-flash | 9/10 | 9/10 | one 120 s stall on the two-dimension ask (kept retrying refused calls) |
| gemma-4-31b-it | 6/10 | 8/10 | fan-out (added a *count* by product instead of a rate — arguably the better pie); dropped the 10-week window |
| qwen3.7-flash | 8/10 | 8/10 | same two |

`sort` on the tool surface fixed "lowest first" for everyone. The richer fan-out refusal moved three models from fail to pass. Reviewer agreement rose to 4/5 on the edit tasks.

Two things learned from the residue:
- gemma and qwen both wrote "last 10 weeks" in the widget title and **omitted the window from the query** — and the reviewer accepted the title as evidence. The reviewer is now told to judge by the query description only; the tool's `time_last` description now insists on it.
- A model that keeps retrying a refused call spins until the timeout. Turns now stop after three consecutive refused steps so the model explains instead.
- The fan-out check accepted only `delivered_rate`; a count of product lines by product is an equally honest recovery and is now accepted.

## hcm round 3 — after the round-2 fixes (`2026-09-24T08-15-26-hcm`)

| builder | round 2 → 3 | remaining |
|---|---|---|
| glm-5.3-flashx | 10 → **10/10** | — |
| deepseek-v4-flash | 10 → **10/10** | — |
| qwen3.7-flash | 8 → **10/10** | — |
| gemma-4-31b-it | 8 → 9/10 | still omits the 10-week window once |
| glm-5.3-flash | 9 → 9/10 | the same 120 s stall on the two-dimension ask — a provider hang (0 steps), not a loop |

Builders are now near the ceiling of this set. The reviewer, however, fell to 2/5–3/5 agreement, uniformly on two tasks: it cannot see `sort` in the board summary (so "lowest first" looks unmet) and it never learns that the system *refused* the original fan-out request (so an honest alternative looks like a substitution). Both are evidence problems, not prompting problems: the summary now shows sort and limit, and the reviewer receives the turn's REFUSALS with their reasons.
