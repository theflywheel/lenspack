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
