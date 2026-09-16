# CodeForge ForgeGreen R1R Recertification — 2026-09-16

## 1. Verdict

`CODEFORGE_FORGEGREEN_R1_EXTERNAL_PROVIDER_PENDING`.

The causal audit is complete and the old equal-savings result is explained. The exact OpenRouter route was probed once, but the bounded preflight returned HTTP 200 without a usable completion shape, so no matched provider pair was started. R1 remains uncertified; no causal improvement claim is made.

## 2. Starting State

Repository truth at campaign start: branch `forger-digital-solutions-forgegreen-certified`, HEAD `fc33717f37e622038b09710e4c285722c281427f` (`feat(forgegreen): record managed-free r1 live campaign`), clean before R1R changes. The prior fleet-preservation commit `3ef3438` remains in ancestry. No reset or push was performed.

## 3. Causality Audit

The previous control and experiment both avoided `47,094` bytes because the old arm toggle changed only the `ForgeGreenAdvisor` behavior. In `packages/server/src/agent-runtime.ts`, `DuplicateActionSupervisor` is created for every run and the runtime calls `compressToolOutput(toolExec.output, ...)` for every executed tool result. The compressed representation is placed in model history while the authoritative output remains on the tool record and event stream.

The disabled arm therefore still compressed the same repetitive log as the enabled arm. The advisor flag gates context caches, immutable-fragment reuse, stable-prefix observation, model-request deduplication, and verification recommendations; it is not a switch for tool-output compression or duplicate/no-progress supervision. The exact trace is recorded in [causality-audit.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/causality-audit.json).

## 4. Pre-Existing vs R1 Behavior

The honest classification is `PRE-EXISTING FORGEGREEN FOUNDATION` for deterministic tool-output compression, raw-evidence preservation, and duplicate/no-progress supervision as they existed before the prior live R1 harness. R1/R1R adds live-route qualification and measurement harnessing; it does not receive credit for inventing those always-on mechanisms.

No production compression-disable bypass was added. A safe behavioral A/B control was not present, so causal attribution is unresolved rather than manufactured.

## 5. Provider Preflight

Exact route: `openrouter/nvidia/nemotron-3-super-120b-a12b:free`.

One bounded POST was sent with one message, `max_tokens: 1`, no tools, no fallback, and zero retries. It returned HTTP `200` in `508 ms`, but no usable `choices` response was observed. Classification: `MALFORMED_PROVIDER_RESPONSE` / provider availability ambiguous. Evidence: [provider-preflight.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/provider-preflight.json).

## 6. Matched Pair

Not started. The preflight failed closed before live agent execution. The harness is prepared to use two disposable Git worktrees at the same fixture commit/tree hash, the same exact route, task, tools, permissions, budgets, verification command, ForgeVerify policy, and Completion Gate.

## 7. Control Result

`NOT_REACHED` in R1R. The intended control is the historical baseline: `ForgeGreenAdvisor({ enabled: false })`, with always-on compression and duplicate/no-progress supervision explicitly retained.

## 8. Experiment Result

`NOT_REACHED` in R1R. The intended experiment is normal `ForgeGreenAdvisor({ enabled: true })` behavior on the same exact route and fixture.

## 9. Tool-Efficiency Result

No new live bytes were measured because the pair did not run. The previous live campaign measured `47,094` avoided bytes in both arms; that is valid within-run observation of the existing compression mechanism, not an R1 causal delta. Current evidence is [tool-efficiency.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/tool-efficiency.json).

## 10. Causal Delta

Unsupported. The old toggle did not isolate the target mechanism, so the R1R causal delta is `UNKNOWN`, not zero and not a claimed improvement.

## 11. Duplicate Discovery

The previous live pair observed zero natural duplicate suppressions and zero no-progress interruptions. Deterministic local coverage proves the mechanism and escalation behavior; no synthetic duplicate calls were added. R1R live duplicate discovery was not reached.

## 12. ForgeVerify Parity

`NOT_REACHED` for the R1R pair. The authority boundary remains intact: ForgeVerify is independent of ForgeGreen efficiency accounting. See [verification-parity.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/verification-parity.json).

## 13. Completion Gate Parity

`NOT_REACHED` for the R1R pair. `evaluateCompletion` remains the only completion authority and cannot be satisfied by compression or telemetry alone.

## 14. ForgeGreen Overhead

No new live overhead was measured. Prompt-cache telemetry remains `UNKNOWN` for this campaign. The existing local telemetry and compression tests passed; [overhead.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/overhead.json) records the live measurement as not reached.

## 15. Provider Failure Classification

The preflight result is classified as provider-response availability ambiguity, not agent failure, task failure, ForgeVerify failure, or Completion Gate failure. No retry, fallback, quota evasion, paid inference, or refund logic was used.

## 16. R4 Status

Unchanged: `CODEFORGE_R4_CAPACITY_LIMITED_EXTERNAL_EVIDENCE_PENDING`. The single failed/ambiguous preflight supplies no sustained-capacity evidence and does not justify rerunning the R4 simulator.

## 17. Tests / Build

Focused ForgeGreen/authority tests: `52 passed` across 7 files. Typecheck/build compilation: PASS. Full Vitest: `2,499 passed, 1 known archived R3 smoke failure, 36 skipped`; no new R1R failure was observed. Details: [test-summary.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/test-summary.json).

## 18. Evidence Files

- [causality-audit.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/causality-audit.json)
- [provider-preflight.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/provider-preflight.json)
- [matched-pair.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/matched-pair.json)
- [matched-campaign.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/matched-campaign.json)
- [tool-efficiency.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/tool-efficiency.json)
- [verification-parity.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/verification-parity.json)
- [overhead.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/overhead.json)
- [test-summary.json](/G:/CodeForge/docs/evidence/forgegreen-r1r/test-summary.json)

## 19. Commit

Pending one local commit after final evidence/report review. No push.

## 20. Remaining Blocks

1. The exact OpenRouter route must return a valid bounded completion before a matched pair can run.
2. A causal treatment delta remains unavailable because the existing advisor toggle does not control compression or duplicate supervision.
3. Full R1 certification remains withheld until live verification parity is demonstrated.

## 21. Subscription Decision

Do not subscribe, purchase credits, enable paid overage, or use a paid/fallback route. The campaign remains strictly exact-route `:free` only.

## 22. Recommended Next Campaign

After the exact route is demonstrably healthy, run the prepared one-pair harness once. Keep the causal claim scoped to the true treatment difference; if no safe production behavior can be isolated, report only verified within-run efficiency and retain the unresolved-causality verdict.
