# ForgeGreen runtime efficiency

ForgeGreen reduces measurable computational work upstream of CodeForge’s canonical authorities. It does not weaken verification, permissions, approvals, security, or completion standards.

## Boundary

The directional flow is:

`repository facts → Repository Intelligence → ForgeGreen analysis → efficiency recommendations → canonical authorities → execution / verification / approval / completion`

ForgeGreen never returns a permission, approval, verification authority, execution authority, or completion verdict. Its verification output is explicitly `VerificationRecommendation` and its completeness is `candidate-only`, `bounded`, or `unknown`; an empty candidate set is never proof of no impact.

## Runtime integration

`AgentRuntime` shares a bounded `ForgeGreenAdvisor` with `ContextAssembler` and `ModelExecutionAdapter`.

- Context keys include workspace identity, repository generation, task identity, role, retrieval-policy version, context budget, feature version, and authority state.
- Context reuse is rejected when any identity component changes. Repository generation is obtained after Repository Intelligence refresh.
- Immutable context fragments are keyed by content hash. No private conversation, credentials, approvals, mutable sibling worktree state, or secret-bearing payload is stored in this cache.
- Stable system/tool prefixes are observed through a provider-neutral interface. Provider token accounting is reported as `unavailable` when the provider does not expose it; ForgeGreen never invents cache reads or writes.
- Duplicate model requests are fingerprinted with provider/model, messages, tools, request parameters, user identity, and authority state. Failures are not cached, and cancellation interrupts a deduplicated wait.
- Verification recommendations are emitted alongside verification telemetry, but the existing canonical verifier and `evaluateCompletion` gate always execute and decide.

## Failure and disable behavior

Missing, stale, corrupt, ambiguous, timed-out, or unavailable efficiency analysis uses the existing safe path and records `safe_fallback` or `analysis_unavailable`. `CODEFORGE_FORGREEN=0` disables the optimization layer and returns canonical behavior. Optimization exceptions are not allowed to become permission or completion decisions.

## Evidence

`EfficiencyReceipt` records bounded, inspectable work quantities: context requested/delivered tokens, tokens avoided, cache hits, duplicate requests avoided, fallback use, reason codes, repository generation, and policy version. It does not expose a universal green score and makes no carbon, energy, or emissions claim.

Blast-radius false-negative auditing and acceptance-level sufficiency auditing remain separate concerns. A prior pass, cache hit, retrieval score, impact estimate, or flaky classification cannot certify current verification or completion.
