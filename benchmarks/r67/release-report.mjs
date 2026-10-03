import { writeFile } from 'node:fs/promises';
import { directory, read } from './release-artifacts.mjs';
const audit = await read('R67-CANONICAL-AUDIT');
const suite = await read('R67-REPOSITORY-TESTS');
const frozen = await read('R67-SOURCE-FREEZE');
const deployment = await read('R67-PRODUCTION-DEPLOYMENT').catch(() => undefined);
const smoke = await read('R67-PRODUCTION-FINAL').catch(() => undefined);
const build = await read('R67-WORKSPACE-BUILD-certified');
const canonical = audit.campaigns.find(campaign => campaign.name === 'canonical');
const concurrency = audit.campaigns.find(campaign => campaign.name === 'concurrency');
const supply = await read('R67-KILO-ROLE-QUALITY-refresh');
const reviewerQualification = supply.qualification.roleResults.REVIEWER.status;
const models = [...new Set(canonical.tasks.flatMap(task => task.models))].join(', ');
const physicalModels = [...new Set(canonical.tasks.flatMap(task => task.physicalModels))].join(', ') || 'not reported';
const explorerOutcomes = canonical.tasks.reduce((total, task) => {
  for (const key of ['children', 'completed', 'outputCapBlocks', 'otherRejected']) total[key] += task.explorerOutcome?.[key] ?? 0;
  return total;
}, { children: 0, completed: 0, outputCapBlocks: 0, otherRejected: 0 });
const closure = suite.status === 'PASS' && deployment?.status === 'live' && smoke?.status === 'PASS'
  ? 'CODEFORGE_R67_CLOSED' : 'R67_CERTIFIED_CANDIDATE_DEPLOYMENT_PENDING';
const table = canonical.tasks.map(task => `| ${task.taskClass} | ${task.status} | ${(task.wallTimeMs / 1000).toFixed(1)} | ${task.recordedTools} | ${task.recordedSourceOrTemporaryWrites} | ${task.verification[0].passed} |`).join('\n');
const text = `# ${closure}

## Repository

Starting revision: \`6c8af1b3fd43b048fdad2002aa6e5d22b1b72957\`. Branch: \`codex/r29-release-closure\`. Runtime revision: ${deployment?.commit ? `\`${deployment.commit}\`` : 'pending implementation commit'}.

Six pre-existing tracked changes are preserved byte-for-byte and excluded from the R67 commit. Unrelated untracked material is retained. [Preservation audit](R67-FINAL-SOURCE-PRESERVATION.json) and [starting state](R67-START-STATE.json).

## Implementation

R67 separates malformed role JSON from global malformed-tool quarantine, accepts a capped response only after its complete schema validates, and enforces runtime role requalification after independent negative observations. Valid tool observations now reset the malformed streak. Safety/quarantine floors, model/turn budgets, and completion policy are unchanged.

The runtime now persists parent stages, child identities/results, repair budgets, mutation history, original worktree/checkpoint identity, and recovery leases. Startup loads recovery state before listening and resumes safe parents in the background. Changed target HEAD, missing/ambiguous worktree state, ambiguous integration, and exhausted repairs fail closed. New files enter the review and completion diffs before integration. Windows command execution preserves quoted Node paths and compound command exit status; ordinary Node string escapes no longer masquerade as a netcat command. Raw strings, shell substitutions and real network commands retain their approval boundary.

Certification-only Git hashing now uses one batch while preserving exact Git blob/filter semantics. Nine source-identity canaries pass without increasing their timeout. This change touches no file in the frozen runtime material set.

ConPTY teardown now retains its output reader during native console shutdown, then awaits reader termination before explicitly destroying its output socket. The actual reader-worker lifecycle regression fails on the original code and passes after the fix. The previous completed full suite's unhandled EPIPE remains a recorded failure; command exit status and completion policy are unchanged.

## Canonical Live Campaign

Six attempts, six completed, zero blocked/failed, longest consecutive completion streak six. Every parent passed an independent Reviewer verdict, verification, the authoritative completion gate and integration. Optional preliminary Explorer outcomes: ${explorerOutcomes.completed}/${explorerOutcomes.children} completed, ${explorerOutcomes.outputCapBlocks} output-cap blocks, ${explorerOutcomes.otherRejected} other schema/execution rejections. Rejected preliminary output is not treated as valid evidence; normal topology retains its bounded orientation fallback. The audit compares each integrated Git tree with its verified worktree, checks clean trees, and rejects false completion.

| Class | Result | Seconds | Recorded tools | Source/temporary writes | Verified tests |
|---|---|---:|---:|---:|---:|
${table}

Real route: Kilo anonymous \`${models}\`; physical model(s): \`${physicalModels}\`; quota type PUBLIC_IP. Billing is UNKNOWN. No paid or local inference was selected in these campaigns. [Raw final campaign](R67-CANONICAL-CERTIFICATION-CAMPAIGN.json), [independent tree audit](R67-CANONICAL-AUDIT.json).

The refactor and test-creation baselines passed before model work. Bug/feature/debug/configuration fixtures deliberately contained the defect the task was asked to repair. Original invalid fixtures, failures and interrupted runs are retained in [history](R67-HISTORY-INDEX.json).

## Concurrency

Three logical users/tasks completed 3/3, with ${(concurrency.allTaskOverlapMs / 60000).toFixed(2)} minutes of simultaneous overlap. Zero cross-task session/workspace references, zero final leaked reservations, zero no-supply decisions in either final campaign. Mid-campaign ledger snapshots legitimately include other users' still-active reservations.

The historical 2/3 run's refactor began with a failing, incorrectly escaped test baseline. Horde review failed, Kilo rejected the change, and a continuing Coder revision reached the 600-second cancellation. Recorded requests show progress, not a scheduler deadlock. That run remains historical and cannot measure completion fairness for a valid refactor. Independent physical quota domains are not verified; all users used the available Kilo anonymous supply. [Final overlap](R67-MULTI-USER-CERTIFICATION.json).

## Recovery

Seven deterministic actual-process recovery regressions cover stage kills, saved-result/terminal-bookkeeping gaps, changed HEAD, ambiguous integration and persisted repair limits. Final real-provider recovery kills the parent at the Reviewer model-preflight boundary after a live Coder mutation; it does not claim interruption inside a served Reviewer stream. That case and server-startup recovery after recorded Coder mutation pass through review, verification, completion and integration with no recorded mutation replay. Temporary verification writes are counted separately from replay. [Reviewer recovery](R67-REVIEWER-RECOVERY-LIVE-certified.json), [server startup recovery](R67-SERVER-PARENT-RECOVERY-LIVE-certified.json), [regressions](R67-PARENT-CERTIFICATION-TESTS-final.json).

## Provider Faults

Controlled 429, 503 and socket/reset faults at the adapter boundary pass with actual eligible live role calls before/after the fault. Bounded retry on the only eligible route is exercised; live cross-provider rotation cannot be proven when Horde is ineligible. Full no-supply/fabric denial receipts and role-specific loss/exhaustion behavior are covered by runtime tests. Current Kilo receipt for \`${supply.qualification.modelId}\` is ${supply.qualification.qualificationState} overall (Reviewer ${reviewerQualification}); failed roles remain excluded. The auto route's later Planner/Reviewer hard failures remain recorded, and its earlier receipt was not reused for the final campaign. Fresh Horde fails the existing role thresholds and stays INELIGIBLE. [429](R67-PROVIDER-429-RECOVERY.json), [503](R67-PROVIDER-503-RECOVERY.json), [socket](R67-PROVIDER-SOCKET-RECOVERY.json), [Kilo qualification](R67-KILO-ROLE-QUALITY-refresh.json), [auto role loss](R67-KILO-ROLE-QUALITY-after-reader-fix.json), [Horde qualification](R67-HORDE-ROLE-QUALITY-refresh.json).

## Database Recovery

Production \`HostedQueueWorker\` and \`HostedAdmissionAuthority\` run against isolated SQLite state with real loopback ECONNREFUSED injected before the claim operation. Queued claims survive bounded/backed-off retries and complete once after reconnection. Duplicate enqueue remains idempotent; restart reconciliation releases an expired undispatched claim; ambiguous dispatched work is held for revalidation without replay; permanent dispatched failure is terminal and observable. All four cases leave zero active slots/reservations. No inference is dispatched in this test; six separate accounting fault cases prove settlement idempotency and retain unavailable usage as UNKNOWN/null.

This does not prove a production Postgres claim-loop outage. A separate Supabase test terminates only its own diagnostic connection and proves fresh SQL reconnect, not application claim recovery. [Queue certification](R67-DATABASE-RECOVERY-CERTIFICATION.json), [accounting](R67-ACCOUNTING-FAULTS.json), [diagnostic reconnect](R67-SUPABASE-DIAGNOSTIC-RECOVERY.json).

## Validation

Workspace build/typecheck: ${build.status}, exit ${build.exitCode}. Canonical suite: ${suite.status}; ${suite.totals ? `${suite.totals.passed} passed, ${suite.totals.failed} failed, ${suite.totals.skipped} skipped, ${suite.totals.todo} todo across ${suite.totals.files} files` : 'still running'}. The standalone certificate canary runs after evidence freeze. Commands, phase exit codes, memory samples and exact totals are in [canonical validation](R67-REPOSITORY-TESTS.json).

Focused tool/command safety: 56/56; Windows exit/quoting checks: 54/54; new-file/runtime regression set: 11/11; parent crash certification: 7/7; source-identity canaries: 9/9; ConPTY teardown and command regressions: 35/35; synchronized watchdog regressions: 5/5. The watchdog test now waits for three persisted extensions instead of assuming cold preflight completes in three seconds; runtime limits are unchanged. The final source delta changes only that test, with all 112 implementation source files byte-identical to those used in the final live campaign. Historical failed harness assertions and timeout outputs remain, with corrections explained. Source and evidence scans require zero owner review findings before commit.

Runtime source-state ID: \`${frozen.sourceStateId}\`. Runtime raw-byte aggregate: \`${frozen.sourceAggregateSha256}\` (${frozen.files.length} files). The complete [source certificate](source-certification.json) additionally binds certification harnesses, tests, release helpers and evidence bytes. Preserved user changes are outside the commit/certificate source set; the canonical recovery fixture's pre-existing addition only implements an unused \`recover:\` entry point.

## Windows Package

Actual rebuilt production-channel Electron package: startup, file renderer, trusted IPC backend \`/api/health\` 200, session access 200, 14 responsive idle samples, owned crash/restart and clean recoverable runtime status pass. Cloud endpoint is the approved production HTTPS endpoint. Isolated GitHub account is unauthenticated; authenticated packaged coding is HUMAN_AUTH_REQUIRED and was not attempted. Authentication dialogs were not automated. [Package evidence](R67-WINDOWS-CERTIFIED-IDLE-RESTART.json).

## Production

Render service \`srv-dam6f83m8hqs73clo5ig\`, workspace \`tea-daa3l35g1s2s73c1t8mg\`, URL https://codeforge-cloud-va.onrender.com. Deployment: ${deployment?.status ?? 'PENDING'}. Revision: ${deployment?.commit ?? 'PENDING'}. Smoke: ${smoke?.status ?? 'PENDING'}.

${smoke ? 'Liveness/readiness are 200; database is connected; anonymous remote sessions remain 401. Deployment identity matches the certified runtime revision. Authenticated production coding is not claimed.' : 'The source-certified implementation must be committed and pushed before deployment; R66 remains live until then.'}

## Remaining Blockers

${closure === 'CODEFORGE_R67_CLOSED' ? 'Backend/runtime release blockers: NONE. Isolated authenticated packaged-task gate: HUMAN_AUTH_REQUIRED.' : 'Final canonical validation/certificate/deployment are pending; no runtime failure is asserted from incomplete execution.'}

R67 demonstrates repeated completion of six ordinary public engineering fixtures, overlapping logical users, safe real process/server recovery and truthful controlled provider/queue fault handling. It supports bounded everyday backend development on currently eligible free supply. It does not prove indefinite provider availability, independent physical quota pools, large-repository task complexity, a production Postgres outage, authenticated packaged coding, or an authenticated production coding smoke. Historical failures remain part of the evidence.
`;
await writeFile(`${directory}/R67-FINAL-REPORT.md`, text);
console.log(JSON.stringify({ closure, runtimeRevision: deployment?.commit, suite: suite.status }));
