# R73 autonomous completion receipts

The runner `benchmarks/r73/live-campaign.mjs` calls the production autonomous orchestrator, workspace service, subagents, Eight-Bit fabric, ForgeZero, real tools, real Node tests and git integration in isolated public fixtures. It does not substitute scripted provider output. Individual campaigns include raw inference frames, persisted workers/journals/decisions, tests before/after, review/verification/integration results and parent status. A final invariant rejects a false `completed` result.

## Preserved attempts before packet recovery

| Receipt | Actual outcome |
| --- | --- |
| `R73-FIRST-COMPLETION.json` | Blocked. Initial BlockRun catalog unavailable, correctly excluded. Explorer completed; Coder applied the correct `< maxAttempts` edit and passed three tests but continued into watch mode and redundant exploration until its 25-turn cap. No independent review, ForgeVerify or integration. The changed isolated child remains preserved. |
| `R73-COMPLETION-RECOVERY-1791538224699.json` | Blocked. Current BlockRun Reviewer available. Explorer completed; Coder completed the correct edit and finite tests after the headless/progress fix. Reviewer executed ten genuine model requests and nine read-only tools, then emitted a raw tool instruction rather than the required schema. Replacement admission excluded that incompatible route. No approval, ForgeVerify or integration was fabricated. |

The first campaign captured tool events correctly but kept mutable request-message references; its final request histories reflect the final conversation. That historical limitation is retained. Subsequent tracing snapshots requests/events at invocation and therefore preserves each actual turn independently.

The measured Reviewer protocol offers no tools. The second attempt exposed that production nevertheless offered the full read-only tool menu to a Reviewer-only model without qualified Tool Agent capability. The bound-evidence recovery implementation and its final live result are recorded below when validated; until then these attempts do not close the completion gate.

## Required completion authority

Completion requires the actual independent structured review, workspace-bound ForgeVerify, successful integration and `evaluateCompletion` outcome. Passing tests in an isolated Coder child is useful progress, never a parent completion. The mission metrics in `reliability-summary.json` count only parent results satisfying those conditions. The controlled tasks are bug fix, feature and refactor; a three-task streak is an initial milestone rather than broad production reliability.

Final live campaign results are to be reconciled with `R73-RELIABILITY.md`, `R73-REVIEWER-RECOVERY.md` and the final delivery report. All earlier failed attempts remain part of the reliability denominator.
