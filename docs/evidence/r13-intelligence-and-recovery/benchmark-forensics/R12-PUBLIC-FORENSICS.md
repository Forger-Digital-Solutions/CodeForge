# R12 public benchmark forensics

Recorded: 2026-09-18. Inputs are the immutable R11 definitive artifact (`docs/evidence/r11-release-candidate-closure/r2/definitive-post-final-40.json`) and immutable R12 public artifact (`docs/evidence/r12-release-closure/codeforge-bench-r2/r12-public.json`). No R12 artifact was edited.

## Method and limits

Every R12 public attempt used the exact fixed route `openrouter / cohere/north-mini-code:free`, one `solo` topology, zero alternatives considered, and zero configured fallbacks. A fixed-route benchmark is useful for comparable capability measurement, but it deliberately does not exercise normal ForgeAuto free-route replacement. The `tools/context` columns below are R12 actual counts. `FV` means ForgeVerify. `N/A` in the regression column means the case did not regress from R11.

Failure categories distinguish a provider execution fault from a model/agent failure. A rate-limited attempt remains an official R12 failure, not an adjusted pass.

| Case | R11 | R12 | Model/provider | Role/topology | Provider error | Tools/context | Verification result | Failure category | Rate-limited | Genuine capability regression? |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| CBR1-RU-01 | PASS | PASS | north-mini-code:free / OpenRouter | repository understanding / solo | — | 10 / 25,623 | FV passed | — | No | N/A |
| CBR1-RU-02 | PASS | PASS | north-mini-code:free / OpenRouter | repository understanding / solo | — | 24 / 81,903 | FV passed | — | No | N/A |
| CBR1-SF-01 | PASS | PASS | north-mini-code:free / OpenRouter | simple fix / solo | — | 6 / 14,381 | FV passed | — | No | N/A |
| CBR1-SF-02 | PASS | PASS | north-mini-code:free / OpenRouter | simple fix / solo | — | 9 / 19,660 | FV passed | — | No | N/A |
| CBR1-MF-01 | PASS | PASS | north-mini-code:free / OpenRouter | multi-file / solo | — | 16 / 48,539 | FV passed | — | No | N/A |
| CBR1-MF-02 | PASS | PASS | north-mini-code:free / OpenRouter | multi-file / solo | — | 10 / 22,762 | FV passed | — | No | N/A |
| CBR1-DB-01 | PASS | PASS | north-mini-code:free / OpenRouter | debugging / solo | — | 9 / 19,680 | FV passed | — | No | N/A |
| CBR1-DB-02 | PASS | PASS | north-mini-code:free / OpenRouter | debugging / solo | — | 12 / 33,764 | FV passed | — | No | N/A |
| CBR1-TR-01 | PASS | PASS | north-mini-code:free / OpenRouter | tests/refactor / solo | — | 7 / 16,557 | FV passed | — | No | N/A |
| CBR1-TR-02 | PASS | PASS | north-mini-code:free / OpenRouter | tests/refactor / solo | — | 8 / 18,670 | FV passed | — | No | N/A |
| CBR1-RP-01 | PASS | PASS | north-mini-code:free / OpenRouter | regression prevention / solo | — | 8 / 19,847 | FV passed | — | No | N/A |
| CBR1-RP-02 | FAIL | FAIL | north-mini-code:free / OpenRouter | regression prevention / solo | — | 41 / 154,729 | visible pass; hidden fail; FV blocked | VERIFICATION_FAILURE | No | N/A — unchanged genuine failure |
| CBR1-LR-01 | PASS | PASS | north-mini-code:free / OpenRouter | large repository / solo | — | 10 / 23,828 | FV passed | — | No | N/A |
| CBR1-LR-02 | PASS | PASS | north-mini-code:free / OpenRouter | large repository / solo | — | 11 / 26,426 | FV passed | — | No | N/A |
| CBR1-CP-01 | FAIL | PASS | north-mini-code:free / OpenRouter | context pressure / solo | — | 13 / 38,136 | FV passed | — | No | Recovered |
| CBR1-CP-02 | FAIL | PASS | north-mini-code:free / OpenRouter | context pressure / solo | — | 12 / 27,608 | FV passed | — | No | Recovered |
| CBR1-VR-01 | PASS | PASS | north-mini-code:free / OpenRouter | verification resistance / solo | — | 11 / 27,013 | FV passed | — | No | N/A |
| CBR1-VR-02 | PASS | PASS | north-mini-code:free / OpenRouter | verification resistance / solo | — | 17 / 41,235 | FV passed | — | No | N/A |
| CBR1-RC-01 | PASS | PASS | north-mini-code:free / OpenRouter | refactor/change / solo | — | 6 / 15,400 | FV passed | — | No | N/A |
| CBR1-RC-02 | PASS | PASS | north-mini-code:free / OpenRouter | refactor/change / solo | — | 8 / 21,789 | FV passed | — | No | N/A |
| CBR1-TE-01 | PASS | PASS | north-mini-code:free / OpenRouter | test engineering / solo | — | 10 / 23,850 | FV passed | — | No | N/A |
| CBR1-TE-02 | PASS | PASS | north-mini-code:free / OpenRouter | test engineering / solo | — | 17 / 44,452 | FV passed | — | No | N/A |
| CBR1-RD-01 | PASS | PASS | north-mini-code:free / OpenRouter | repository diagnosis / solo | — | 6 / 16,131 | FV passed | — | No | N/A |
| CBR1-RD-02 | PASS | PASS | north-mini-code:free / OpenRouter | repository diagnosis / solo | — | 9 / 25,603 | FV passed | — | No | N/A |
| CBR2-CD-01 | PASS | PASS | north-mini-code:free / OpenRouter | code diagnosis / solo | — | 11 / 25,578 | FV passed | — | No | N/A |
| CBR2-TC-01 | PASS | PASS | north-mini-code:free / OpenRouter | tool calling / solo | — | 9 / 25,386 | FV passed | — | No | N/A |
| CBR2-TC-02 | PASS | PASS | north-mini-code:free / OpenRouter | tool calling / solo | — | 15 / 43,101 | FV passed | — | No | N/A |
| CBR2-AU-01 | PASS | PASS | north-mini-code:free / OpenRouter | authority use / solo | — | 15 / 39,410 | FV passed | — | No | N/A |
| CBR2-LH-01 | PASS | PASS | north-mini-code:free / OpenRouter | long horizon / solo | — | 8 / 22,797 | FV passed | — | No | N/A |
| CBR2-AT-01 | FAIL | FAIL | north-mini-code:free / OpenRouter | authority transition / solo | — | 10 / 23,087 | visible pass; hidden fail; FV blocked | PLANNING_FAILURE | No | N/A — unchanged genuine failure |
| CBR2-AT-02 | FAIL | FAIL | north-mini-code:free / OpenRouter | authority transition / solo | — | 21 / 58,764 | visible pass; hidden fail; FV blocked | PLANNING_FAILURE | No | N/A — unchanged genuine failure |
| CBR2-PF-01 | PASS | FAIL | north-mini-code:free / OpenRouter | policy/ForgeVerify / solo | — | 42 / 197,855 | visible+hidden pass; FV blocked | MODEL_RELIABILITY (R13-reclassified; was VERIFICATION_FAILURE) | No | **No** — see `../routing/PF-01-ROOT-CAUSE.md`. Zero commits between R11's frozen benchmark commit and R12 closeout change any runtime behavior; the harness's own 5-minute per-case timeout expired while this trial's turn was still genuinely executing (21 approvals/42 tool calls vs. R11's 2/19) — CodeForge's verification never started, nothing was lost or misreported |
| CBR2-AV-01 | PASS | PASS | north-mini-code:free / OpenRouter | adversarial verification / solo | — | 12 / 27,329 | FV passed | — | No | N/A |
| CBR2-GS-01 | FAIL | FAIL | north-mini-code:free / OpenRouter | governance/security / solo | — | 16 / 42,309 | visible pass; hidden fail; FV blocked | AUTHORITY_BOUNDARY_FAILURE | No | N/A — unchanged genuine failure |
| CBR2-GS-02 | PASS | FAIL | north-mini-code:free / OpenRouter | governance/security / solo | — | 40 / 165,445 | visible pass; hidden fail; FV blocked | MODEL_RELIABILITY (R13-reclassified; was AUTHORITY_BOUNDARY_FAILURE) | No | **No** — see `../routing/GS-02-SS-01-ROOT-CAUSE.md`. The hidden verifier is a real, required `verificationCommands` entry CodeForge itself ran (not external-only); it correctly caught the model's broken redaction. Recorded outcome: `"Failed safely after 0 repair attempt(s)"` — zero false completion. No code diff between R11/R12 exists to explain the flip |
| CBR2-SS-01 | PASS | FAIL | north-mini-code:free / OpenRouter | secret safety / solo | — | 11 / 30,451 | visible pass; hidden fail; FV blocked | MODEL_RELIABILITY (R13-reclassified; was AUTHORITY_BOUNDARY_FAILURE) | No | **No** — same finding as GS-02, see `../routing/GS-02-SS-01-ROOT-CAUSE.md`. ForgeVerify failed safely, correctly, with no false completion |
| CBR2-SC-01 | PASS | PASS | north-mini-code:free / OpenRouter | scope control / solo | — | 16 / 39,839 | FV passed | — | No | N/A |
| CBR2-PQ-01 | FAIL | FAIL | north-mini-code:free / OpenRouter | planning quality / solo | — | 9 / 30,116 | visible+hidden fail; FV blocked | PLANNING_FAILURE | No | N/A — unchanged genuine failure |
| CBR2-RV-01 | PASS | FAIL | north-mini-code:free / OpenRouter | reviewer quality / solo | HTTP 429; `free-models-per-day-high-balance` | 37 / 138,783 | visible+hidden pass; FV blocked only by unfinished plan | PROVIDER_RATE_LIMIT | Yes | **No** — capability answer and fixture verification were already correct |
| CBR2-RV-02 | PASS | FAIL | north-mini-code:free / OpenRouter | reviewer quality / solo | HTTP 429; same daily limit | 0 / 0 | visible+hidden fail after no model response; FV blocked | PROVIDER_RATE_LIMIT | Yes | **Not measurable** — no model output was obtained |

## Delta classification

R12's **official 30/40** is honest and unchanged. The net three-point score change contains two recoveries (CP-01/CP-02) and five new failures: PF-01, GS-02, SS-01, RV-01, RV-02. Two are provider-contaminated rate-limit failures (RV-01, RV-02).

**Update (R13, 2026-09-18):** the remaining three (PF-01, GS-02, SS-01) were investigated in full — see `../routing/PF-01-ROOT-CAUSE.md` and `../routing/GS-02-SS-01-ROOT-CAUSE.md`. They are **not CodeForge regressions**. `definitive-post-final-40.json`'s `frozenCommit` establishes R11's entire 40-case campaign ran at one commit (`cb4b9cf`); the only commit between that and R12 closeout (`935ac48`) is `83dc1db`, whose full diff is behaviorally inert (an unused type-import removal plus a test-fixture credential swap). No CodeForge source change exists that could explain a behavioral difference in any of the 40 cases. PF-01 is a harness-timeout artifact (verification never started; nothing lost). GS-02/SS-01 are ForgeVerify correctly, honestly failing a genuinely-broken model output on one of two single, non-deterministic trials — the recorded outcome literally says "Failed safely." All three are best explained as free/weak-model trial variance, not a "general mechanism" bug — and are, if anything, positive evidence that ForgeVerify held correctly under model failure in both runs. One real, general, unrelated defect (`capacity-governor.ts`'s evidence-blindness) was found while investigating PF-01 and fixed on its own merits.

## Rate-limit reconciliation

| Fact | CBR2-RV-01 | CBR2-RV-02 |
| --- | --- | --- |
| Provider / model | OpenRouter / `cohere/north-mini-code:free` | OpenRouter / `cohere/north-mini-code:free` |
| HTTP behavior | 429 after 38 provider calls | 429 on its only provider call |
| Provider metadata captured in body | limit 1,000; remaining 0; reset field begins `178977600000` before the historical string is truncated | same rate-limit family; artifact records capacity wait 64,968 ms |
| Retry-After | not recorded as a header; the truncated historical body does not prove the reset field's unit | not recorded |
| RPM / TPM / account quota / concurrent requests | not exposed by the immutable attempt evidence; not inferred | not exposed by the immutable attempt evidence; not inferred |
| Alternative route | none: exact fixed route, 0 alternatives, 0 fallbacks | none: exact fixed route, 0 alternatives, 0 fallbacks |
| Was ForgeAuto failover expected? | No. The test intentionally disabled alternative routing. Production nevertheless needed to capture the reset and hold the route. | Same |
| Waste conclusion | The route was called until a daily exhaustion response; its reset header was not delivered to 8-Bit's quota view. | A later attempt was allowed against the known exhausted daily pool after a short wait; this is avoidable capacity-observability waste. |

R13 repairs the observed weakness without changing the benchmark: the OpenRouter adapter now emits response quota headers; 8-Bit parses absolute reset horizons when `Retry-After` is absent; known exhausted routes fail admission before dispatch; and deterministic capacity advice penalizes scarce eligible free routes. Focused provider, registry, router, and capacity-governor tests currently pass.
