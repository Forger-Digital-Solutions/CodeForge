# CodeForge Full-System Release-Candidate Certification

Date: 2026-09-18
Status: **CONDITIONALLY READY — local release candidate; not externally released or deployed**
Product version: **0.4.0**
Starting version: 0.3.0
Starting HEAD: `1b8d60e46558134fa5d2fa06cfd2b7ffa9d1b01b`
Branch: `forger-digital-solutions-forgegreen-certified`
Implementation/hardening commit: `e3b8ac3`.
Certification finalization commit: reported in the final chat response; this report is the authoritative campaign record.

## Executive summary

CodeForge was audited from the clean post-`1b8d60e` tree rather than trusting the prior Ollama report or older certification files. The campaign repaired concrete boundary defects in user-connected capacity accounting, desktop account scoping, provider feature gating, streaming failure detection, hosted credit settlement, billing idempotency, security-claim scanning, documentation links, and version consistency.

The strongest honest verdict is conditional. Local source, static, regression, packaged desktop, security-negative, accounting, and recovery evidence are substantially strengthened. Ollama Cloud remains an internal User-Connected Free candidate: it is not Managed Free, is not public Forge Auto / Free capacity, and remains blocked by provider terms permission plus authoritative included-balance/hard-stop evidence. Paid Auto remains disabled by default and its approved route roster is not production-executable without explicit credentials, route qualification, and spending authorization. GEMS remains simulation/offline infrastructure, not a public executable model family. Render/PostgreSQL production deployment and live provider certification were not performed.

No paid inference, live provider inference, purchase, deployment, push, or production credential operation was performed by this campaign. Money spent: **$0**.

## Starting state and evidence reconciliation

- HEAD was `1b8d60e` and the working tree was clean.
- `1b8d60e` added the Ollama user-connected Free candidate, desktop secure connection UX, ForgeZero capacity primitives, model metadata, and focused tests.
- The prior `OLLAMA-USER-CONNECTED-FREE-FINAL.md` correctly stated that Ollama was rollout-flagged and not public Forge Auto / Free-ready. Its blocked legal/financial conclusions were preserved.
- The repository still advertised published `v0.2.0` while manifests were `0.3.0`; canonical product and workspace metadata are now `0.4.0`.
- Historical certification files remain historical evidence. They are not treated as current PASS claims.

## Gap matrix

| Subsystem | Source/wiring truth | Tests/evidence | Final campaign disposition |
| --- | --- | --- | --- |
| ForgeZero | Authoritative free eligibility, health, privacy, freshness, orphan-provider, and paid-fallback gates | ForgeZero failure matrix, routing isolation, capacity tests | Hardened; remains the financial authority |
| 8-Bit | Health, reliability, qualification, capacity, role routing, failover, receipts, persistence | 8-Bit qualification, failover, capacity, receipt suites | Integrated with Free Cloud routing; no paid fallback |
| 16-Bit / Paid Auto | Paid Auto registry/service is the paid routing foundation; no hidden Free path | Paid Auto route/fallback/failure tests | Separate and disabled by default; production spend authorization remains an external gate |
| ForgeGreen | Context/cache/reuse/compression/duplicate suppression/resource receipts are wired into autonomous runs | FG suites and FG-8 benchmark fixtures | Advisory/economics layer only; never approval, tool execution, or completion authority |
| ForgeVerify | Structured plans, current input hashes, attempts/evidence, policy receipts, stale-evidence checks | Completion, evidence-reuse, recovery, workflow suites | Release-critical completion authority preserved |
| Free Auto | ForgeZero + 8-Bit admission + provider adapter + health/capability gates | Negative routing and provider isolation suites | No paid/BYOK/GEMS fallback |
| Managed Free | Explicit provider definitions, evidence, live discovery, qualification, and terms gates | Model-registry/provider-contract suites | Ollama excluded; trials/promotional credit excluded from baseline Managed Free |
| User-Connected Free | Ollama key is user-scoped and renderer-safe; rollout gate enforced in trusted authority | Desktop lifecycle and ForgeZero capacity tests | Candidate only; not public routed supply |
| BYOK | Explicit secure/environment credential paths remain separate from Free Auto | Credential and provider isolation suites | No silent Free-to-BYOK crossover |
| GEMS Auto | Simulation/future profiles and offline catalog only | GEMS auto-framework tests | Not production-ready and not executable |
| Auth/session | Server-brokered PKCE, single-use codes, refresh rotation, logout revocation | Cloud auth/security suites; packaged auth smoke | Local lifecycle verified; external GitHub/Render proof pending |
| Electron | Sandboxed renderer, context isolation, bearer withheld, IPC sender checks, secure storage | Packaged full/interrupt/recover smoke | Packaged unpacked build verified locally |
| Cloud/backend | Cloud API, SQLite/Postgres parity, reservations, usage, billing, Render blueprint | Cloud/database/security suites | Local/integration-ready; no production deployment proof |

## Changes delivered

### Routing, capacity, and provider boundaries

- Unknown Ollama included balance is now always denied, even when an at-risk override is supplied.
- Per-user capacity reservations now require the route's stable capacity identity, preventing a caller with another user's route id from consuming that pool.
- Ollama validation/connect/catalog operations enforce the rollout flag in the trusted provider authority, not only in React controls.
- Ollama credentials remain scoped by the current CodeForge user identity; the desktop provider host resolves that identity dynamically rather than capturing it at startup.
- Cloud logout, account deletion, and account switching reconcile the Ollama provider so stale adapters/routes cannot survive an identity transition.
- Ollama remains `USER_CONNECTED_FREE`, not `PURE_MANAGED_FREE`; its terms classification and unknown balance continue to block public Free Auto.

### Provider reliability and security

- OpenAI-compatible model discovery and health probes now have bounded timeouts.
- An SSE stream that reaches EOF without `[DONE]` now fails as `STREAM_INTERRUPTED`; partial output is not silently promoted to a successful completion.
- Existing secret redaction and credential IPC boundaries remain intact.
- Security-claim scanning now correctly treats explicit negations as informational and the legal draft no longer claims hardware encryption beyond the actual OS-backed safeStorage primitive.
- The secret scanner's one reviewed environment-variable-name false positive is explicitly allowlisted with a path-specific reason; no secret value is allowlisted.

### Accounting and billing

- Hosted usage input validation rejects negative/non-safe token and credit values and invalid cached-token relationships.
- Actual settlement now fails closed when usage exceeds both the reservation and available balance; it no longer silently caps the charge while marking the reservation committed.
- SQLite and PostgreSQL settlement paths retain atomic reservation/ledger behavior.
- Ledger append operations are idempotent for `(user, requestId, eventType)`.
- Stripe subscription allowance grants use deterministic request ids so `checkout.session.completed` and the initial subscription invoice cannot double-grant credits.

### Documentation and release consistency

- Canonical manifests, lockfile workspace metadata, CLI version, cloud health/meta version, desktop metadata, and web/package metadata are `0.4.0`.
- README now distinguishes the unpublished local RC from the historical v0.2.0 GitHub release.
- Security documentation links were reconciled to files that exist in this checkout; missing operational/compliance artifacts remain explicit blockers rather than broken links.
- Historical evidence was not rewritten to claim current success. New machine-readable security and benchmark evidence is retained under the existing evidence tree.

## Authoritative architecture

- **ForgeZero:** fail-closed cost/access/health/privacy/freshness/orphan-provider gate. It rejects paid, unknown-cost, stale, unavailable, and unverified routes from Free eligibility.
- **8-Bit:** route health, role qualification, reliability, capacity forecasts/preflight, sticky bindings, failover, and decision receipts. It ranks only after hard eligibility.
- **ForgeGreen:** bounded efficiency and resource-economics advisor. It can cache, compress, suppress duplicate work, recommend verification, and record measured receipts. It cannot execute tools, authorize approvals, override ForgeVerify, or create completion.
- **ForgeVerify:** creates structured verifier plans, runs bounded structured commands, records evidence hashes/input-state hashes, resolves stale evidence, and feeds the Completion Gate.
- **Forge Auto / Free:** only ForgeZero/8-Bit-admitted free routes with an active adapter; failures surface honestly and never silently select Paid Auto, BYOK, GEMS, owner credit, or another user's pool.
- **Paid Auto:** distinct four-model paid foundation with direct-first and independently gated OpenRouter fallback. It is kill-switched off by default and remains unavailable until credentials, commercial/privacy/capability certification, and explicit spending authorization exist.
- **GEMS Auto:** future/simulation-only framework. Unfinished or synthetic profiles cannot execute.
- **Managed Free:** CodeForge-owned/provider-qualified recurring zero-cash capacity, requiring evidence and terms/capacity/role gates.
- **User-Connected Free:** user-owned capacity, per-user pool and credential scope, never aggregated into Managed Free. Ollama is currently blocked from public routing.
- **BYOK:** deliberate user-selected provider capacity, isolated from Free Auto.

## Provider/model inventory summary

| State | Examples |
| --- | --- |
| Managed Free candidate/eligible only after live proof | OpenRouter `:free`, Z.AI zero-unit routes, allowance providers subject to plan/policy/probe gates |
| User-Connected Free candidate | Ollama Cloud; feature-flagged, terms/balance/role gates not cleared |
| Paid Auto | GPT-5.6 Luna, GLM-5.3 Flash, Qwen3.8 Flash, DeepSeek V4.1 Flash; disabled/unverified by default |
| GEMS | Topaz/Sapphire/Peridot/Garnet catalog/simulation/offline; no production backend |
| Trial/promotional/owner/development | Excluded from Managed Free baseline unless independently requalified |
| Paid/BYOK-only | OpenAI, Anthropic, DeepSeek direct, Alibaba and other paid APIs according to provider definitions |

The model picker/catalog is not treated as proof of reachability: selection, ForgeZero verification, adapter registration, 8-Bit admission, and provider health are separate gates.

## Security results

- Secret scan: self-test PASS; final scan PASS after one path-specific reviewed allowlist entry for a documented environment variable name with no value.
- Dependency audit: PASS; 540 components, no blocking findings.
- Public claims scan: PASS; explicit negations are no longer misclassified as claims, and the draft hardware-encryption wording is qualified.
- Electron packaged smoke proved renderer bearer absence, trusted-renderer control-plane authentication, forged-origin/approval rejection, sandbox/context-isolation posture, encrypted credential round-trip, plaintext absence, and restart behavior.
- Remaining security limitations: no code-signing identity was supplied; cloud production deployment and third-party provider security/legal assurances were not independently verified; operational incident-response/backups/compliance artifacts are not present in this checkout.

## Testing and verification

Commands run during the campaign include:

```text
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd test -- --reporter=dot
npm.cmd run security:secret-scan
npm.cmd run security:claims
npm.cmd run security:doc-links
npm.cmd run security:audit
npm.cmd run pack --workspace=codeforge-desktop
npm.cmd run smoke --workspace=codeforge-desktop
npm.cmd run smoke:interrupt --workspace=codeforge-desktop
npm.cmd run smoke:recover --workspace=codeforge-desktop
npm.cmd run r8:benchmark
npm.cmd run r9:benchmark
npm.cmd run forgegreen:fg8:benchmark
npm.cmd run repo-intelligence:certify
```

Final post-bump totals are recorded here after the final full run:

- Typecheck: PASS
- Lint: PASS with zero warnings
- Build: PASS
- Full Vitest (final bounded run: `npm.cmd test -- --reporter=dot --maxWorkers=4`): **360 files passed, 7 skipped; 2,722 tests passed, 36 skipped**
- Focused hardening/accounting/provider/security tests: PASS (including 52 focused tests and the 22-test cloud accounting/billing/parity run)
- PostgreSQL full harness: **79 passed, 1 failed**; the failure was the adversarial E2E's fixed `sub_pg_e2e` id already owned in the persistent local test database, not a product assertion regression. Fresh-database rerun requires a new local database or explicit cleanup.
- Packaged desktop full smoke: PASS
- Packaged desktop interrupt smoke: PASS
- Packaged desktop recovery smoke: PASS when run sequentially after interrupt (the first parallel attempt was intentionally rejected as an invalid shared-profile ordering and is not counted as a product failure)
- CodeForgeBench R8/R9: manifests generated with zero model executions; no score is claimed (`attempts=0`, `verifiedSuccesses=0`)
- ForgeGreen FG-8/FG-9 benchmark: 8 deterministic workload receipts; Candidate A control/treatment recorded 31→27 tool calls, 15,260→15,200 ms, with identical verification outcome; this is local synthetic evidence, not a live provider causal claim
- Repository Intelligence certification: READY index, 2,698 files, 166,961 symbols, 16,883 edges, 0 parser failures; index 79,352 ms, query P50 928 ms, P95 3,469 ms, recall@1 0.50, recall@5/10 0.667, MRR 0.556. This is useful but not a high-recall certification result.

## Remaining blockers

### Code/integration blockers

- Direct conversational chat turns remain a separate chat-mode lifecycle from autonomous WorkflowService completion; engineering completion must use the workflow/ForgeVerify path.
- Paid Auto does not have an independently completed production spend ledger/allowance policy wired into normal execution; it remains disabled by default.
- GEMS has no finalized executable artifacts or production inference backend.

### Infrastructure blockers

- No Render deployment, staging health probe, live PostgreSQL connection, or production migration run was performed in this campaign.
- No code-signed Windows installer identity was available.

### Provider/legal/owner blockers

- Ollama user-connected Free requires provider terms permission applicable to this design, authoritative included-balance/hard-stop evidence, live model/role qualification, and a production usage-observation path.
- Live provider credentials and external capacity evidence were intentionally unavailable/not used.
- Owner must supply code-signing, Render/GitHub OAuth, database, and any explicitly authorized paid-provider credentials before external release.

## Evidence

- `OLLAMA-USER-CONNECTED-FREE-FINAL.md`
- `docs/evidence/security-r1/secret-scan.json`
- `docs/evidence/security-r1/public-claims-scan.json`
- `docs/evidence/security-r1/dependency-audit.json`
- `docs/evidence/security-r1/doc-links.json`
- `docs/evidence/r8-intelligence-benchmark/results/codeforge-bench-r1-pre-optimization.json`
- `docs/evidence/r9-capability-campaign/results/codeforge-bench-r2-pre.json`
- `docs/codeforge-forgegreen-fg8-benchmark-fixtures.json`
- `docs/evidence/forgegreen-r1r/`
- `apps/desktop/release/win-unpacked/`

## Final repository state

- Final version: 0.4.0
- Push: none
- Deployment: none
- Money spent: $0
- The implementation hardening commit is `e3b8ac3`; the certification-only finalization commit is the final HEAD reported in chat. Final working-tree status is clean after that commit.
