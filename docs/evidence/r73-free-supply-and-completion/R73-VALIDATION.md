# R73 validation

Evidence is recorded per run rather than overwriting failed receipts. Counts from overlapping commands must not be added into a unique-test total.

## Regression checks

The broad affected run covered Eight-Bit, providers, model registry, server, workflow and desktop tests: **2, 632 passed, 16 failed, six pending** in `affected-tests.json`. It ran while implementations and their compiled exports were being changed. Every failed file was subsequently rerun individually against the current compiled tree: **212/212 passed** across eleven files, with no pending assertions and no gate/test relaxation. The `rerun-*.test.json` files preserve those isolated reruns. Windows fixture contention and wall-clock sensitive git tests are distinguished from source/version races rather than hidden.

Additional affected tools/agent/protocol tests passed **98/98** in `tools-agent-protocol-final-tests.json`. Active receipt mutation isolation and durable qualification history passed **81/81** in `receipt-immutability-final-tests.json`. Earlier focused Reviewer recovery/schema/timeout/freshness, cost/provider transport, account security and 2/10/25/50 owner-isolation evidence is indexed in the corresponding workstream reports. Initial TEMP, loopback sandbox and concurrent-source failures remain retained.

The clean eade source workspace build and forced TypeScript build passed in `final-workspace-build.json` and `final-typecheck.json`. The subsequent readable packet/qualification focused run passed 66/66, and parent regressions 31/31. Earlier frozen Windows static audits passed 5/5 with 15 checked compiled modules matching ASAR. Those results do not certify the current uncommitted account addendum; its final focused/root integration/build/package checks are still being collected. No unchanged broad failure is silently counted as green, and no scripted provider is used as live qualification.

## Account addendum validation snapshot

| Retained receipt | Result | Scope/limit |
|---|---|---|
| `connected-account-backend-current-tests.json` |90/90 PASS | Connected account lifecycle/security, existing provider entitlement/PKCE and host paths; overlapping earlier subsets are separate |
| `connected-account-oauth-native-tests.json` |4/4 PASS | Authorized native loopback callback fixtures; not actual provider browser consent |
| `connected-accounts-ui-bridge-final-localtemp-tests.json` |62/62 PASS across 8 files | Current account UI, provider/settings regressions, both shipped/typed preload channels, renderer CSP, Electron security and OS-backed codec fixtures |
| `connected-accounts-ui-bridge-final-tests.json` | Collection run failed |13 assertions passed; remaining suites hit sandbox Vite TEMP ENOENT and did not execute; retained unchanged |
| `personal-routing-policy-tests.json` |11/11 PASS at recorded source | Owner policy/default-off and pricing parser fixtures; final central price/routing changes require current rerun |
| Personal guard focused tests |16/16 PASS, separate R55 multi-user 4/4 PASS | Durable budget/reservation, explicit permission, current qualification, physical domain and model/tool controls; see policy workstream |
| `main-account-ipc-initial-tests.json` |11 PASS/4 FAIL | Initial root-integration fixture mismatches/owner-race failures, preserved while current fixes are validated |
| `openrouter-connected-account-metadata-1791559118027.json` | Live read-only success | One paid connection accepted with spend/dispatch off; 2 officialGETs, 0 inference, no secret publication |

Passing fixtures do not close missing live unpaid/two-account/paid execution or autonomous completion gates. Counts overlap and are never summed as unique assertions. Current source checks below supersede earlier integration-pending descriptions only for the exact recorded scopes; the frozen package still requires its own evidence.

## Final current-source regression checkpoints

| Retained receipt | Result | Interpretation |
|---|---|---|
| `accounts-final-affected-retry-tests.json` |821/823 PASS, 2 FAIL, 0 pending | Broad affected checkpoint; retained workspace error-reporting regression and unchanged heavy orchestration timeout/EBUSY |
| `accounts-final-heavy-orchestrator-retry-tests.json` |1 selected PASS, 22 intentionally skipped | The unchanged abstract-prior-outcomes git/worktree case passed standalone; not a complete 23-case suite |
| `accounts-final-workspace-billing-routing-tests.json` |33/34 PASS, 1 FAIL | All 4 HTTP workspace-consent, 4 existing workspace-binding and 13 UI cases pass; one new routing test incorrectly read `result.routeFailovers` and was subsequently corrected to `contextMetrics` |
| `accounts-final-billing-auth-transport-tests.json` |393/393 PASS across 39 files | All provider transport and affected personal guard/registry/execution/runtime checks, including the corrected routing assertion and two credential-rejection recovery cases |
| `accounts-final-typecheck-2.log` | Forced workspace TypeScript build exit0 | Current source typecheck passed; an empty log is successful compiler silence, not a test count |
| `accounts-final-workspace-build.log` | Full workspace build exit0 | Current final source builds; clean committed stamp and packaged inclusion remain separate |
| `accounts-final-frozen-typecheck.log` | Forced full-workspace typecheck exit0 | Last source revision passes the compiler before the clean commit/freeze |

The workflow entry point previously flattened a mismatched request workspace into `WORKFLOW_START_FAILED` HTTP500. It now returns `WORKSPACE_MISMATCH` HTTP409 before inference and preserves the already existing session. All four HTTP entry-point fixtures assert zero dispatch for the wrong workspace. The heavy orchestration case needed no assertion or completion-policy change; its retained broad timeout and cleanup EBUSY are not erased by the standalone success. No test was removed, and skipped cases are reported explicitly.

The 393-case run verifies automatic account recovery after authentication rejection only among currently qualified authorized personal paid candidates, and no replacement of an explicitly pinned account. It also validates exact reported billing-cost preservation through chat/SSE transport, inclusion of OpenRouter usage, durable charge settlement and overcharge detection, withheld text/tools on accounting failure, restart blocking and durable uncertainty when a charge cannot be represented safely. The overflow case stores the provider-reported USD and `accountingUncertain`, with a conservative blocked numeric ledger floor rather than claiming an exact invoice total. Missing cost stays unknown; malformed cost is not converted to zero. All these fixtures use scripted transport responses and make zero external inference calls. Source/provider behavior is tested; live invoice-cap enforcement and paid execution remain unproved.

## Integrity and packaging

Current lifecycle validation additionally passed 109/109 across 11 files (`account-lifecycle-affected-tests.json`) and 57/57 connected lifecycle assertions (`account-lifecycle-connected-tests.json`); 32/32 owner-lifecycle and 48/48 lifecycle/pricing subsets overlap and are retained separately. The initial root IPC failures are followed by passing current lifecycle checks, not silently discarded. Exact served-model identity, terminal stream/tool validation, unexpected-charge route withdrawal, owner-switch synchronization, callback/authorization races and account label versus authority freshness are covered.

Account-routing validation now covers 28 distinct passing assertions across projection, execution, role routing and one focused local-policy case: 8 projection, 9 execution, 10 role-runtime plus 1 local-policy assertion (its other 10 cases intentionally skipped in that focused run). `R73-PERSONAL-ACCOUNT-VALIDATION.md` links the exact nonoverlapping latest receipts. Earlier combined 26/26 and core guard/roster/registry 47/47 receipts remain historical positive checkpoints; failed intermediate runs remain preserved. Actual workspace consent invalidation and local policy denial prove zero POST/budget/provider failure/retry.

Authorization regressions passed 34/34 (`subagent-authorization-regression-tests.json`). The focused real edit/scripted review/verification/git integration fixture passed one selected assertion with 22 skipped (`roster-worktree-authorization-tests-final.json`); legacy user-only allowance recovery passed one with 18 skipped; existing real-process parent Reviewer crash recovery passed one with 6 skipped (`parent-authorization-recovery-tests.json`). These are focused deterministic fixtures, not full-file test counts or live-provider inference. Existing legacy parent recovery does not implement missing full-parent personal-roster crash resume. All six genuine live task outcomes remain blocked, independent of these passing fixture parents.

`baseline-provenance.json` binds R72 clean HEAD and all 73 prior evidence files, the original repository HEAD/branch and six unrelated tracked modifications, and the original lockfile. `final-preservation.json` verified those hashes and ancestor relationships at its earlier checkpoint. The addendum intentionally adds the already existing `@codeforge/secrets` workspace to desktop production dependency metadata; that authorized dependency/lock entry must be documented separately rather than represented as an unchanged lockfile after its update. A final preservation rerun remains required after the new source freeze. No shared dependency installation/native rebuild or unrelated project mutation is needed.

The final candidate is built from a committed clean source stamp. Package presence, compiled byte equality, main/renderer identity, dependency closure, Electron security and development auth-endpoint audits are separate from an unsigned executable's runtime/signing/installer certification. See `R73-WINDOWS-PACKAGE.md` for exact limitations and artifact receipts.

The addendum preservation rerun at HEAD `97dafd4cab4cf4e4c14bb9c2104191323659fb6d` passed: original and R72 locks remain SHA-256 `8cc332bdd8b2a53126592aa45960497d1892223ce2b37162f47496690dc31d45`; R73 is `45a47cff4b0dbb7346c5eba07fb3a34063a962175e4d1b74881199b13bd3cf68`. Deep parsed comparison permits exactly `packages.apps/desktop.dependencies.@codeforge/secrets = "*"` and rejects every other dependency/package/version change. The receipt records this explicit authorized difference rather than falsely claiming R73's lock is byte-identical. Original HEAD/branch, six tracked-file hashes and all 73 R72 evidence files remain unchanged. Rerun after the final source/evidence commits to bind their actual HEAD.

`accounts-final-validation.json` records the final build/typecheck exit0 and separate retained test checkpoints, with zero external/paid calls in those tests. The final secret scan passed: **2,104 files, 671 findings, 649 synthetic, 22 allowlisted, zero requiring owner review** (`accounts-final-secret-scan-report.json`). Its historical `security-r1` report was restored byte-for-byte; the new report is preserved only in R73 evidence. Cached source diff checks passed with raw log whitespace excluded, and preservation checks retained all six original tracked-file hashes and 73 R72 evidence files. Only the documented desktop `@codeforge/secrets` dependency is permitted as the lockfile delta. Clean source/final delivery SHAs and package evidence remain pending until the actual commits/build occur.

## October 10 source-finalization checks

| Receipt | Result | Scope |
| --- | --- | --- |
| `accounts-r73-billing-authority-final-tests.json` | 50/50 PASS | Paid qualification, estimate presentation, authoritative billed cost, post-inference revocation and process-lease crash reconciliation |
| `accounts-r73-reviewer-lifecycle-routing-final-tests.json` | 231/231 PASS | V4 Reviewer contract, role freshness, account lifecycle/settings/IPC, mixed routing and source isolation |
| `accounts-r73-openrouter-oauth-official-state-local-tests.json` | 19/19 PASS | Current documented top-level state, PKCE exchange, redirect/CSRF/replay handling and denied consent; authorized loopback fixtures |
| `accounts-r73-openrouter-oauth-official-state-tests.json` | 15 PASS/4 FAIL | Earlier restricted loopback collection retained; host-authorized rerun above passed all assertions |
| `accounts-r73-parent-recovery-final-tests.json` | 13/13 PASS | Real process crashes, current owner/workspace/privacy/roster reauthorization, parked recovery, one preserved edit, real ForgeVerify/integration with scripted role output |
| `reviewer-boundary-v4-tests.json` | 59/59 PASS | Current full-snapshot clean retry patch and seeded regression, unchanged schema/threshold and critical-defect exclusion |
| `reviewer-outcome.test.mjs` | 2/2 PASS | Local request bound is distinguished from upstream failure; incorrect completed review remains negative evidence |
| `accounts-r73-final-workspace-build.log` | exit 0 | Full workspace TypeScript and app builds after the OAuth correction |
| `accounts-r73-final-typecheck.log` | exit 0 | Forced full-workspace `tsc -b --force` |
| `accounts-r73-current-secret-scan.json` | PASS | 2,117 source files, 672 findings: 650 synthetic, 22 allowlisted, zero owner-review findings; prior scan unchanged |
| `accounts-r73-evidence-credential-scan.json` | PASS | 40 modified/new R73 evidence documents checked for known full credential shapes, zero findings; values never emitted |

The current parent-recovery process run takes several minutes on Windows and completed all thirteen assertions. The earlier interrupted rerun is not counted as a failure or success. These tests use synthetic fixtures with zero external or paid requests. The two new live V4 qualifications made eighteen anonymous requests and qualified neither model; their raw and adjudicated receipts are separate from fixture tests. The evidence summarizer now includes both providers' exact live Reviewer frames and reports 88 qualification/supply calls. The six-parent live outcome remains 0/6. `accounts-r73-current-validation.json` hashes the current fixture receipts and records actual build/typecheck exit codes separately from live results.

Original checkout and R72 preservation reran successfully at `1276a2de0b0104711faecce66bfb7239c860d22d`: six original tracked modifications and all 73 R72 evidence files unchanged. The source-final build/typecheck, frozen candidate, package audits and final preservation/publication are also recorded in `R73-WINDOWS-PACKAGE.md` and `R73-DELIVERY.md` as they complete.

## Frozen source and package

Source commit `0e364facb2b89ebc0624557d5c4a7f7ffa23219f` was tracked-clean during the workspace rebuild and archive audit. The rebuild and directory packaging exited 0. `windows-artifact-manifest-0e364fac.json` records five passing static audits, 36 matching compiled/renderer entries, all five expected account/estimate/qualification controls, ten native-file hashes and dependency/lockfile state. Direct signature receipt is NotSigned; the separate unsuccessful subprocess signature probe remains retained. No executable was launched, and native ABI/loading, encrypted packaged restart and installer lifecycle are unproved.

Preservation reran at that actual source commit: all six original tracked-file hashes and all 73 R72 evidence files unchanged; the only authorized lockfile delta remains desktop `@codeforge/secrets`. Later evidence commits do not modify implementation. Package hashes/build identity and publication are in the delivery report. Static audits and fixtures are never counted as completed real coding tasks.

The source/package-evidence revision `2f4e932c` was pushed successfully to the existing origin, then preservation reran at that exact published commit and passed. The full publication SHA and raw push log are `delivery-publication-2f4e932c.json` and `.log`. The last receipt-only commit adds documentation; it does not alter tested implementation or frozen package bytes.
