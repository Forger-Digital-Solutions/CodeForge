# R13 public benchmark launch result

The R13 public campaign was launched from source commit `0743bc2` using the exact verified-free OpenRouter route `cohere/north-mini-code:free`. It made no paid/BYOK fallback and ran no protected cases.

Six raw public attempts completed. All six failed safely on the provider's daily free-model 429 response with zero remaining quota and reset `2026-09-19T00:00:00Z`. Each Completion Gate decision was blocked/failed; no attempt produced a false completion. The aggregate runner output was not written before the capacity guard stopped the process, so there is **no official R13 benchmark score**. R13 must not report `0/40`, `0/6`, or an adjusted result as the public score.

| Item | Observed |
| --- | ---: |
| Completed raw attempts | 6 |
| Verified successes | 0 |
| False completions | 0 |
| Provider failures | 6 |
| Rate-limit failures | 6 |
| Paid inference | $0.00 |
| Official result | blocked / not produced |

The historical results remain immutable: R11 `33/40`; R12 `30/40`. The raw records remain under `benchmark/raw/` for forensic traceability.
