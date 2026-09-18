# CodeForge R12 final release qualification

Date: 2026-09-18  
Baseline: R11.4 at `83dc1db4810de15d1f4663f038122585b65e647e`  
R12 source state: `bd3d3f943a3e986ae0c58f9aae8665df3732549482e8d7015e1c9a3c19b9d2a3`

## Final verdicts

- **Engineering:** `ENGINEERING_RC_NOT_READY`
- **Hosted service:** `HOSTED_RELEASE_BLOCKED`
- **Windows public release:** `WINDOWS_PUBLIC_RELEASE_BLOCKED_EXTERNAL_SIGNING`

The engineering test and safety gates are green, but the fresh R12 capability campaign regressed from R11.4 and the protected campaign was rate-limited. That is a genuine release-quality blocker; it is not converted into a pass by the green unit suite or by the Render upgrade.

## What changed since R11.4

R12 added a real evidence-backed `protectedAcceptance` contract with explicit accepted, rejected, not-applicable, and infrastructure-blocked states; task-sensitive planning completeness validation; immutable authority and untrusted-data contracts; read-only mission-planner/replanner role ceilings; general credential-field redaction; and bounded no-progress read-signal escalation. Focused tests cover accepted/rejected protected evidence, malformed and missing evidence, planning obligations, role boundaries, redaction, and duplicate-suppression behavior.

The changes are general. The benchmark-integrity audit found no production branch keyed to a case ID, fixture filename, hidden expected value, or individual failure ID. R11 evidence and result files were preserved.

## Benchmark result

The new public artifact is `codeforge-bench-r2/r12-public.json`: 30/40 verified successes, pass@1 `0.750`, 0 false completions, 607 provider calls, 562 tool calls, 149,799 output tokens, and 3,266,669 ms total wall time. R11.4 was 33/40 (`0.825`), approximately 573 provider calls, 530 tool calls, 120,311 output tokens, and 3,034,216 ms. R12 therefore regressed by three cases and increased measured resource use.

The R12 protected artifact is `codeforge-bench-r2/r12-protected.json`: 8/8 executed, 0 verified successes, 0 false completions. All attempts were honestly rejected and the free OpenRouter route hit its daily rate limit. The protected result is `BLOCKED_EXTERNAL`, not a hidden pass.

## R11 failure families

- Planning completeness (AT-01, AT-02, PQ-01): the general validator and deterministic tests are present, but the R12 hidden plan verifier still failed. This family is not closed.
- Authority/routing boundaries (CP-01, CP-02): the general authority contract and role tests pass; direct campaign proof is not established. Protected AU-02 still reported an omitted authority owner before rate limiting.
- Credential retention (GS-01): redaction is generalized and source tests pass, but R12 GS-01, GS-02, and SS-01 hidden verifiers still found credential retention. This remains a failure requiring investigation.
- Malformed-input convergence (RP-02): the general detector and difficult-legitimate-read tests pass, but R12 CBR1-RP-02 still failed its hidden verifier. Campaign-level convergence is not fixed.

## Validation and security

The final validation run passed 346 Vitest files and 2,573 tests, with 7 skipped. Typecheck, lint, workspace build, dependency audit, targeted secret scan, source-state sentinels, and benchmark-integrity audit passed. The R12 secret scan recorded 670 source files, 118 synthetic findings, and 0 owner-review findings. ForgeVerify and completion-authority behavior retained zero false completions.

Electron packaging passed and the unpacked Windows artifact was produced. Authenticode verification correctly reports `NotSigned`; R11 lifecycle evidence still covers full smoke, interrupt/recover, upgrade, uninstall, reinstall, and byte-identical user-data preservation. The signing pipeline is technically documented and ready for an owner-controlled certificate, but no certificate was purchased or fabricated.

## Render and hosted service

The Render dashboard was rechecked after the owner action. Virginia production `codeforge-cloud-va` (`srv-dam6f83m8hqs73clo5ig`) is live on `0.5c-512mb`, and deploy `dep-dama02bm8hqs73d2a40g` reports `Deploy succeeded | Live` after `Compute plan updated`. The deploy logs showed healthy verified-free OpenRouter/Groq discovery, `hostedFree=true`, `stripe=disabled`, and `dbTls=true`.

At the owner’s request, the three unused web services were suspended: `codeforge-cloud-staging-va`, `codeforge-cloud-staging`, and `codeforge-cloud`. Virginia PostgreSQL remains active as the production dependency. No billing or payment action was taken by the agent.

Virginia staging is therefore intentionally suspended and remains `BLOCKED_OWNER_DECISION` for hosted release. The custom domain still routes to Oregon, so DNS/domain migration was not performed. Oregon remains a rollback/legacy dependency until a separately authorized cutover and traffic/dependency verification.

## Database, accounts, and external blockers

The Render PostgreSQL free-tier deletion deadline remains **2026-10-07**. The migration/upgrade plan documents authority, export/backup, TLS, schema, row-count, migration-version, session/account/OAuth linkage, connectivity, and rollback checks. No destructive migration was attempted; the owner must choose and authorize the supported path before the deadline.

No second authorized account was available. Account invalidation, PKCE, fresh-login, identity isolation, credential isolation, and local account-scoping coverage were audited, but real second-account switching remains `EXTERNAL_TEST_BLOCKER_SECOND_ACCOUNT`.

## Release gate conclusion

CodeForge is not ready for public release as R12. The codebase is internally buildable and the safety/regression suite is green, but the capability score regressed, protected capability measurement was blocked by provider quota, the custom domain is not on Virginia, staging is suspended, the database lifecycle decision is outstanding, account switching is externally untestable, and Windows artifacts are unsigned. The next release action is to investigate the R12 capability regression and rerun a clean benchmark with adequate free-provider capacity; no owner billing, certificate purchase, DNS cutover, database deletion, or second-account assumption should be inferred.

The exact gate classifications are in `final-release-gate-matrix.json`; measured comparison is in `forgegreen-efficiency-comparison.json`; detailed benchmark artifacts remain under `codeforge-bench-r2/`.
