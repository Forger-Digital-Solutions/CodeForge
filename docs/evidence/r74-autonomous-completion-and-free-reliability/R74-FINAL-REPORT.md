# CodeForge R74 — autonomous completion and Free reliability

**Verdict: CODEFORGE_R74_PARTIAL.** Real autonomous completion increased from R73's 0/6 to R74's **3/10 (30%)**. All three successful parents passed independent live review, real verification, integration, and durable completion. The longest consecutive streak is **1**, with **0 false completions**. Three consecutive completions and successful organic cross-provider continuation remain unproved. No counters were reset.

## 1. Repository

Started from delivered R73 `6d4f98a7986d8bc43442a0254dea628da108e22e`, preserving its account architecture and historical evidence. R74 branch: `codex/r74-autonomous-completion-and-free-reliability`; worktree: `G:\CodeForge\worktrees\r74-autonomous-completion-and-free-reliability`.

Final frozen implementation SHA: **`0f03e53da239680fb300cd10eee8c963c16df648`**. The final Windows archive is built from this clean implementation. Subsequent commits contain delivery evidence and this report, rather than different packaged implementation. The publication receipt records the pushed report commit; the final receipt-only commit and exact remote alignment are recorded in the local final push receipt and delivery response. A receipt cannot embed the hash of the commit that contains itself.

[Baseline](baseline-provenance.json) and [preservation](final-preservation.json) compare all six original unrelated modifications and 373 R72/R73 evidence files byte for byte. The original checkout remains at `6f8ad979fb9de0a17f69571d03358d7db5a35459` on `codex/r29-release-closure`; R73 remains clean at its delivered HEAD. No GEMS, Dr. Forge, ForgerEMS, FDS website, production deployment, or protected checkout changes were made.

The R74 lockfile changed intentionally to repair eight blocking high dependency findings. [Dependency refresh](dependency-refresh.json) records the old/new hashes, package deltas, unchanged native versions, isolated activation, and preservation of shared R73 dependency targets. The previous R74 dependency directory remains in its private ignored backup; shared junction targets were not deleted or modified.

## 2. Reviewer

**Kilo `nvidia/nemotron-3-ultra-550b-a55b:free`** passed the current V4 Reviewer benchmark: **7/8, 0.875**, above the unchanged 0.75 threshold and with critical disqualification rules intact. It approved the correct repair and rejected one-bug, test-cheating, boundary, and reservation-leak cases. [Full qualification and request/response frames](reviewer-nvidia_nemotron-3-ultra-550b-a55b_free-1791628393855.json).

The raw result is imperfect: it missed the swallowed-failure case and added an unsupported import allegation to a reservation finding. Qualification is evidence of measured role competence, not infallibility. R74 stops replaying identical semantic misses; a bounded retry remains available for genuinely cap-starved reasoning output. Diagnostic receipts retain earlier hard failures even if a later request times out.

Four new held-out live reviews used the production prompt, structured parser, actual repository snapshots, file contents, diffs, source hashes, and real tests. Ultra correctly approved a `finally` cleanup repair and an owner-isolation repair, and correctly rejected a rejection-path resource leak and a cross-owner lookup regression. [Held-out packet, decisions, and tests](held-out-review-1791628701674.json). These are separate review experiments; ForgeVerify was correctly pending and they are not counted as completed parent tasks.

The three actual completed parents also received independent Ultra PASS decisions. The refactor review included a grounded newline advisory without converting it into a false blocker. Coder and Reviewer model identities differ. Exact fixed Kilo served-model identity is checked for both chat and streaming; a silent substitution cannot yield executable tool calls. Existing documented delegated `auto/free` identity semantics are preserved.

Production review improvements clarify evidence-based control flow and resource lifecycle evaluation without injecting benchmark answers. Existing workspace freshness, tool authority, structured evidence, and completion checks remain enforced. Reviewer output budgeting supplies the observed reasoning reserve within the existing 4096-token ceiling; its measured override expires November 9, 2026.

## 3. Autonomous Completion

The experiments used authorized public representative projects with real Git workspaces, live anonymous model endpoints, and `createAgentRuntime` plus the production parent orchestrator. No scripted provider role produced these completions. This proves runtime behavior on bounded projects; it does not certify the full installed GitHub sign-in journey.

| Attempt | Category | Parent outcome | Evidence |
|---|---|---|---|
| 1 | Bug fix: retry boundary | Completed | [First completion](R74-FIRST-COMPLETION.json) |
| 2 | Small feature | Failed: Planner omitted required Reviewer | [Continuation](R74-STREAK-CONTINUATION.json) |
| 3 | Refactor | Blocked: capacity/planning interruption | [Continuation](R74-STREAK-CONTINUATION.json) |
| 4 | Small feature | Blocked: incomplete constraints; corrective planning timed out | [Feature repair](R74-FEATURE-REPAIR.json) |
| 5 | Small feature | Blocked: incomplete/verbose invalid planning output | [Category campaign](R74-CORRECTED-CATEGORY-CAMPAIGN.json) |
| 6 | Refactor: shared validation | Completed | [Category campaign](R74-CORRECTED-CATEGORY-CAMPAIGN.json) |
| 7 | Test creation | Blocked: actual Coder HTTP 429 | [Category campaign](R74-CORRECTED-CATEGORY-CAMPAIGN.json) |
| 8 | Debugging | Blocked: actual Coder HTTP 429 | [Category campaign](R74-CORRECTED-CATEGORY-CAMPAIGN.json) |
| 9 | Bug fix with process interruption/recovery | Completed | [Real recovery](R74-PARENT-RECOVERY-LIVE.json) |
| 10 | Configuration/build repair | Blocked: actual Coder HTTP 429 after valid planning | [Configuration attempt](R74-CONFIGURATION-COMPLETION.json) |

Successful patches are retained in the receipts: `src/retry.mjs` changed the erroneous attempt boundary; the refactor changed `src/user.mjs`, `src/project.mjs`, and added shared `src/validate.mjs`. All three include actual child tests, independent review, ForgeVerify, successful integration, post-integration tests, and a durably completed parent. The completion authority remains `evaluateCompletion`; no alternate path or relaxed policy was added.

Confirmed runtime defects were repaired: require a Coder and independent Reviewer in the Planner graph; pass actual user constraints and verification commands; allow one bounded corrective plan containing the missing dimensions and prior plan; use the same compact generic schema protocol as measured qualification for a Planner without tool authority; select temperature zero for this protocol. Final configuration planning succeeded, then correctly blocked at the upstream Coder limit. Feature completion under the final protocol is still unproved.

## 4. Reliability

[Machine-readable statistics](R74-LIVE-STATISTICS.json) aggregate distinct parents, ordered by real start time, with hashes of raw source receipts.

| Metric | R74 observation |
|---|---:|
| Attempts / completed / failed / blocked / cancelled | 10 / 3 / 1 / 6 / 0 |
| Completion rate / longest streak / false completions | 30% / 1 / 0 |
| Logical worker model requests | 156 |
| Physical external parent requests | 169 |
| Included startup capacity pings | 14 |
| Physical task requests excluding pings | 155 |
| Executed worker tools | 125 |
| Actual production Reviewer passes / failures | 3 / 0 |
| ForgeVerify executions / integrations | 3 / 3 |
| Worker retry telemetry / corrective Planner workers | 0 / 2 |
| Review repair rounds / successful review repairs | 0 / 0 |
| Recorded external provider failures / rate limits | 5 / 5 |
| Separate live qualification / held-out review requests | 21 / 4 |
| Parent external requests per completion, including unsuccessful parents and pings | 56.3333 |

Logical worker requests and physical external requests are different counters and must not be added. One empty pre-dispatch Reviewer frame from the interruption boundary is excluded from physical requests. Qualification includes bounded diagnostic retries; these are outside worker retry telemetry. Parent experiments plus separate qualification and held-out experiments total 194 physical requests under this accounting. Local tests and historical R73 experiments are excluded.

The real recovery test killed the running process after the live Coder completed, at Reviewer preflight. Restart revalidated authority and Free qualification, reused the durable successful Coder, dispatched one Reviewer request, verified and integrated the retained patch, and durably completed. **Zero recorded mutation replays; no Coder replay.** The receipt contains both phase streams, tool journals, before/after state, tests, and durable recovery data. This is stronger than fixture-only recovery, but one successful recovery does not establish daily-use reliability.

The six categories were all attempted. The initial continuation and later corrective tranches remain in the denominator. The campaign stopped on repeated failures rather than cycling identities, resetting counters, or repeatedly probing known failed routes.

## 5. Free Supply

The current authorized catalog snapshot contains 12 Kilo models and 2 BlockRun models; catalog size is not usable coding capacity. [Authorized catalog](current-catalog-authorized.json), [catalog rows](current-catalog.json), and the preserved R72/R73 matrices provide the provenance.

| Exact route | Admitted useful role | Evidence |
|---|---|---|
| Kilo `cohere/north-mini-code:free` | Existing Explorer, Coder, Tool Agent | Preserved R71 live qualification, included with original receipt/hash in bundled evidence |
| Kilo `nvidia/nemotron-3-ultra-550b-a55b:free` | Reviewer | R74 V4 7/8 plus four held-out reviews and three completed parents |
| Kilo `nvidia/nemotron-3-super-120b-a12b:free` | Planner only | [Live 2/2 Planner cases](planner-nvidia_nemotron-3-super-120b-a12b_free-1791629043713.json), three physical requests |
| BlockRun `nvidia/llama-3.2-11b-vision` | Planner only | [Live 2/2 Planner cases](planner-nvidia_llama-3.2-11b-vision-1791629583054.json), then actual completed refactor and recovered parent |

BlockRun now contributes useful measured planning through a distinct gateway quota domain. It is not admitted as Coder, Tool Agent, or Reviewer: prior role failures are preserved, and role qualification does not grant untested roles. Kilo and BlockRun may share underlying NVIDIA infrastructure, so physical upstream independence is **not established**. Gate F is therefore only partially demonstrated under a strict independent-supply interpretation.

Ultra Planner experiments were inconclusive after bounded output/transport limits. Inkling hit an actual daily HTTP 429 on its first diagnostic request and was not qualified. Previously rejected routes were not blindly retested. Ordinary unpaid OpenRouter and organization-shared Groq retain their R73 policy/adapters; no new account entitlement, shared credential, or capacity guarantee was invented for this run.

Published finite gateway limits remain Kilo 200 requests/hour/public IP and BlockRun 30/minute, 300/hour/source IP. Live Cohere errors exposed a separate upstream 15/minute bottleneck. These are not per-user allowances or availability guarantees. [BlockRun Free](https://blockrun.ai/free), [official rate limits](https://blockrun.ai/docs/rate-limits). No registration ceiling or unlimited-inference claim was added.

## 6. Routing

Role allocation uses Cohere for investigation/editing/tool work, BlockRun or Super for measured planning, and Ultra for independent review. The Planner can prefer a qualified quota pool distinct from Explorer; that choice was exercised in real successful parents. Production planning without tools is restricted to PLANNER qualification; a qualified Tool Agent still retains tool access. Unexpected tools from a text-only Planner are blocked.

The shared governor conservatively admits Kilo at 14 RPM and BlockRun at 28 RPM with maximum concurrency two, below observed/published limits. Role changes do not create independent provider windows. These limits do not remove an upstream model-specific shortage. Existing cooldown, health, source/account ownership, privacy, context, and ForgeZero admission remain authoritative. Removing uninformative headerless startup pings reduces waste in subsequent campaigns; all previously incurred pings remain counted.

Desktop automatically opts into bundled measured qualification receipts, with source hashes and 30-day freshness checks. The service default remains opt-in. Bootstrap only fills missing local role evidence and cannot overwrite a persisted denial or establish pricing, privacy, policy, catalog availability, or credential authority. Those checks still run before dispatch. Raw interrupted qualification evidence is retained; measured critical denials are persisted across SQLite restart even when later transport failures make the overall measurement transient. Partial positive evidence cannot promote a role.

Anonymous runtime experiments required no provider account or API key. The final archive includes the bundled JSON and loader. This supports the intended packaged Free path, but no installed first-user GitHub-to-repository lifecycle was executed in an authorized isolated Windows environment. Expired receipts will need genuinely fresh qualification; shipping evidence is not perpetual model admission.

## 7. Accounts

R73 account implementation is preserved. Current fixture regressions cover multiple owned accounts, stable IDs and encrypted credential references across restart, owner/account quota grouping, conservative unknown-owner grouping, explicit global and account spend consent, estimates, qualification, owner changes, disconnect/switch invalidation, and FreeOnly separation. A valid paid credential still does not supply spend authority with consent OFF.

[Current account/SDK/qualification regressions](final-accounts-sdk-security-tests.json) passed 160 tests with zero failures/skips. These are deterministic fixture tests, not live personally connected account calls. No new external accounts, OAuth identities, account keys, purchased credits, or provider credential extraction were used. Existing security scans and envelope/credential tests provide additional evidence; they are not claims of live paid-account validation.

## 8. Failover

There were five genuine recorded provider failures, all HTTP 429/rate limits, including Cohere's upstream 15 RPM condition. Each raw receipt and aggregate failure entry is retained. Later parents continued using qualified Free roles, but **no failed parent recovered across providers into a fully completed task**.

There is no qualified alternate anonymous Coder in the demonstrated roster. Promoting the failed BlockRun Reviewer/Coder or treating an independently qualified Planner as a Coder would violate admission. The runtime therefore reports blocked capacity accurately. Selecting BlockRun for planning is role allocation, not organic failover. No injected failures, identity rotation, alternate keys, or quota evasion were used. Gate H remains unmet.

## 9. Windows

The final candidate is `apps/desktop/release-r74-0f03e53d-final/win-unpacked`, built from frozen implementation `0f03e53da239680fb300cd10eee8c963c16df648` using cached Electron 44.4.1 and electron-builder 26.17.0. Native versions are unchanged; existing approved binaries were reused without local compilation or rebuild. The artifact manifest records executable/archive hashes, ten native-file hashes, 44 byte-matched modules/assets, dependency versions, source identity, account controls, and all five static audits.

Static audit coverage: clean matching renderer/main identity, internal dependencies, runtime dependencies including bundled JSON and the actual MCP client closure, browser security, and the development loopback authentication endpoint. These are archive inspections, not application execution or production authentication certification. [Final artifact manifest](windows-artifact-manifest-0f03e53d-final.json), [signature](windows-signature-0f03e53d-final.json), [audit log](windows-static-audits-0f03e53d-final.log).

The earlier archive omitted the bundled JSON and was correctly rejected after the audit was improved. A subsequent candidate contained a stale renderer identity and failed the clean identity check; its receipt remains. The final renderer was rebuilt from the frozen main stamp and repackaged. No security check was bypassed to accept either earlier candidate.

The nested PowerShell signature subprocess could not load its security module and correctly reported UNAVAILABLE. A separate [host Authenticode inspection](windows-host-signature-0f03e53d-final.json) returned **NotSigned** for the exact final executable. No signing identity was supplied. No installer was built or installed; the candidate was not launched. Installer upgrade/uninstall, real GitHub sign-in, and packaged runtime lifecycle remain **NOT CERTIFIED** without an authorized isolated Windows environment. No production deployment occurred.

## 10. Economics

**Money spent: $0. Purchased-credit inference requests: 0. Estimated marginal inference cost: $0** for the actually admitted anonymous exact-zero routes. This follows route/policy/catalog authority and returned telemetry where available; it is not an independent provider billing invoice audit.

194 nonoverlapping physical requests comprise 169 parent requests (14 pings included), 21 qualification requests, and four held-out reviews. Parent requests per successful completion are 56.3333, including unsuccessful parents. Rate limits, transport bounds, qualification expiration, and upstream reliability make this finite supply unsuitable for an unlimited-throughput promise. Distinct connected accounts do not imply distinct upstream ownership.

All live code was explicitly authorized public synthetic code without user secrets or confidential source. Private-code-only restrictions were not bypassed. ForgeZero remains the sole zero-billing authority. No paid fallback, local LLM inference, external account creation, or quota circumvention occurred.

## 11. Validation

Current forced workspace typecheck and full npm workspace build passed after the dependency refresh. Clean frozen Desktop main/renderer builds and final packaging are separately recorded. The validation summary identifies current final suites and earlier diagnostic outcomes; repeated overlapping suites are not summed as unique tests.

Current final checks include 160 account/SDK/qualification tests, 26 complete standalone parent-orchestrator tests, and [405 remaining relevant regressions](final-remaining-regression-tests.json) against the refreshed dependencies: security, review, role qualification, capacity, recovery, and completion gate. All three final sets passed with zero failures or skips. The [validation summary](final-validation.json) checks the distinct suite/test identities and records exact files and commands. Earlier overlapping diagnostics are not added to this total. The full repository test suite was not claimed as executed.

[Dependency audit](final-dependency-audit.json): **0 high, 0 critical, 8 moderate**, no accepted high/critical waiver, 652 dependencies audited; [SBOM](final-sbom.json) retains 599 components. Original blocking findings were repaired by updating MCP SDK 1.30.0 to 1.32.1 and affected patch dependencies, and replacing patch-package's vulnerable globbing chain with a narrow fail-closed idempotent builder-util Windows executable patch. Native versions are unchanged. An attempted nonexistent braces release and failed candidate-copy checks are preserved as unsuccessful diagnostics.

[Secret scan](final-security-refresh-secret-scan.json): 2,140 source files, zero owner-review findings; 650 synthetic and 22 existing allowlisted matches. [Public claims](final-security-refresh-public-claims.json): 167 files, zero blocking claims. [Doc links](final-security-refresh-doc-links.json): 166 relative links, zero broken. Final source diff checks and preservation passed. Source evidence directories are excluded from the credential-shaped source scanner by existing policy; raw experimental frames were created from credential-free anonymous public fixtures.

Earlier failures remain recorded: sandbox process/build failures; six file-load failures resolved by workspace TEMP and host execution; five Reviewer realpath failures resolved by host packet tests; one parallel heavy Git timeout resolved by the complete standalone 26-test parent suite; two new assertion failures corrected to reflect required verification intent; incomplete candidate-source copy failures resolved by complete copy/typecheck; missing JSON and stale renderer packaging failures. These are not silently converted into passing receipts.

Automatic approval review rejected two early dependency-activation proposals because shared junction targets and unvalidated broad copies were insufficiently protected. The accepted alternative prevalidated the isolated candidate (forced typecheck and 163 tests), verified private directory boundaries, preserved the entire old dependency directory, and activated only the private R74 tree. The final local check passed 160 selected tests plus separate current regressions. No protected shared dependency targets were changed.

## 12. Remaining Blockers

**Runtime/model limitations:** the final compact Planner fixes measured contract/prompt mismatches, but small-feature completion remains unproved. Ultra Reviewer has documented qualification imperfections. No successful review-repair loop occurred in live parents. Three successes on small projects are insufficient to establish reliable everyday autonomous coding.

**External capacity/entitlement:** the only demonstrated qualified anonymous Coder encounters actual upstream 429s; no qualified alternate Coder permits successful organic recovery. A distinct BlockRun gateway supplies useful planning but physical upstream independence is unproved. No unavailable credential or account entitlement was invented. Further progress needs genuinely eligible capable supply, rather than retries against an already failed role or policy weakening.

**Release prerequisites:** signing credentials and an authorized isolated Windows installation/runtime environment are unavailable. Installer, first-user sign-in, and packaged lifecycle certification remain outstanding. Source/package improvements are delivered; this does not certify the non-negotiable complete new-user installed experience.

**Nonblocking security debt:** eight moderate dependency advisories remain visible under the unchanged gate policy. High/critical findings no longer block this source candidate.

## 13. Final Verdict

| Mission gate | Result |
|---|---|
| A Repository | Preserved isolated branch; committed and published with remote receipts |
| B Reviewer | Met: current V4-qualified Ultra; correct/defective held-out live reviews |
| C Autonomous completion | Met: three real parents reviewed, verified, integrated, durably completed |
| D Reliability | **Unmet: longest genuine streak 1, required 3** |
| E Existing Free supply | Preserved; no unauthorized spend |
| F Expanded independent supply | Partial: BlockRun qualified and used as Planner; underlying independence unproved |
| G User entitlements | Current deterministic regressions pass; no new live personal-account experiment |
| H Organic failover | **Unmet: no failed parent completed via a different provider** |
| I Economics/privacy | Met for authorized credential-free public experiments; $0 paid inference |
| J Windows | Source/build/archive checks delivered; unsigned, installed lifecycle uncertified |
| K Validation | Current relevant checks pass without threshold/security/completion relaxation |
| L Evidence | Raw successes, failures, source identities, statistics, and delivery receipts retained |

**CODEFORGE_R74_PARTIAL.** The production runtime now demonstrably completes real Free coding tasks and recovers an interrupted successful edit. It has not demonstrated the required repeated reliability, independent Coder capacity, organic cross-provider completion, or installed first-user Windows experience. Those gaps remain explicit acceptance failures, not redefined successes.
