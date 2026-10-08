import { readFile, writeFile } from 'node:fs/promises';
const dir = 'docs/evidence/r72-free-supply-and-autonomy';
const json = async name => JSON.parse(await readFile(`${dir}/${name}.json`, 'utf8'));
const baseline = await json('provenance');
const windows = await json('windows-artifact-manifest');
const suites = await Promise.all(['focused-tests','final-focus-tests','affected-tests','final-boundary-tests','final-verification-suite'].map(async name => ({ name, ...await json(name) })));
const rechecks = await json('isolated-rechecks');
const native = await json('native-rechecks');
const table = suites.map(s => `| [${s.name}](${s.name}.json) | ${s.numTotalTests} | ${s.numPassedTests} | ${s.numFailedTests} | ${s.numPendingTests} |`).join('\n');
const unresolved = rechecks.results.filter(r => r.failed).map(r => native.results.find(n => n.file === r.file)).filter(r => !r || r.failed);
if (unresolved.length || suites.at(-1).numFailedTests || suites.at(-2).numFailedTests) throw new Error('UNRESOLVED_FINAL_VALIDATION');
await writeFile(`${dir}/R72-VALIDATION.md`, `# R72 validation

| Recorded stage | Total | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
${table}

The initial 2801-test affected run is retained with all 13 failures. It used an unnecessarily deep temp path inside an ignored Git checkout and overlapped heavyweight Windows worktree/process tests. Standalone rechecks cleared orchestrator/publication timeouts and deep-path preconditions without changing assertions. Native temp outside any repository cleared the remaining fixture-boundary failures. The latter exposed a real correctness gap for ignored child workspaces, which was fixed in production rather than only hidden by changing the harness.

All eight previously failing files passed standalone at a valid boundary. The final 26-test corpus also passes at the exact in-repository ignored boundary, including new invalidation and file-review tests. The final complete verification/completion suite passes 259/260 with one skip, no failures. Intermediate hardening receipts retain the failures that drove the fixes; source changes during those stages mean they are diagnostic receipts, not final certification. Test stages overlap; do not sum their counts as independent coverage.

Full workspace build at ${windows.sourceRevision} passed ([log](final-workspace-build.log)); package typechecks and renderer compilation included. Earlier host npm build could not launch configured Git Bash; using the native Windows npm script shell resolved it without changing repository configuration. TypeScript tsc -b, main and renderer checks passed. Five static package audits passed. Six skips in the initial affected set and one skip in the final verification subset are not claimed as live/provider/PostgreSQL certification. No remaining critical regression was observed in final checks. Unavailable live/package acceptance gates remain separate from passing deterministic tests.

[Standalone receipts](isolated-rechecks.json), [native-boundary receipts](native-rechecks.json), [preservation and credential audit](final-audit.json).
`);
await writeFile(`${dir}/R72-FINAL-REPORT.md`, `# CodeForge R72 final delivery

## 1. Repository

Authoritative original: G:\\CodeForge, branch ${baseline.originalBranch}, HEAD ${baseline.originalHead}, preserved. Durable R72: ${baseline.source}, branch ${baseline.branch}, starting R71 delivery ${baseline.startingHead}. Frozen final runtime/source ${windows.sourceRevision}; implementation commits b1190dae and 5ebe3fbc. Evidence delivery is a separate subsequent commit, identified by this file's containing commit and the final chat response. Push receipt is recorded separately if the authorized branch push succeeds. R70 ancestry, R71 checkout/35 evidence files, unchanged lockfile and six unrelated dirty file hashes pass the final audit. No historical evidence, unrelated project or original checkout was reset.

## 2. Free Supply

36 provider organizations / 38 service-route research entries, including 28 inherited R71 rows and 10 added entries. Newly fully qualified providers 0; newly integrated independent Free routes 0. Five new Kilo model candidates measured on one existing quota domain. Kilo remains usable anonymous supply; AI Horde community route remains blocked. OpenRouter official user-entitled connection preserved, but current environment key is paid-tier and excluded; historical Groq is shared organization capacity. Puter secure account/allowance/catalog observation implemented, automatic inference blocked. Paid/trial/client-restricted services remain rejected; authorization, entitlement, privacy and qualification blockers are documented per candidate in R72-SUPPLY-MATRIX.md.

## 3. Aggregate Capacity

Kilo documented 200/hour/public-IP across models and users; NAT is shared. OpenRouter unpaid accounts documented 50/day and 20 RPM; no accessible current unpaid account here. OVH 2/minute/IP/model is outside admitted supply pending authorization. No new verified independent quota domain or live multi-user/IP aggregation. Token/concurrency guarantees remain unknown where not documented. User registrations and catalog/model counts never multiply shared capacity.

## 4. Autonomous Reliability

R72 production coding attempts 1, completed 0, terminal blocked 1, parked 0, longest completed streak 0. R71 was 0/2. R72's child roles converge: Explorer 5 requests/6 tools, Coder 8 requests/7 tools; 147798 ms. The first R71 attempt consumed 24 requests. Correct child edit/tests pass, but Reviewer admission blocks the parent. Request savings are one-task measurements, not proof of everyday reliability. Staged 3-task streak and 20-task endurance remain unmet.

## 5. Provider Qualification

Carried Cohere qualifies Explorer/Coder/Tool Agent/Analyst; hard-failed Planner/Reviewer remain excluded. Dots measured Coder/Planner passes, Nemotron-Lightning/Liquid Coder passes, but transient receipts are not admitted. Dots Reviewer upstream 502; other probes rate-limited/interrupted/deadline-bound. No new qualified independent Reviewer. All actual frames, retries and unchanged scoring are preserved in qualification-summary.json and per-probe JSON.

## 6. Real Coding Proof

Actual edit: src/retry.mjs attempt <= maxAttempts changed to attempt < maxAttempts. Repo inspection, hash-bound edit_file, run_command node --test and source reads were executed. Three child tests passed and passed again during objective read-only inspection. Diff and tests are retained in child-coding-proof.json. Independent review did not run because no eligible model met its role contract. ForgeVerify final stage not reached; integration blocked; original parent fixture retains failing tests. No full completion is asserted.

## 7. Failover

Organic upstream quota walls and in-band SSE/502 failures occurred during qualification. A different candidate qualification probe is not automatic task continuation. The coding run's terminal cause was absent qualified Reviewer; no independent alternative selected and no completed organic cross-provider failover. Recorded inference dispatches include 62 qualification frames and 13 coding-role requests; the harness also invoked its production capacity probe, whose raw completion stream was not captured. No fabricated exhaustive network-call count or success-after-failure claim.

## 8. Windows

Candidate ${windows.artifact}, source ${windows.sourceRevision}, CodeForge 0.4.0/Electron 44.4.1/x64. Five static audits passed with matching dirty=false main/renderer identity. Executable SHA-256 ${windows.files[0].sha256}; archive SHA-256 ${windows.files[1].sha256}. NotSigned; development/smoke endpoint only. No package execution, live desktop login/restart/endurance, installer build/install/upgrade/uninstall or signed release certification. No authorized isolated Windows environment/signing identity here; no host-launch bypass. Earlier candidate preserved.

## 9. Economics

Actual inference used anonymous catalog-verified exact-zero Kilo supply. No paid or local inference, purchased credits, operator subscription, auto top-up or account farming. Puter purchased-credit continuation, environment OpenRouter paid tier and unverified provider billing are blocked. No newly proven independent supply; provider-funded and personally entitled allowances are finite, with shared upstream failures.

## 10. Validation

Focused 110/110, final output/tool/settings 32/32, boundary regression 26/26 passed. Initial affected 2782 pass/13 fail/6 skip; failed files subsequently passed in isolation and the production boundary gap was repaired. Final complete verification suite 259 pass/0 fail/1 skip. Full workspace build/typechecks and five final static audits pass. Intermediate failing stages are retained. See R72-VALIDATION.md; counts overlap and are not added.

## 11. Remaining Blockers

| Gate | Result / exact unmet requirement |
|---|---|
| A Repository | PASS after durable committed delivery; preserved originals/ancestry. |
| B Existing supply | PARTIAL: Kilo live; OpenRouter unpaid key unavailable; Groq unchanged shared classification without fresh account certification. |
| C Expansion | BLOCKED: zero additional live independent Free domains; OpenCode/OVH authorization unresolved; optional account credentials/billing/privacy evidence absent. |
| D Aggregation | Deterministic production architecture retained; no newly verified live entitlement aggregate. |
| E Qualification | BLOCKED: no complete conclusive Planner/Reviewer role fabric; partial receipts retained, unsuitable roles excluded. |
| F Completion | BLOCKED: no real independently reviewed ForgeVerify coding completion. |
| G Reliability | BLOCKED: no successful multi-task streak or requested endurance campaign. |
| H Failover | BLOCKED: no organic automatic independent-provider continuation to completed coding. |
| I Zero billing | PASS for executed/implemented paths; risky/unknown supply excluded. |
| J Multi-user | Deterministic isolation passes; two legitimate distinct live users/IP domains unavailable. |
| K Windows | Build/static PASS; execution, signing and installer lifecycle BLOCKED. |
| L Validation | Final relevant checks PASS; recorded skips are not certification. |
| M Evidence | Claims and limitations documented; capacity probe raw stream is an explicit evidence limit. |

External prerequisites: qualified currently available reviewer supply; authorized unpaid provider accounts; written third-party production permission where ambiguous; enforceable Puter free-only billing guard; two real unpaid users/egresses; approved isolated Windows machine and signing identity. Engineering follow-through: full Puter inference/tool/routing adapter after billing admission, real persistent-account restart/revocation proof, reviewed integration/recovery and endurance/failover certification. These requirements were not manufactured or waived.

## 12. Final Verdict

CODEFORGE_R72_PARTIAL

Concrete runtime/security repairs, secure account observation, new live measurements and an audited frozen candidate were delivered. Mandatory independent supply, reviewed completion, endurance, organic failover, live multi-user and Windows execution gates remain unmet.
`);
console.log('Wrote the final validation and 12-section report.');
