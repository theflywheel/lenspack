| model | pass | after heal | reviewer agrees | avg latency | avg steps | tool errors | narrated | visual ok | tokens in / out | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| haiku | 8/10 | — | — | 4647 ms | 3 | 1 | 0 | — | 379022 / 7882 | $0.0106 |
| sonnet | 8/10 | — | — | 4755 ms | 2 | 2 | 0 | — | 308515 / 4897 | $0.1524 |

| task | haiku | sonnet |
|---|---|---|
| delivery-by-locality | ✅ | ✅ |
| fanout-trap | ❌ | ❌ |
| epoch-window | ❌ | ❌ |
| duration-percentile | ✅ | ✅ |
| hierarchy | ✅ | ✅ |
| question-worst-locality | ✅ | ✅ |
| question-top-reason | ✅ | ✅ |
| unanswerable-radius | ✅ | ✅ |
| two-dimensions | ✅ | ✅ |
| soft-delete-count | ✅ | ✅ |