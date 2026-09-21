# R23 summary — dry-run-smoke

Generated 2026-09-21T00:58:53.520Z from 6 raw record(s) in raw/{dry_run}; 6 included, 0 excluded (listed below), 0 invalid, 0 unpaired. Pairs analysed: **3** (3 with provider-reported tokens in both arms).
Models: scripted::scripted-free · CodeForge commits: 79694813 · protocol digests: e7c14c93f1c9

## Per-arm totals

| Metric | Control (A) | Optimized (B) |
|---|---:|---:|
| runs | 3 | 3 |
| verified complete | 2 | 2 |
| verified success rate | 66.7% | 66.7% |
| claimed complete | 2 | 2 |
| false completions | 0 | 0 |
| false completion rate | 0.0% | 0.0% |
| verification failed / budget exhausted / provider failures / severe | 1 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |
| runs with provider-reported tokens | 3/3 | 3/3 |
| total model tokens | 32,920 | 76,320 |
| input / output tokens | 32,100 / 820 | 74,400 / 1,920 |
| cached input tokens | — | — |
| model calls (failed / retried / rate-limited) | 12 (0 / 0 / 0) | 28 (0 / 0 / 0) |
| tool calls requested | 7 | 16 |
| avoidable duplicate context bytes (§10) | 0 | 903 |
| transmitted context bytes | 129,059 | 303,763 |
| wall clock (s) / active agent (s) / model wait (s) / rate-limit wait (s) | 15 / 9 / 0 / 0 | 23 / 17 / 0 / 0 |
| actual cost (USD) | 0 | 0 |
| equivalent public-API cost (USD) | — | — |
| equivalent market cost (USD, reference) | 0.0724 | 0.168 |
| harness CPU ms (user+system) | 1,374 | 2,952 |

## Headline metrics (protocol §8.1)

| Metric | Control (A) | Optimized (B) |
|---|---:|---:|
| verified tasks per 1M model tokens | 60.753 | 26.205 |
| model tokens per verified task | 16,460 | 38,160 |
| verified tasks per 100 model calls | 16.67 | 7.14 |
| verified tasks per $1 equivalent public-API inference | — | — |
| equivalent cost per verified task (USD) | — | — |
| wall clock per verified task (s) | 7.4 | 11.3 |

## Paired differences (optimized − control) and 95% bootstrap intervals (pairs resampled)

- total tokens per task: mean 14,467, median 12,940, IQR [12,940, 15,230] over 3 pairs; mean of per-pair % change 145.4%
- mean token difference 95% CI: 14,467 [12,940, 17,520] (seed 20260921, 10000 resamples)
- ratio of total tokens B/A 95% CI: 2.318 [2, 2.681]
- verified-rate difference B−A 95% CI: 0 [0, 0]
- ratio of verified-tasks-per-1M-tokens B/A 95% CI: 0.431 [0.373, 0.471]
- model calls per task: mean 5.33, median 5
- wall clock per task (s): mean 2.5, median 1.8
- verified pattern: both 2, only control 0, only optimized 0, neither 1
- Wilcoxon signed-rank on token differences: n=3, W+=6, W−=0 (n<10: no p-value)

## By task class

| Class | Pairs | Control verified | Optimized verified | Mean token difference |
|---|---:|---:|---:|---:|
| build_config_dependency | 1 | 0 | 0 | 17,520 |
| bug_fix | 1 | 1 | 1 | 12,940 |
| small_fix | 1 | 1 | 1 | 12,940 |

## Verdict inputs (protocol §9)

- non-inferiority: rate difference 0.0%; CI lower bound 0.0%; passes ≥ −5 pp with lower bound > −10 pp: **true**
- false-completion guard (B ≤ A + 2 pp): control 0, optimized 0: **true**
- token saving: CI excludes zero **true**, direction **optimized_more**

## Per pair

| Task | Class | Rep | Control | Optimized | Δ tokens |
|---|---|---:|---|---|---:|
| js-build-config-test-script | build_config_dependency | 1 | verification_failed · 6 calls · 17,520 tok · 4s · orchestrated:tiny | verification_failed · 12 calls · 35,040 tok · 8s · orchestrated:adaptive | 17,520 |
| py-bug-fix-config-merge | bug_fix | 1 | verified_complete · 3 calls · 7,700 tok · 6s · orchestrated:tiny | verified_complete · 8 calls · 20,640 tok · 7s · orchestrated:normal | 12,940 |
| py-small-fix-median | small_fix | 1 | verified_complete · 3 calls · 7,700 tok · 6s · orchestrated:tiny | verified_complete · 8 calls · 20,640 tok · 7s · orchestrated:normal | 12,940 |

_Every number above is recomputed from the raw run records by scripts/r23-efficiency-report.mjs; nothing is hand-entered._
