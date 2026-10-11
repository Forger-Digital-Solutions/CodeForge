# R85 independent-review findings matrix

Prior qualified independent reviews recovered from R84 evidence (`r82-review-*.json`, `r83-review-*.json`).

## Reviewer context

- Qualified reviewer (internal evaluation only): `kilo-free-direct/nvidia/nemotron-3-ultra-550b-a55b:free`, suite `R73_ROLE_QUALIFICATION_V7`, protocol `REVIEWER_PROTOCOL_V4`, qualified 2026-10-10, score 0.875. NVIDIA trial terms → `INTERNAL_PUBLIC_SOURCE_EVALUATION_ONLY_NVIDIA_TRIAL` classification; not production-eligible.
- R84 hardened transport: bounded packets (≤48k chars), output budget (≤6000 tokens), 120s deadline, schema validation, served-model verification, fail-closed — all verified by `reviewer-contract-final.json` (17/17) and `model-review.test.ts`.

## Finding-to-resolution matrix

| ID | Severity | Finding | Evidence | R85 status |
|---|---|---|---|---|
| R82-TIMEOUT | blocking | R82 review exceeded 120s deadline; earlier attempt hit upstream 503 inside a 200 SSE envelope | `r82-review-0e681d9b*.json` status=BLOCKED | OPEN — fresh bounded R85 review required |
| R83-001 | blocking | No completed independent review; all review addenda BLOCKED (R82 503; ENOENT packets; budget exceeded) | `r83-review-620d8e2f*.json` | OPEN — R85 review packet prepared + dispatched with hardened transport |
| R83-002 | blocking | "Full workspace build and repository lint fail outside changed ForgeAAA scope" | R84 `build-after.log`, `lint-after.log` both PASS | RESOLVED — re-verified on R85 baseline (build PASS, lint 0 errors/1514 files) |
| R83-003 | advisory | Director status explicitly PARTIAL | `director.status=FORGEAAA_PARTIAL` | OPEN — unchanged; PARTIAL is the honest status until complete qualified review + full validation |
| R83-004 | advisory | R82 timeout retained; no independent zero-touch free quota redundancy (R76) | R84 gate G BLOCKED | OPEN — R85 live-qualified two BlockRun coding models (laguna-xs, muse-glimmer) CODER; availability is intermittent; conclusive-window qualification in progress |
| R83-005 | advisory | Gameplay/persistence prior failures (through-wall interact, exit-vs-open-leaf) repaired | R84 native receipts | RESOLVED — R84 replay-exit receipt; R85 regression re-run pending |

## Notes

- R83-002 was a *documented-versus-actual* conflict: the reviewer's cited knownFailures came from milestone notes; R84 receipts prove build/lint green. No code defect existed — the correct resolution is fresh evidence in the R85 packet, not source edits.
- Reviewer transport reliability (Phase B3): bounded packets already enforced (`packetMaxChars` ≤84k, enforced in `createModelReviewer`); the R82 timeout was an upstream/deadline event, not a truncation defect. R85 review uses the same 120s deadline + structured schema validation.
- Independence: the reviewer model did not author the reviewed work (deterministic adapters/scripts + prior-milestone agents) → `independent: true` is honest for milestone-scope review.
