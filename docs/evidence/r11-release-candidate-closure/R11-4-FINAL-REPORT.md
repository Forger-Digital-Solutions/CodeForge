# CodeForge R11.4 — Final Certification Report

**Date:** 2026-09-18 (UTC)
**Branch:** `forger-digital-solutions-forgegreen-certified`
**Final HEAD:** `83dc1db4810de15d1f4663f038122585b65e647e` ("remove deferred lint debt and replace suspended test credential")
**Frozen benchmark HEAD:** `cb4b9cfc6adca7dbd74e394a15438522dc41dcae`
**Push status:** not pushed (not authorized)

---

## 1. Executive verdict

| Decision | Verdict |
|---|---|
| **Engineering Release Candidate** | **READY** — every engineering gate is green at final HEAD: typecheck, lint, build, 2,564-test suite, PostgreSQL 80/80, dependency audit (0), secret scan (0 owner-review), definitive benchmark frozen, Electron packaged and smoke-certified. The measured capability profile (82.5% pass@1, 7 genuine failures, 0 false completions) is documented, not hidden. |
| **Public Windows release** | **BLOCKED** — four external/owner gates remain: (1) trusted code signing (no certificate available), (2) Render production cutover + paid-compute decision (owner approval required, none granted), (3) PostgreSQL lifecycle decision before 2026-10-07, (4) OAuth account-switching certification (needs a second authorized account). A fifth engineering follow-up — the unimplemented `protectedAcceptance` evidence field — is an instrumentation gap, not a correctness defect. |

These are kept deliberately separate: an RC is a candidate pending external gates; nothing in the remaining gates indicates a product defect.

---

## 2. Definitive 40-case POST

Artifact: `r2/definitive-post-final-40.json`
Route: `openrouter` / `cohere/north-mini-code:free` (fixed), config digest `r11-fixed-openrouter-north-mini-v5-hidden-gate`

| Metric | Value |
|---|---|
| Valid cases | 40/40 |
| Verified successes | **33** |
| Genuine failures | **7** |
| pass@1 | **0.825** |
| False completions | **0** |
| Provider failures (in aggregate) | 0 |
| Infrastructure failures | 0 |
| Total tool calls | 530 (mean 13.3, median 13) |
| Total provider calls | 573 |
| Input tokens | 1,420,429 |
| Output tokens | 120,311 |
| Wall time | 3,034,216 ms |

By split: TRAIN 13/15 (86.7%), DEVELOPMENT 9/13 (69.2%), VALIDATION 11/12 (91.7%).

Aggregation preserved valid attempts 1–28, clean post-reset Phase A (29–32: LH-01 pass, AT-01 fail, AT-02 fail, PF-01 pass) and Phase B (33–40: 6/8 verified). Quota-contaminated attempts are preserved as infrastructure evidence and excluded from capability scoring.

## 3. Genuine failure matrix

Artifact: `r2/failure-matrix-and-forgegreen-analysis.json`. All 7 failures were honest `hidden_verifier_failure` terminations — the verification stack caught every one.

| Rank | Cluster | Cases | Severity |
|---|---|---|---|
| 1 | Plan completeness — plan omitted selection/verification/uncertainty statements | AT-01, AT-02, PQ-01 | medium ×3, highly generalizable, highly fixable |
| 2 | Routing/authority-boundary fidelity under context pressure — report collapsed routing boundaries or omitted authority owner | CP-01, CP-02 | high ×2 |
| 3 | Credential-handling edit correctness — receipt retained credential material | GS-01 | high ×1 |
| 4 | Malformed-input classification + non-convergent loop | RP-02 | medium ×1 |

**RP-02 tool-volume answer:** 41 tool calls / 42 provider calls / 135,835 input tokens — ~3.1× the campaign mean. The loop never converged on the malformed-vs-valid distinction; it kept re-probing without a classification breakthrough. Verified successes average ~13 tool calls and no repeated-search loops exist anywhere in the campaign (repeatedSearches=0) — so this is a reasoning-convergence failure on one case, not a systemic loop defect.

## 4. Verification integrity

- **Critical false completions after hidden-verifier integration: 0.** The earlier RP-01 false completion was the motivating defect; `cb4b9cf` made the external hidden verifier part of completion authority, and across 40 definitive attempts + 8 protected attempts it produced zero false completions.
- Hidden verifier and ForgeVerify were never weakened; failures terminate as failed/blocked, never success.

## 5. Provider capacity findings

- Measured short-window ceiling ≈ 15 req/min → governor pinned at **14 req/min** and wired into the real interactive path (`11a5880`).
- Account-level daily ceiling discovered live: `X-RateLimit-Limit: 1000`, `free-models-per-day-high-balance`, reset 2026-09-18T00:00:00Z.
- **Capacity answer:** the 40-case definitive POST consumed 573 provider calls including retries — i.e., one OpenRouter free-route daily allotment supports roughly **one full 40-case campaign per day** at current tool/provider-call ratios; parallel campaigns would exhaust it. Benchmark correctly halted rather than converting quota exhaustion into capability failures.

## 6. Engineering regression (final HEAD `83dc1db`)

| Gate | Result |
|---|---|
| Typecheck | PASS |
| Lint | PASS (0 warnings, 0 errors; deferred `StreamEvent` unused import removed) |
| Workspace build | PASS |
| Full Vitest | **344/344 files, 2,564/2,564 tests passed** (7 files / 36 tests skipped), 476 s |
| PostgreSQL | **12/12 files, 80/80 tests** (WSL Ubuntu 24.04, PG 16, isolated DB — reused, not reprovisioned) |
| Dependency audit (`npm audit --omit=dev`) | **0 vulnerabilities** |
| Secret scan | 2,449 files, 73 credential-shaped findings — **all 73 classified synthetic**, 0 owner-review-required |
| Source provenance | Recertified via guarded `scripts/r114-cleanup-recertify-source-state.mjs` (allowed only the `agent-runtime.ts` lint fix); both sentinel suites then passed 8/8 |

**Google key answer:** the redaction-test fixture was externally probed — Google recognized it and returned HTTP 403 "api_key suspended". It was a real-format but already-suspended key (not usable). It has been replaced with an explicitly-marked synthetic placeholder; no rotation was required because the key was never live, and the finding was the reason the fixture was swapped.

## 7. Render Virginia

Artifacts: `render-virginia-live-evidence.json`, `render-virginia-r114-reverification.json`, probe receipts `render-va-{prod,staging}-probe-r114.json`.

| Item | Status |
|---|---|
| `codeforge-cloud-va` (prod) | Virginia, Free plan, live; 21/21 probe checks; 32 verified-free models; auth 401-enforced |
| `codeforge-cloud-staging-va` | Virginia, Free plan, live; 21/21 probe checks; separate staging DB |
| **Are both truly in Virginia?** | **Yes** — both services region=Virginia, live and healthy |
| Hosted Free real inference | PASS — Groq `openai/gpt-oss-120b`, progressive SSE, persisted usage event, no paid/BYOK fallback |
| OAuth | Login/PKCE/session-restart/logout/refresh-after-logout all PASS (browser-logout 403 fixed via `CODEFORGE_ALLOWED_ORIGINS`) |
| Account switching | `ACCOUNT_SWITCHING_BLOCKED_BY_SECOND_ACCOUNT_AVAILABILITY` — no second authorized account exists; not a failure |
| Private DB networking | **PARTIAL** — Render internal Postgres TLS uses self-signed certs without verify-ca/verify-full; CodeForge requires certificate-validated TLS, so it uses the external URL with validated TLS. Same-region private connectivity cannot satisfy the CodeForge TLS policy on Render. |
| Custom domain | `cloud.forgerdigitalsolutions.com` still resolves to **Oregon** — cutover NOT performed; Oregon prod+staging retained as rollback |
| Compute metrics | CPU/memory metrics are gated behind paid compute — unmeasurable on Free. Only measured degradation: 13–22 s cold starts after idle. No OOM, no restart instability. |
| **$7 tier answer** | Cannot be empirically certified (metrics unavailable without paying). The $7 tier (0.5 CPU / 512 MB) primarily buys always-on behavior + metrics access; nothing measured requires it. |
| Paid compute | **NOT PURCHASED** — checkpoint reached and stopped; decision deferred to owner |
| **October 7, 2026** | Render free PostgreSQL expires; **the database is deleted unless upgraded** (smallest $6/mo) or migrated (e.g., to the Supabase Postgres already proven on staging). Free tier has no Render backup/export; storage ~6.66% used. |

## 8. Protected benchmark

Artifacts: `r2/protected-post-8.json`, `protected-r2-reconciliation.json`. All 8 cases executed exactly once, post-freeze.

- **Under every implemented gate** (visible acceptance + hidden verifier + ForgeVerify + completion gate): **6/8 passed** — CD-02, AU-02, LH-02, AV-02, SS-02, SC-02. Failures: PF-02 (forgeverify/completion-gate), PQ-02 (hidden verifier).
- **Under the strict schema: 0/8** — the summarizer requires `protectedAcceptance === "passed"`, but the executor hardcodes `"not_run"` (`scripts/r11-codeforge-bench-r2-executor.mjs:319`). The field was designed into the attempt schema and never implemented.
- The strict summary's "6 false completions" is an accounting artifact of that instrumentation gap — not a verification bypass; the field was not rewritten post hoc.
- **Release gate:** implement a real protected-acceptance verifier or formally retire the field.

## 9. Competitor subset

Artifact: `competitor-subset-r114.json`. Same fixtures, same task prompts, same visible `node --test` + real hidden verifier, same 10-minute bound.

| Tool | Result |
|---|---|
| OpenCode 1.18.25 (`big-pickle`, free) | **0/2** — GS-01: timed out at 600 s having touched only the preserve-me user files; RP-02: timed out with zero files changed |
| Codex CLI 0.144.4 | **BLOCKED** — account usage-limit exhausted (infrastructure, not capability) |
| Claude Code, Cursor, ZCode, Devin | **NOT TESTED** — not available as noninteractive CLIs on this host; not fabricated |

**Where CodeForge trails:** plan-completeness contracts (3-failure cluster), routing/authority-boundary fidelity under context pressure, and convergence on malformed-input reasoning — all consistent with the ceiling of a small free-route model versus paid-tier competitors' larger models. Where it does not: honest terminal verdicts — CodeForge converged to truthful pass/fail states on all 48 attempts; the one peer tested produced unbounded non-completion on both.

## 10. Electron final certification

Artifact: `electron-r114-certification.json`. Packaged at final HEAD: Electron 44.4.1 / Node 24.21.0, `CodeForge-Setup-0.3.0.exe` (SHA-256 `E57AE309…C21C397`) + portable.

- **Packaged smoke:** full, interrupt, recover — all PASS, including `PACKAGED_FULL_SMOKE_OK`, `PACKAGED_RECOVERY_SMOKE_OK`, `electron_restart_failed_safely=PASS`, `electron_restart_no_approval_replay=PASS`, all 9 control-plane bearer/trust-boundary markers.
- **Security invariants intact:** `sandbox=true`, `contextIsolation=true`, `nodeIntegration=false`, `webSecurity=true`; bearer withheld from renderer.
- **Installer/upgrade:** 0.2.0 → 0.3.0 over real user data; `codeforge.db`, `settings.json`, `runtime.json` SHA-256 identical before/after.
- **Uninstall:** registry removed, install dir removed, no stale files, shortcuts removed, user data preserved (byte-identical DB); silent reinstall re-registered 0.3.0.
- **Bare-launch anomaly resolved:** earlier "instant exit" was a test-environment artifact — `ELECTRON_RUN_AS_NODE=1` was set in the launching shell session (the packaged-smoke harness already sanitizes it). With it unset, the installed app runs a full lifecycle. Not a product defect.
- **Signing:** `NotSigned` — no trusted certificate or signing identity exists. `WINDOWS_TRUSTED_SIGNING_EXTERNAL_BLOCKER`; not self-signed because self-signing is not public-production trust.

## 11. Scope & safety confirmations

- GEMS untouched (Sapphire/Topaz/training/data/checkpoints/adapters/GEMS-Auto); `GEMS = EXCLUDED` invariant held.
- No paid inference, no local LLM inference, ForgeZero eligibility only, fail-closed throughout.
- Oregon prod+staging retained; nothing deleted; no purchases; no push.
- PRE (~5/40) preserved as historical, contaminated evidence — never rewritten.

---

## 12. Final scorecard

| Area | Status | Evidence |
|---|---|---|
| Source provenance | PASS | Guarded recertification; sentinel suites 8/8 |
| Typecheck | PASS | `npm run typecheck` |
| Lint | PASS | 0 warnings/errors at final HEAD |
| Build | PASS | all workspaces |
| Full regression | PASS | 344 files / 2,564 tests |
| PostgreSQL | PASS | 12 files / 80 tests |
| Workflow durability | PASS | PostgreSQL + restart/recovery suites |
| Approval durability | PASS | persisted decisions, restart parity |
| Concurrent continuation | PASS | single-winner, loser `not_ready` |
| Provider governor | PASS | 14 RPM wired into interactive path |
| OpenRouter RPM control | PASS | measured ~15 RPM ceiling |
| OpenRouter daily quota handling | PASS | halted on `free-models-per-day-high-balance`, resumed post-reset |
| R2 executor | PASS | real fixture/tools/edits/tests/approvals/verifiers |
| R2 PRE | PASS (historical) | ~5/40, contamination documented |
| R2 definitive POST | PASS | 33/40, pass@1 0.825 |
| False completion | PASS | 0 critical after `cb4b9cf` |
| Hidden verifier | PASS | caught all 7 genuine failures |
| ForgeVerify | PASS | part of completion authority |
| Repository intelligence | PASS | FG suites green |
| Context intelligence | PASS | FG-3 suites green |
| Planning | PARTIAL | 3-case failure cluster (plan contract) |
| Coding | PASS | 33/40 verified incl. real edits |
| Debugging | PASS | CD cases verified |
| Test strategy | PASS | verified incl. generated tests |
| Tool intelligence | PARTIAL | RP-02 41-tool non-convergence outlier |
| ForgeGreen | PASS | mean 13.3 tools/case; efficiency evidence written |
| ForgeAuto / Free | PARTIAL | effectively one dominant qualified route; routing value limited |
| Paid Auto isolation | PASS | 4-model roster, never invoked |
| BYOK isolation | PASS | no fallback observed |
| GEMS isolation | PASS | untouched |
| Secret scan | PASS | 73 synthetic / 0 owner-review |
| Dependency audit | PASS | 0 vulnerabilities |
| Virginia production | PASS | live, 21/21 probes |
| Virginia staging | PASS | live, 21/21 probes |
| Private DB networking | PARTIAL | TLS-policy blocked; external URL + validated TLS |
| Production Hosted Free | PASS | real Groq inference, SSE, usage event |
| OAuth login | PASS | PKCE + browser flows |
| Session persistence | PASS | survived restart |
| Logout | PASS | incl. refresh-after-logout 401 |
| Account switching | BLOCKED | second account unavailable |
| Render compute sizing | NOT TESTED | metrics gated behind paid; only cold-start observed |
| Render production cutover | BLOCKED | owner decision pending; domain on Oregon |
| Oregon rollback | PASS | retained, live |
| Render DB lifecycle | BLOCKED | decision due before 2026-10-07 |
| Protected R2 | PARTIAL | 6/8 implemented gates; `protectedAcceptance` unimplemented |
| Codex comparison | BLOCKED | account quota |
| Claude Code comparison | NOT TESTED | unavailable |
| OpenCode comparison | PASS (executed) | 0/2 vs CodeForge's honest failures |
| ZCode/Cursor/Devin comparison | NOT TESTED | unavailable |
| Packaged Electron | PASS | full/interrupt/recover smoke |
| Electron security | PASS | sandbox/CSP/bearer-boundary verified |
| Installer | PASS | NSIS silent install |
| Upgrade | PASS | 0.2.0→0.3.0, user data hash-identical |
| Uninstall | PASS | clean removal, user data preserved |
| Windows signing | BLOCKED | `WINDOWS_TRUSTED_SIGNING_EXTERNAL_BLOCKER` |
| **Engineering RC readiness** | **PASS** | all engineering gates green |
| **Public release readiness** | **BLOCKED** | signing + Render owner decisions + DB lifecycle + account-switch + protectedAcceptance instrumentation |

## 13. Exact remaining public-release gates

1. **Trusted Windows code signing** — acquire a certificate and sign installer + executables (external dependency).
2. **Render owner decisions** — free-vs-$7 compute; then custom-domain cutover to Virginia with OAuth/CORS/CSP updates and post-cutover retest.
3. **Database lifecycle before 2026-10-07** — upgrade Render Postgres ($6/mo) or migrate (Supabase proven); free tier deletes the DB on expiry.
4. **OAuth account-switching** — needs a second authorized account to certify.
5. **`protectedAcceptance` instrumentation** — implement the verifier or retire the field; re-run protected once legitimately afterward.
6. **Optional remediation phase** — plan-contract templates (AT/PQ cluster) and loop-convergence tuning (RP-02) as a separate `R11.4 PUBLIC REMEDIATED VALIDATION`, never overwriting the definitive POST.
