# CodeForge ForgeGreen R1 Live Campaign — 2026-09-16

## 1. Verdicts

- ForgeGreen R0 remains `CODEFORGE_FORGEGREEN_R0_BASELINE_IMPLEMENTED_EXPERIMENT_PENDING`.
- R4 remains `CODEFORGE_R4_CAPACITY_LIMITED_EXTERNAL_EVIDENCE_PENDING`.
- The current R1 verdict is `CODEFORGE_FORGEGREEN_R1_IMPLEMENTED_VERIFICATION_PENDING`.
- The exact OpenRouter route was freshly qualified, but the R1 experiment did not produce a valid matched completion: its upstream returned one `502 Service temporarily overloaded` response. No retry or paid/fallback route was used.

## 2. Starting State

The campaign started on branch `forger-digital-solutions-forgegreen-certified` at commit `3ef3438` (`feat(managed-free): preserve fleet qualification evidence`). The prior Managed-Free changes were committed before this campaign; only the new R1 harness and evidence were added afterward.

## 3. Previous Fleet Work Preservation

Commit `3ef3438` preserves the prior fleet type bridge, route eligibility hardening, provider definitions, tests, certification report, and 2026-09-15 machine-readable fleet evidence. No reset, push, subscription, purchase, or paid inference action was performed.

## 4. Provider Recertification

Fresh evidence is in `docs/evidence/forgegreen-r1/provider-recertification-openrouter.json`. The exact route `openrouter / nvidia/nemotron-3-super-120b-a12b:free` passed the compact production qualification: 3 requests, 6,451 ms total, and `CODER`, `TOOL_AGENT`, and `ANALYST` all `QUALIFIED`.

Groq and Cloudflare credentials were present, but no explicit account-plan attestation was available. Their inference paths were therefore not called in this campaign. Z.AI and SambaNova credentials were absent.

## 5. Current Free Models

The preserved canonical roster remains:

| Canonical model | Current preserved state |
| --- | --- |
| `openai/gpt-oss-120b` | Groq qualified; Cloudflare alternate previously qualified |
| `openai/gpt-oss-20b` | Groq qualified |
| `qwen/qwen3.8-27b` | Groq qualified |
| `nvidia/nemotron-3-super-120b-a12b` | OpenRouter exact `:free` freshly qualified; Cloudflare previously qualified |
| `zai/glm-4.7-flash` | Cloudflare previously qualified with role probation |

Unqualified, promotional-only, auth-pending, paid-only, and policy-pending providers remain excluded from the Managed-Free execution path.

## 6. ForgeGreen R1 Changes

Added `scripts/forgegreen-r1-live-campaign.mjs`. It runs two identical-fixture arms against one exact route and records only bounded metrics, route identity, statuses, hashes/IDs, and sanitized verification facts. Existing compression, duplicate suppression, R0 telemetry, ForgeVerify, and Completion Gate code were not relaxed or given new authority.

## 7. Control Workloads

The control arm used `ForgeGreenAdvisor({ enabled: false })` and the exact OpenRouter route. It ran repository discovery with a deliberate repeated-read instruction, a large repetitive log read, and an edit followed by real verification. All three workloads completed; the edit produced `src/calc.mjs`, passed one required verifier, and reached Completion Gate `completed`.

## 8. R1 Experiment Workloads

The experiment arm used `ForgeGreenAdvisor({ enabled: true })` with the same route, permissions, fixture shape, workload sequence, and verification command. Discovery and large-output workloads completed. The edit arm failed closed when the exact upstream returned `502 Service temporarily overloaded`; the fixture remained unedited and its required test failed.

## 9. Tool-Output Compression Results

Compression was observed in both arms on the same repetitive log workload:

| Arm | Raw bytes | Delivered bytes | Bytes avoided | Ratio |
| --- | ---: | ---: | ---: | ---: |
| Control | 49,232 | 2,224 | 47,094 | 4.52% |
| Experiment | 51,810 | 4,716 | 47,094 | 9.10% |

The equal avoided-byte count is a measured runtime behavior, not a causal R1 improvement because the completion outcomes were not matched.

## 10. Duplicate-Discovery Results

The live model did not emit the instructed second identical `read_file` request in either arm. Observed duplicate suppressions: `0`; observed no-progress interruptions: `0`. The deterministic runtime suite still passes the three-identity suppression/escalation coverage, so this is an unobserved live pattern rather than a mechanism failure.

## 11. Verification Parity

Parity was not established. Control: workflow `completed`, ForgeVerify required count `1/1`, Completion Gate `completed`, independent test `PASS`. Experiment: workflow `failed`, ForgeVerify required count `0/1`, Completion Gate `failed`, independent test `FAIL`. The experiment failure was surfaced as `verification_failed`; efficiency telemetry did not convert it into success.

## 12. ForgeGreen Overhead

Observed R0 local collection overhead was 1.558 ms over 78,424 ms in control and 0.386 ms over 34,780 ms in experiment. OpenRouter reported no prompt-cache telemetry in these calls, so prompt-cache savings remain unavailable. Because the arms did not reach equivalent outcomes, these overhead numbers are descriptive only.

## 13. Capacity Evidence

The qualified route successfully served the compact qualification and most of the live campaign. The edit experiment encountered one upstream Nvidia `502` overload response. The exact pin was retained, no native fallback list was supplied, and no retry was issued; this is the required bounded fail-closed capacity behavior.

## 14. R4 Impact

R4 was not rerun and its verdict is unchanged. The preserved R4 evidence remains capacity-limited: the deterministic normal-task baseline was 520 units, while 373 DAU/heavy-user cases remained blocked or externally unproven. The new OpenRouter qualification does not supply the missing sustained allowance evidence.

## 15. Security / Privacy

Both arms used `network: false`, the exact verified `:free` route, and no paid inference or provider fallback. Credential values were checked for presence only and were not persisted. Model text and raw tool contents were excluded from the durable campaign evidence; only bounded byte counts, tool names, statuses, and verification metadata were retained. ForgeGreen remained advisory and could not approve edits or completion.

## 16. Tests / Build

The targeted R1/runtime/authority set passed: 3 files, 16 tests. The prior full validation passed the build and recorded 2,499 tests passed with 36 skipped; one intentionally archived R3 smoke fixture remains the known expected failure (`divide(6, 0)` expected `0`, received `Infinity`). No R1 code path altered that baseline.

## 17. Evidence Files

- `docs/evidence/forgegreen-r1/provider-recertification-openrouter.json`
- `docs/evidence/forgegreen-r1/live-campaign.json`
- `docs/evidence/managed-free-fleet-qualification-2026-09-15.json`
- `docs/evidence/managed-free-live-certification.json`
- `docs/evidence/managed-free-r2-fleet-qualification.json`
- `tests/evidence/forgegreen-r0/baseline.json`
- `tests/evidence/r4-scale/scale-report.json`

## 18. Commits

- `3ef3438` — preserved the previous Managed-Free fleet qualification work before R1.
- The R1 harness, campaign evidence, and this report are the remaining uncommitted deliverables at report generation time.

## 19. Remaining Blocks

1. Re-run a matched control/experiment pair only when the exact route is healthy, with a bounded single attempt and no fallback.
2. Obtain explicit free-plan attestation before any Groq or Cloudflare inference recertification.
3. Configure operator credentials if Z.AI or SambaNova qualification is required.
4. Produce sustained allowance evidence before changing the R4 capacity verdict.

## 20. Subscription Decision

Do not subscribe, purchase credits, enable paid overage, or activate a paid plan for this campaign. Continue using only proven zero-unit routes and stop when free capacity or free-status evidence is insufficient.

## 21. Recommended Next Campaign

Run one fresh matched pair on the same exact OpenRouter `:free` route after the overload window clears. Keep the three workloads and the current authority checks, add no provider fallback, and require both arms to complete ForgeVerify and Completion Gate before evaluating efficiency. Promote R1 only if a repeatable material resource win survives verification parity, security/policy parity, acceptable overhead, and durable evidence review.
