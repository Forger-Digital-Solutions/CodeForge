# Actual role measurements

All requests used exact catalog-verified free Kilo models and current reverified policy, public frozen qualification cases and unchanged thresholds. Selective qualification can measure complete Explorer/Planner/Reviewer protocols separately; skipped roles stay NOT_TESTED. No truncated, interrupted or unmeasured role is promoted.

| Model / probe | Status | Calls | Measured roles |
|---|---|---|---|
| dots-studio/dots-3-note-preview:free ([receipt](qualification-dots-studio_dots-3-note-preview_free-1791464849592.json)) | INCONCLUSIVE_PROVIDER_FAILURE | 19 | CODER: QUALIFIED; TOOL_AGENT: PROBATION; ANALYST: NOT_QUALIFIED; EXPLORER: PROBATION; PLANNER: QUALIFIED; REVIEWER: NOT_TESTED |
| liquid/lfm-2.5-2.6b:free ([receipt](qualification-liquid_lfm-2.5-2.6b_free-1791466230688.json)) | INCONCLUSIVE_PROVIDER_FAILURE | 6 | CODER: QUALIFIED; TOOL_AGENT: PROBATION; ANALYST: NOT_QUALIFIED; EXPLORER: NOT_TESTED; PLANNER: NOT_TESTED; REVIEWER: NOT_TESTED |
| nvidia/nemotron-3.5-lightning:free ([receipt](qualification-nvidia_nemotron-3.5-lightning_free-1791465864045.json)) | INCONCLUSIVE_PROVIDER_FAILURE | 26 | CODER: QUALIFIED; TOOL_AGENT: PROBATION; ANALYST: NOT_QUALIFIED; EXPLORER: PROBATION; PLANNER: NOT_TESTED; REVIEWER: NOT_TESTED |
| poolside/laguna-s-2.1:free ([receipt](qualification-poolside_laguna-s-2.1_free-1791464804626.json)) | INCONCLUSIVE_PROVIDER_FAILURE | 2 | CODER: PROBATION; TOOL_AGENT: NOT_QUALIFIED; ANALYST: NOT_QUALIFIED |
| thinkingmachines/inkling-small:free ([receipt](qualification-thinkingmachines_inkling-small_free-1791466536425.json)) | INCONCLUSIVE_PROVIDER_FAILURE | 1 | CODER: NOT_QUALIFIED; TOOL_AGENT: NOT_QUALIFIED; ANALYST: NOT_QUALIFIED |
| dots-studio/dots-3-note-preview:free ([receipt](reviewer-dots-studio_dots-3-note-preview_free-1791465616770.json)) | INCONCLUSIVE_PROVIDER_FAILURE | 8 | CODER: QUALIFIED; TOOL_AGENT: PROBATION; ANALYST: NOT_QUALIFIED; EXPLORER: PROBATION; PLANNER: QUALIFIED; REVIEWER: NOT_TESTED |

Dots has measured Coder and Planner passes, but its full probe timed out before review and a separate Reviewer probe hit an organic 502. Nemotron-Lightning's Coder passed while the suite deadline left planning/review untested. Liquid's compact Coder passed but its Reviewer probe was interrupted. These partial measurements are preserved; transient receipts are not production admission. Poolside-S upstream failure and Inkling's provider failure remain inconclusive. No new conclusive independent Reviewer exists.

Carried current R71 Cohere receipt qualifies Explorer, Coder, Tool Agent and Analyst; Planner and Reviewer hard failures remain excluded. A candidate with another suitable role is never automatically suitable for review. [Machine-readable summary](qualification-summary.json).
