# Large-task failure analysis

The locked task `ts-large-context-rename-config-key` asks for a cross-module `maxRetries` to `retryLimit` rename in a 1,200-file fixture, with an independent hidden semantic verifier. The visible workflow verifier is only `node --check src/config/load-config.ts`, which cannot establish the rename's semantics. The completion gate correctly blocked all reviewed failures.

| Run | Free route | Requests | Tool calls / reads / writes | Changed paths | Visible / hidden | Terminal result |
| --- | --- | ---: | --- | ---: | --- | --- |
| R28 `263ed6b4` | Nemotron 3 Super via OpenRouter | 8 | 8 / 4 / 2 | 2 | pass / fail | blocked, unfinished plan |
| R28 `46283ec8` | Nemotron 3 Ultra via OpenRouter | 44 | 31 / 16 / 7 | 7 | pass / fail | blocked, unfinished plan |
| R28 `f6ddbc7e` | Nemotron 3 Super via OpenRouter | 20 | 15 / 8 / 6 | 6 | pass / fail | blocked, unfinished plan |
| R29 `3186b00c` | Nemotron 3 Super via OpenRouter | 30 | 26 / 14 / 7 | 7 | pass / fail | blocked, four unfinished plan steps |
| R29 `d6e1dd92` | Same route, diagnostic replay | 4 | 1 / 1 / 0 | 0 | pass / fail | blocked after provider network failure |

The R28 receipts' `+0/-0` figures did **not** prove no-op writes. `packages/workflow/src/diff-review.ts` previously calculated additions and deletions from total line-count differences, so a same-line replacement appeared as `+0/-0`. The receipt recorded modified paths, but omitted the actual diff and content hashes. R29 corrected the line accounting and added byte-identical write rejection; the R29 first run reported seven changed paths with `+1/-1` each. This is a telemetry correction, not a claim that the hidden verifier passed.

The first R29 run used 451,482 ms, 30 requests, 26 tools, 14 reads, and seven writes. All seven expected source paths were modified. The visible syntax check passed; the hidden verifier failed; four plan steps remained unfinished. The receipt does not contain the exact first-run diff, so the semantic defect cannot be assigned to a particular file. The model-turn limit and weak visible verifier are plausible contributors, but the evidence does not isolate either as the sole cause.

The diagnostic replay used 67,294 ms. Its first model response succeeded, then three OpenRouter calls failed with `provider_network` / `Stream failed: fetch failed`. It made no source changes. Its hidden verifier failed seven of nine checks, as expected for the unchanged fixture. This replay cannot measure whether the revised implementation prompt improves completion quality.

The receipts do not expose per-step plan state, context compaction, or all attempted edits, so those dimensions remain unproven. No paid or unknown-cost route was used. The large-task capability ceiling remains open; a multi-task benchmark battery and successful hidden-verifier replay are still required before claiming recovery.
