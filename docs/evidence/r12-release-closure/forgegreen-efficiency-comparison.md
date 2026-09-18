# ForgeGreen efficiency comparison

## Baseline

R11.4 measured 573 provider calls for the definitive 40-case campaign, 530 tool calls, mean 13.3 tool calls per attempt, 120,311 output tokens, and 3,034,216 ms wall time. RP-02 used 41 tool calls and was approximately 3.1× the campaign mean; R11 recorded `repeatedSearches=0`.

## R12 controls

R12 adds a general no-progress read-signal detector keyed to unchanged workspace state and distinct malformed/empty/not-found read observations. It escalates after eight no-progress observations while allowing unique evidence reads and mutating progress to continue. This is a bounded investigation signal, not ForgeGreen execution authority and not a tiny global tool limit.

The planning and authority contracts add validation work before execution but do not add provider calls to trivial plans. The protected acceptance stage is local evidence validation and does not route inference.

## Measurement status

The fresh R12 public campaign is now recorded in `codeforge-bench-r2/r12-public.json`.

| Metric | R11.4 | R12 | Change |
|---|---:|---:|---:|
| Verified successes | 33/40 | 30/40 | -3 cases |
| pass@1 | 0.825 | 0.750 | -0.075 |
| Provider calls | ~573 | 607 | +34 (+5.9%) |
| Tool calls | 530 | 562 | +32 (+6.0%) |
| Mean tool calls/attempt | 13.25 | 14.05 | +0.80 (+6.0%) |
| p95 tool calls | not recorded in R11 report | 40 | R12 recorded |
| Output tokens | 120,311 | 149,799 | +29,488 (+24.5%) |
| Wall time | 3,034,216 ms | 3,266,669 ms | +232,453 ms (+7.7%) |
| Estimated provider cost | $0 | $0 | unchanged |
| False completions | 0 | 0 | unchanged |
| Provider-rate-limited attempts | 0 | 2 | +2 |

The R12 campaign therefore **REGRESSED** on capability score and resource usage. The no-progress detector is covered by focused tests, but the fresh campaign does not prove an RP-02 improvement. The planning, authority, and redaction contracts are general source changes with passing regression tests; their benchmark effectiveness remains unproven where R12 hidden verifiers still failed. No efficiency improvement is claimed.
