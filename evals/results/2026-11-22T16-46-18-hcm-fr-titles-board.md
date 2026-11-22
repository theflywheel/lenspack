| model | pass | after heal | reviewer agrees | avg latency | avg steps | tool errors | narrated | visual ok | tokens in / out | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| haiku | 9/10 | — | — | 4106 ms | 2 | 1 | 0 | — | 357408 / 6704 | $0.0097 |
| sonnet | 9/10 | — | — | 3849 ms | 2 | 3 | 0 | — | 305596 / 3958 | $0.1719 |

| task | haiku | sonnet |
|---|---|---|
| delivery-by-locality | ✅ | ✅ |
| fanout-trap | ❌ | ❌ |
| epoch-window | ✅ | ✅ |
| duration-percentile | ✅ | ✅ |
| hierarchy | ✅ | ✅ |
| question-worst-locality | ✅ | ✅ |
| question-top-reason | ✅ | ✅ |
| unanswerable-radius | ✅ | ✅ |
| two-dimensions | ✅ | ✅ |
| soft-delete-count | ✅ | ✅ |