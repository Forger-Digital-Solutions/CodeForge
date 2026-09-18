# CodeForge Full Trust & Intelligence Release-Candidate Assessment

**Assessment date:** 2026-09-18  
**Product version:** 0.4.0 (no version change justified)  
**Assessed source commit:** `d6f380084a9f2b8f3f0e86e41292adc614ea6c5f`  
**Supplemental desktop packaging commit:** `f5b4342d2f1fc06ae0a0dfdc8c7e92e11faa2a82`
**Scope:** local source, deterministic simulations, generated Windows artifacts, and the available managed Windows environment. No production deployment, real-provider inference, paid inference, push, or external legal review was performed.

## Verdicts

| Area | Verdict | Basis |
| --- | --- | --- |
| Engineering | **NOT READY** | Source gates pass, but the packaged Electron renderer cannot launch in this managed Windows environment and real PostgreSQL was not exercised. |
| Security | **CONDITIONAL** | The automated security suite and gate pass; production owner actions remain open. This is not a third-party certification. |
| Intelligence | **NOT CERTIFIED** | Deterministic system tests and selected A/B fixtures pass, but 8-Bit/16-Bit lack live verified task executions and broad repository retrieval recall is insufficient. |
| Legal / privacy | **OWNER INPUT REQUIRED / COUNSEL REVIEW REQUIRED** | Technical behavior was reconciled with draft disclosures; business facts and legal decisions remain explicitly marked. |
| Desktop release | **NOT READY** | Packaging succeeds, but the unpacked packaged smoke fails before renderer startup; installer lifecycle and installed workflow testing are therefore incomplete. |

## Security and privacy

- **Encryption:** staging/production configuration fails closed without a valid `CODEFORGE_DATA_ENCRYPTION_KEYS` ring; the implementation is a server-side environment key ring, not a managed KMS/HSM.
- **Secrets and BYOK:** focused security regression passes; desktop credentials remain outside renderer APIs and Cloud storage paths.
- **Authentication and GitHub:** focused security suites cover OAuth, PKCE, session revocation, and account lifecycle. The full run covers authorization adversarial cases.
- **Control plane and Electron:** source-level security assertions pass. The packaged renderer failure is not addressed by disabling sandbox, context isolation, web security, or Node isolation.
- **Billing and tenant isolation:** focused security tests pass. Stripe remains test-mode only; no live Stripe verification was performed.
- **Claims and documentation:** the security gate passed secret scanning, dependency audit/SBOM, public-claims scanning, and relative documentation-link validation. The stale Cloud “KMS/Env” wording was corrected.
- **Operations:** `docs/security/OWNER-ACTIONS.md` tracks deployment key configuration, security contact, escrow, backups, MFA/audit controls, retention, signing, and other external actions. Backup/restore remains **NOT VERIFIED**.

## Intelligence evidence

- **ForgeGreen R0:** deterministic baseline executes with an explicit process-local test-provider opt-in. Normal workloads completed; deliberately duplicated exploration was blocked, not treated as success. Prompt-cache benefit is not claimed because verification/completion parity is unproven.
- **ForgeGreen FG-8/9 fixture:** candidate A reduced simulated tool calls from 31 to 27 with the same simulated verification outcome. This is fixture evidence, not proof of real-world model quality.
- **Repository-intelligence A/B fixture:** target retrieval preserved success while reducing a synthetic 1,001-file search from 778 file opens / 1,145,775 context bytes to 2 opens / 298 bytes.
- **Repository-intelligence monorepo certification:** index status `READY`, 2,721 files, 0 parser failures; recall was 50% at rank 1, 67% at rank 5, and 83% at rank 10. This is a P2 quality gap. A source-preference experiment was rejected because aggregate recall fell, so it was not retained.
- **8-Bit / 16-Bit:** benchmark manifests were regenerated with no model attempts. They correctly preserve `NO_MODEL_EXECUTIONS_RECORDED`; no routing-quality or quality-per-dollar certification is warranted.
- **Subagents:** unit/integration regression passes, but no fresh single-agent-versus-team empirical campaign was run in this assessment. No benefit certification is warranted.

## Test and release matrix

| Gate | Result |
| --- | --- |
| Typecheck | PASS |
| Lint | PASS |
| Workspace build | PASS |
| Full regression | PASS — 360 files, 2,722 tests; 36 skipped |
| Focused security regression | PASS — 10 files, 120 tests |
| Security gate | PASS — secret scanner self-test/scan, dependency audit/SBOM, claims scan, documentation links |
| Staging and Cloud config | PASS — 2 files, 55 tests |
| Provider-isolation / ForgeGreen telemetry | PASS — 2 files, 8 tests |
| PostgreSQL authority suite | BLOCKED — WSL returns `Wsl/Service/E_ACCESSDENIED`; no disposable PostgreSQL URL is configured |
| Desktop package | PASS — NSIS and portable artifacts built |
| Packaged internal-dependency audit | PASS — the exact unpacked and portable embedded ASARs contain `@codeforge/intelligence`; `pack` and `dist` now enforce this gate |
| Packaged smoke | FAIL — `RENDER_PROCESS_GONE=launch-failed:49`, then `ERR_FAILED (-2)` loading the renderer document |
| Authenticode | NOT SIGNED — expected until OA-07 is completed |
| Fresh install / installed workflow / uninstall | NOT RUN — the user authorized it, but this host's desktop connector cannot operate native installer controls; no silent-install substitute was used |

## Reproducible desktop blocker evidence

The generated ASAR contains `apps\\desktop\\dist\\renderer\\index.html`, and its contents were read successfully with `@electron/asar`. The smoke run starts the trusted-process server, constructs the window, then fails while Chromium launches its sandboxed renderer. Current production settings remain `sandbox: true`, `contextIsolation: true`, `webSecurity: true`, and `nodeIntegration: false`. Do not change those settings solely to pass this smoke.

The initially generated portable artifact also omitted `@codeforge/intelligence`, which is imported by the shipped 8-Bit, ForgeGreen, and paid-auto modules. That independent main-process failure is fixed by explicitly packaging the workspace module and enforcing the internal-dependency audit after every `pack` and `dist`. The audit passes against the rebuilt portable's extracted embedded ASAR.

## Current desktop artifacts

- `apps/desktop/release/CodeForge-Setup-0.4.0.exe`: SHA-256 `999C259EAF9419BD45D15F446190105218B28C858462B81102925B275620D2BF`
- `apps/desktop/release/CodeForge-Portable.exe`: SHA-256 `C74E87C8ED5A663F1D774314F432D0FA15266063575D5BBFB9F5EE99F40C91DE`
- Both artifacts are `NotSigned`. These hashes supersede the earlier pre-fix artifact hashes.

## Remaining blockers

1. **P1 desktop:** reproduce and resolve the Electron 44 sandboxed renderer launch failure on a normal Windows host or obtain vendor/platform evidence that the managed environment prevents renderer child-process creation.
2. **P1 persistence evidence:** provide a disposable, non-production PostgreSQL endpoint or enable the repository’s local WSL harness, then run `npm run test:postgres:full`.
3. **P2 intelligence:** improve and remeasure broad repository-retrieval recall; run versioned, repeated task trials before certifying 8-Bit, 16-Bit, or subagent value.
4. **Owner / infrastructure:** complete OA-01 through OA-06 before public Cloud release; the remaining owner actions are enumerated in `docs/security/OWNER-ACTIONS.md`.
5. **Legal:** resolve the business-input list in `docs/legal/OWNER-LEGAL-INPUTS.md` and obtain counsel review for the marked draft language.

## Evidence locations

- `docs/certification/codeforge-security-legal-trust-r1-2026-09-18.md`
- `docs/evidence/security-r1/`
- `tests/evidence/forgegreen-r0/`
- `docs/codeforge-forgegreen-fg8-benchmark-fixtures.json`
- `docs/evidence/r8-intelligence-benchmark/results/`
- `docs/evidence/r9-capability-campaign/results/`
- `docs/security/OWNER-ACTIONS.md`
- `docs/legal/OWNER-LEGAL-INPUTS.md`

**Money spent:** $0  
**Push performed:** No  
**Deployment performed:** No
