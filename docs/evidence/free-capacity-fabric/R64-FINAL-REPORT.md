CODEFORGE_R64_PARTIAL

R64 added the Free Capacity authorization screen, repeated real Kilo coding, completed bounded repository validation, deployed the exact validated revision, and passed 17 authenticated production control-transport checks. The central two-domain product proof remains blocked: the user has no eligible second Free account. Production remote dispatch composition and dedicated Cloudflare/Groq Free account verifiers also remain unfinished. No eligibility, privacy, billing, role qualification, verification, or completion gate was relaxed.

## 1. Repository state

Branch: `codex/r29-release-closure`. Starting HEAD: `f1ceb4a34a97c0bbae4553994148c465fce44c1d`. R64 implementation and build-fix commits descend from it. Five of the six pre-existing modified files retain their recorded SHA-256 values. The full repository suite regenerated the already-modified `docs/evidence/r34-capacity-efficiency/context-efficiency-benchmark.json`; its original bytes were not backed up and could not be recovered exactly. It remains unstaged. This is a preservation failure, not an unchanged-file claim. Unrelated benchmark and screenshot debris was not staged, reset, or cleaned. See `R64-START-STATE.json`, `R64-PRESERVED-USER-WORK.json`, and `R64-FAILURE-CLASSIFICATION.json`.

## 2. R63 baseline

The starting Free Capacity certificate verified. Baseline focused checks passed 28 tests across five files; baseline transport, sponsor, delegated entitlement, and authority checks passed 59 tests across five files. ForgeGreen FG11 was 5/5 and FG12E was 3/3. Historical R63 bounded validation was 531 files, 4,411 passed, zero failed, and 50 skipped. The certificate's older summary metadata still described R62; R64 replaces that stale metadata with current validation while preserving historical evidence.

## 3. Provider connection readiness

| Candidate | Authorization / storage | Automated Free admission and qualification | Result |
|---|---|---|---|
| Puter | Provider has browser sign-in; safe CodeForge Free connection is unavailable | Not enabled | Published allowance metadata does not establish a Free-versus-purchased spend boundary. UNKNOWN; denied. |
| Cerebras | Existing encrypted local key-entry path | Durable Free account verifier unavailable | Current public offer is trial credit; no durable Free account receipt obtained. Denied. |
| Cloudflare Workers AI | Existing encrypted key path; no configured CodeForge OAuth client with required account and AI scopes | Account verifier and dedicated Free workflow unfinished | Existing subscription lookup returned 403. Ownership, Workers Free tier, quota and hard stop remain unverified. Denied. |
| OpenRouter | Settings → Free Capacity → Connect OpenRouter Free → browser OAuth PKCE → loopback callback → encrypted local storage | Current-key tier, owner and quota verification; automatic domain admission and role qualification after passing | Workflow implemented. Existing account is PAID; user reported no eligible Free account. No Domain B admitted. |
| Groq | Existing encrypted local key-entry path | Dedicated organization ownership/tier/quota verifier unfinished | A saved or environment key cannot establish independent Free organization capacity. UNKNOWN; denied. |

Primary sources checked: [Puter allowance metadata](https://docs.puter.com/Objects/monthlyusage/), [Cerebras offer](https://www.cerebras.ai/inference), [Cloudflare Free billing boundary](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Cloudflare OAuth](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/), [OpenRouter OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth), [OpenRouter quota metadata](https://openrouter.ai/docs/api_reference/limits), and [Groq organization limits](https://console.groq.com/docs/rate-limits). Details: `R64-PROVIDER-READINESS.json` and `R64-PROVIDER-ENTITLEMENT-PROBE.json`.

## 4. Domain A

Kilo Gateway, `kilo-free-direct`, `kilo-auto/free`, anonymous direct credential class, EGRESS_IP quota owner, one shared/unknown egress independence group. A real provider coding run completed: `run-b71679c8-6339-4d11-bc30-5c8df2a88671`. It inspected the public fixture, changed `math.ts`, passed all three Node tests, passed an independent Reviewer with two advisory findings, passed ForgeVerify and the completion gate, and integrated the verified change. This is a live public fixture using a logical test identity, not a second real CodeForge user.

Current inherited role qualification was disclosed rather than presented as new R64 probes. Coder, Tool Agent, Analyst, Planner and Reviewer were qualified; Explorer remained probationary. Policy was reverified in R64. Thirteen persisted model turns reported 49,236 input and 3,813 output tokens. Provider request IDs were not exposed by the current turn records. Cost remains UNKNOWN; zero-billing eligibility comes from entitlement provenance. See `R64-DOMAIN-A-LIVE.json`, `R64-KILO-POLICY.json`, `R64-KILO-QUALIFICATION.json`, and `R64-LIVE-ACCOUNTING.json`.

## 5. Domain B

BLOCKED. No independently owned, authoritatively verified Free entitlement was authorized. The exact human response was: “I don’t have an eligible Free account.” The environment OpenRouter current-key request returned `is_free_tier=false`; no inference was sent through it. No paid, purchased, promotional, unknown, or shared developer credential was counted as Domain B. Qualification, coding, Reviewer, ForgeVerify and integration through Domain B were not run.

## 6. Cross-domain failover

Live A→B and B→A failover: NOT PROVEN. Successful live failovers: zero. No synthetic domain or synthetic quota receipt was counted as a live domain. Existing deterministic authority and isolation coverage remains green. See `R64-CROSS-DOMAIN-FAILOVER.json`.

## 7. Multi-user independence

User A fixture domain: Kilo EGRESS_IP shared/unknown group. User B domain: absent. Overlap: not exercised with two independent real users. Same or unknown Kilo egress remains one group. Credential, quota, health and accounting isolation retain deterministic coverage; they are not claimed as live concurrent-user proof. See `R64-MULTI-USER-INDEPENDENCE.json`.

## 8. Production deployment

Existing service: `codeforge-cloud-va`, `srv-dam6f83m8hqs73clo5ig`, [production](https://codeforge-cloud-va.onrender.com), CodeForge workspace `tea-daa3l35g1s2s73c1t8mg`. Previous revision: `1b34b4bbda4bf7904c09cbd72c3c546013d93c3d`; previous deployment: `dep-daqrg3m1egvs73dc4cb0`. Auto-deploy remains off. Environment values stayed masked and unchanged.

First deployment `dep-davuah2d0e5s739dmtfg`, revision `9c6b6ef11aa2dadab984e99e71549ebe242810a0`, failed at clean TypeScript compilation. The server imported four packages omitted from its project references. The fix adds those references; no runtime source changed. A clean Linux Docker image built in 90.3043357 seconds, and a module-import check passed with networking disabled and no production secrets. All nine existing cloud migration checksums match the deployed source; nine additional migrations are present.

Retry: `dep-davui349v7es73989kt0`, deployed revision `84c08956d61c143c65f0c147a78fed94648a2254`, status LIVE. The retry began at `2026-10-02T17:25:32.364877Z` and finished at `2026-10-02T17:27:27.46257Z`. Production HTTP verification at `2026-10-02T17:32:00.898Z` reported that exact revision and service ID; liveness and readiness both returned 200. Unauthenticated remote bootstrap returned 401. The final evidence-only commit descends from this production revision; it does not alter deployed runtime source. See `R64-PRODUCTION-DEPLOYMENT.json` and `R64-PRODUCTION-HEALTH.json`.

## 9. Remote transport live proof

CONTROL_TRANSPORT_VERIFIED_EXECUTION_UNPROVEN. Normal GitHub sign-in and desktop PKCE exchange succeeded against production. All 17 checks passed between `2026-10-02T17:32:46.554Z` and `2026-10-02T17:33:25.972Z`: exchange, deployed health, unauthenticated denial, wildcard scope denial, unregistered workspace denial, owner workflow creation, matching owner bootstrap, poll, heartbeat, malformed acknowledgement/result/feedback denial, session revoke, revoked poll denial, own-workflow cancellation, own-device logout, and logged-out access denial. Session: `remote-session-30aa0c1c-ce57-4c62-8117-e44792402aee`. Credentials remained in memory, zero inference was requested, and the temporary workflow and device session were canceled/logged out. Poll returned zero assignments. See `R64-PRODUCTION-REMOTE-TRANSPORT.json`.

Assignment, delivered runtime frame, valid acknowledgement, result, scoped feedback, completion, recovery, wrong real user, expired assignment, replayed acknowledgement and duplicate result remain NOT PROVEN live. The production entrypoint does not instantiate the exported remote Fabric host composition, so admission remains denied and dispatch is reported as unconfigured. Source/local authority tests do not substitute for this missing live execution proof.

## 10. Free wallet isolation

Purchased credit leakage: no leakage observed in the Kilo-only live fixture; deterministic isolation tests passed. Paid Auto leakage: none observed; deterministic coverage passed. BYOK leakage: none observed; deterministic coverage passed. No paid inference was used for account diagnosis, deployment verification, or the prepared transport probe. All-Free exhaustion, recovery and stale/revoked route rejection remain deterministically covered; two-domain live proof is blocked. UNKNOWN request cost is not reported as a measured $0 bill.

## 11. Fresh-user proof

A separate fresh source-build Electron profile was launched against the production endpoint with zero initial saved credentials. The production endpoint was selected in the generated build manifest; no provider credential or manual database entry was injected. The dedicated settings section and OAuth handoff passed rendering and authority tests. Normal human sign-in, second-provider authorization, and end-to-end coding from that profile were not completed. This is PARTIAL, not a fresh-user acceptance pass. The separate Kilo live fixture does not establish a fresh desktop user's no-credential onboarding journey. See `R64-FRESH-USER.json`.

## 12. Provider privacy classifications

| Candidate | Conservative classification | Admission consequence |
|---|---|---|
| Kilo | PUBLIC_ONLY | Private source denied; public fixture had explicit consent. |
| Puter | UNKNOWN | Private source denied. |
| Cerebras | UNKNOWN | Private source denied. |
| Cloudflare Workers AI | PRIVATE_CODE_ALLOWED by documented data policy, subject to model license and route checks | Account remains unadmitted; no private source sent. |
| OpenRouter | REQUIRES_EXPLICIT_CONSENT and upstream policy verification | No private source sent through unverified routing. |
| Groq | REQUIRES_ACCOUNT_DATA_CONTROL_VERIFICATION | Account remains unadmitted; no private source sent. |

Cloudflare documents that it does not train on Customer Content without explicit consent: [data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/). Groq documents default inference retention limits and organization-controlled ZDR: [data controls](https://console.groq.com/docs/your-data). OpenRouter and upstream provider policies are separate: [privacy](https://openrouter.ai/privacy). These documentary classifications do not admit an unverified account. Details: `R64-PRIVACY-CLASSIFICATIONS.json`.

## 13. Capacity metrics

Scope: the R64 public live fixture, not a global production inventory. Admitted Free domains: one. Independent groups: one. Healthy coding groups observed during the run: one. Live coding domains: one. Successful live failovers: zero. Paid fallback: zero observed. BYOK fallback: zero observed. Live two-domain false-wait count: NOT MEASURED. Multiple models and users on unknown/shared Kilo egress were not counted as independent groups. See `R64-CAPACITY-METRICS.json`.

## 14. Repository validation

Resource-bounded validation: **533 files, 4,415 passed, zero failed, 50 skipped, zero pending, zero todo; 2,703.355 seconds** summed phase duration. Main pass: 529 files/4,382 passed. Four serial suites: 22, 4, 1 and 6 passed. Workers: two in the main pass, one in each serial phase; heap cap: 2,048 MiB. Independent observed process-tree peak: **1,142,542,336 bytes (1,089.6 MiB)**; peak single process: 370,638,848 bytes. The independent monitor began six minutes into the run and sampled every 15 seconds; this is an observed-window peak, not a complete continuous maximum.

Workspace build passed in 102.4278095 seconds. Workspace, desktop main/renderer and cloud typechecks passed. The later repair changed build ordering and certification/evidence only; runtime and test source bytes match the full-run revision. The clean Docker build and network-disabled Linux module load validate that repair. Final focused/certification rerun: eight files, 41 passed, zero failed, including the standalone certificate canary. Repeated focused assertions are not added to the repository totals. No heap exhaustion or EPIPE occurred. Earlier UI expectation drift and secret-scan false positives were corrected without weakening policy; see `R64-FAILURE-CLASSIFICATION.json`.

## 15. Source certification

Certificate: `r64-free-capacity-fabric-v1`. Free Capacity byte verification: PASS. ForgeGreen FG11: 5/5; FG12E: 3/3. Standalone certificate canary: 1/1. Current guarded source-state ID: `24ed80d52717fa147540dd4063f0306e66ab9738611e0b54590c643a550bd5ae`. Certificate source coverage includes connection UX, entitlement and independence authorities, wallet isolation, transport and dispatch admission, accounting, verification, completion, and the clean-build configuration. Final production and preservation evidence are incorporated in the certificate; successful certification does not convert the missing live execution proofs or preservation failure into passes.

## 16. Remaining blockers

- An eligible independently owned second Free account has not been authorized.
- Production lacks the actual remote Capacity Fabric dispatch composition; transport endpoint availability does not prove remote execution.
- Dedicated Cloudflare and Groq authoritative Free account verification remains unfinished; Puter spend-boundary and Cerebras durable entitlement proof remain unavailable.
- Live two-domain coding/failover, overlapping independent real users, and fresh desktop onboarding cannot be claimed.
- Exact recovery of the initial already-modified R34 benchmark bytes was unavailable after the test suite regenerated that file.

## 17. Evidence paths

All R64 evidence is under `G:\CodeForge\docs\evidence\free-capacity-fabric\`. Requested proof files are `R64-PROVIDER-AUTH-READINESS.json`, `R64-DOMAIN-A-LIVE.json`, `R64-DOMAIN-B-LIVE.json`, `R64-DOMAIN-INDEPENDENCE.json`, `R64-DOMAIN-B-QUALIFICATION.json`, `R64-CROSS-DOMAIN-FAILOVER.json`, `R64-MULTI-USER-LIVE.json`, `R64-FRESH-USER.json`, `R64-FREE-EXHAUSTION.json`, `R64-REMOTE-PRODUCTION-DEPLOYMENT.json`, `R64-REMOTE-PRODUCTION-LIVE.json`, `R64-WALLET-ISOLATION.json`, `R64-PROVIDER-PRIVACY.json`, `R64-PROVIDER-CANDIDATES.json`, `R64-CAPACITY-METRICS.json`, `R64-REPOSITORY-TESTS.json`, and `R64-FAILURE-CLASSIFICATION.json`. Blocked proofs explicitly say BLOCKED or NOT PROVEN. Additional raw evidence includes `R64-START-STATE.json`, `R64-PRESERVED-USER-WORK.json`, `R64-PROVIDER-ENTITLEMENT-PROBE.json`, `R64-LIVE-ACCOUNTING.json`, the five `R64-suite-*.json` reports, `R64-memory-observations.json`, `R64-WORKSPACE-BUILD.json`, `R64-CLEAN-DOCKER-BUILD.json`, `R64-PRODUCTION-FIRST-DEPLOYMENT-FAILURE.json`, `R64-PRODUCTION-HEALTH.json`, `R64-final-canaries.json`, `R64-certificate-canary.json`, and `R64-secret-scan.json`. Authority certificate: `G:\CodeForge\docs\evidence\free-capacity-fabric\source-certification.json`. Guarded source state: `G:\CodeForge\docs\codeforge-forgegreen-certified-source-state.json`.

## 18. Commit hashes

Baseline: `f1ceb4a34a97c0bbae4553994148c465fce44c1d`.

R64 implementation and bounded validation: `9c6b6ef11aa2dadab984e99e71549ebe242810a0`.

Clean-build fix and verified live production revision: `84c08956d61c143c65f0c147a78fed94648a2254`.

The exact hash of the final evidence commit containing this report is returned in the final chat response; a committed file cannot embed its own commit hash.
