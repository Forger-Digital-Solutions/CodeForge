import { readFile, writeFile } from 'node:fs/promises';
const directory = 'docs/evidence/r66-everyday-free-readiness';
const read = (name) => readFile(`${directory}/${name}`, 'utf8').then(JSON.parse);
const start = await read('R66-START-STATE.json');
const tests = await read('R66-REPOSITORY-TESTS.json');
const outcomes = await read('R66-TASK-OUTCOMES.json');
const endurance = await read('R66-ENDURANCE.json');
const kill = await read('R66-KILL-RESUME.json');
const accounting = await read('R66-ACCOUNTING-FAULTS.json');
const scale = await read('R66-SCALE-SIMULATION.json');
const windows = await read('R66-WINDOWS-SOAK.json');
const finalWindows = await read('R66-WINDOWS-FINAL-CANDIDATE.json').catch(() => null);
const ui = await read('R66-UI-RESPONSIVENESS.json');
const capacity = await read('R66-CAPACITY-METRICS.json');
const deployment = await read('R66-PRODUCTION-DEPLOYMENT.json').catch(() => ({status:'PENDING'}));
const runtimeHead = process.argv[2] ?? 'NOT_COMMITTED';
const tasks = outcomes.campaigns.flatMap((campaign) => campaign.tasks);
const money = (bytes) => (bytes / 1048576).toFixed(2);
const taskLines = tasks.map((task) => `| ${task.id} | ${task.taskClass} | ${task.status} | ${task.roles.map((role) => `${role.role}:${role.model?.providerId ?? 'none'} (${role.status})`).join('; ')} | ${task.roles.reduce((sum, role) => sum + (role.telemetry?.toolCalls ?? 0), 0)} | ${task.result?.changedFiles?.join(', ') ?? 'none'} | before ${task.testsBefore?.exitCode ?? '?'} / after ${task.testsAfter?.exitCode ?? '?'} | ${task.result?.review?.passed ? 'PASS' : 'NO VALID PASS'} | ${task.result?.verification?.length ? task.result.verification.every((item) => item.passed) ? 'PASS' : 'FAIL' : 'NOT REACHED'} | ${task.result?.completion?.outcome ?? 'NOT REACHED'} |`).join('\n');
const gates = { A: {status:'PASS',meaning:'R65 certificate/focused baseline/build passed before edits; historical R65 evidence preserved.'}, B: {status:'PARTIAL',meaning:'Bug fix, multi-file feature, and debugging completed. Refactor, test creation, and configuration did not complete; only bug fix is earned again on final source.'}, C: {status:'NOT_MET',meaning:`${endurance.attempted} live attempts, ${endurance.completed} completed; maximum consecutive completion ${endurance.consecutiveCompletedTasksMaximum}.`}, D: {status:'PARTIAL',meaning:'Both providers responded to all four spaced transport observations; failure-to-recovery state transitions are deterministic simulation, not live role-recovery certification.'}, E: {status:'PARTIAL',meaning:'250 deterministic degraded-provider admissions, zero false waits. Live denials lack a per-denial healthy-eligible oracle; live count remains null.'}, F: {status:'PASS_OBSERVED',meaning:`${endurance.falseCompletions} false completions across ${endurance.attempted} live attempts; authoritative review/verification/integration checked.`}, G: {status:'NOT_MET',meaning:'Four real worker kills/restarts passed; autonomous parent recovery still blocks active runs and clears its workspacePath.'}, H: {status:'PARTIAL',meaning:'Three real overlapping logical users shared one ledger; all tasks blocked on review. Sustained completion and no starvation are unproven.'}, I: {status:'PASS_ENFORCEMENT',meaning:'250 private-context denials with Horde as only healthy supply, zero selected private routes; all live source was public synthetic fixtures.'}, J: {status:'PASS_ROUTE_ENFORCEMENT',meaning:'No paid/BYOK route selections or credentials; actual monetary billing remains UNKNOWN.'}, K: {status:'NOT_MET',meaning:'Actual packaged startup, 10-minute onboarding liveness, blocked task and restart measured. Login and multi-task workbench use are unproven.'}, L: {status:tests.repositoryWideGreen?'PASS':'PENDING',meaning:'Canonical main plus four serial heavy phases; certificate canary separately.'}, M: {status:deployment.status==='PASS'?'PASS':'PENDING',meaning:'Exact validated runtime commit must be live on the named Render service.'}, N: {status:'PARTIAL_SOURCE_CERTIFICATE',meaning:'Source/evidence integrity certificate supports this PARTIAL result; it does not certify daily-use closure.'} };
await writeFile(`${directory}/R66-CLOSURE-GATES.json`, `${JSON.stringify({generatedAt:new Date().toISOString(),closureStatus:'CODEFORGE_R66_PARTIAL',gates},null,2)}\n`);
const report = `CODEFORGE_R66_PARTIAL

# R66 everyday Free readiness

The role qualification and bounded review-recovery fixes are earned. Everyday reliability is not certified: only ${endurance.completed}/${endurance.attempted} real autonomous attempts completed, ordinary structured role output remains weak, repeated parent recovery is unsupported, and authenticated packaged daily use was not demonstrated. No gate was lowered to produce success.

## 1. Repository

Starting HEAD: ${start.head}. Runtime commit: ${runtimeHead}. Branch: ${start.branch}. The final evidence commit follows this runtime commit and changes no runtime source; its exact hash is in the final chat response and Git history. All six preexisting tracked dirty files were verified byte-preserved, kept unstaged, and excluded from the commits. Older untracked artifacts were retained. CF14 source bytes are unchanged.

## 2. Production baseline

Render service codeforge-cloud-va / srv-dam6f83m8hqs73clo5ig began live at c32037b95c93fee3d41c7d259794e69c84b62b72, deployment dep-db04dn2d0e5s73a2ks5g. Live/ready were HTTP 200; database connected; anonymous remote session access correctly returned 401. Supabase pbqrneccjvoojcispzyj reported ACTIVE_HEALTHY, including the later recheck. See R66-PRODUCTION-BASELINE.json and R66-CONTROL-PLANE-BASELINE.json.

## 3. Free domains

Kilo remains PACKAGED_FREE_DIRECT, anonymous, SOURCE_IP / shared egress scope. Its final frozen-fixture receipt qualifies all six roles. Horde remains COMMUNITY_ANONYMOUS_FREE, GLOBAL_SHARED, PUBLIC_CODE_ONLY. The still-current R65 receipt for google/gemma-4-31b is qualified across six roles; R66 ordinary Horde Reviewer output was repeatedly unusable. Horde uses text-tool mediation, not native tool calling. Fixture qualification is not ordinary task success. All four spaced transport observations for each provider received text; that does not prove every role healthy.

## 4. Kilo role improvement

Explorer moved from NOT_QUALIFIED to QUALIFIED, and Planner from probation/failure to QUALIFIED, using 24 real anonymous requests in the final trace. The existing last Explorer call is reserved for a report; parallel tools form one assistant batch; complete JSON tagged length is scored rather than discarded; literal grounded NodeNext imports are accepted while phantom imports remain hard failures. Protocol versions changed, thresholds and call caps did not. R66-KILO-ROLE-QUALITY-final.json is the final receipt; earlier receipts remain historical.

Measured qualification tier now precedes supply-domain order. The existing bounded Reviewer independence preference works across eligible domains and applies only to Reviewer requests; sponsored-before-user coding conservation remains intact. Anonymous Kilo/Horde quality handoff is bounded to one replacement. A malformed-output early return now retains the actual served route and quota pool, so its replacement can exclude that route. The negative reproduction failed before this fix; 77 focused regressions passed afterward. A real final-source bug-fix completion earned the Horde-to-Kilo semantic review replacement, with reduced independence recorded honestly.

## 5. Task campaign

Every attempt used the production normal orchestrator, actual Git fixtures/worktrees, live anonymous providers, Explorer/Coder/Reviewer where executable, real node tests, ForgeVerify, completion authority and integration. Failed review never bypassed verification or completion. Initial sequential tasks loaded before anonymous handoff, and overlapping tasks before route-identity preservation; final-source tasks are separate. Exact models, turn count, tool calls, wall time, test output, review findings, verification and integration are retained in R66-TASK-OUTCOMES.json.

The successful classes were retry-boundary bug repair (3 tests), multi-file normalizeTags feature (3 tests), and cache-expiry debugging (4 tests). Refactor, meaningful test creation, and package-exports repair were attempted but remained blocked. Planner was not required by these bounded normal-topology tasks.

| Attempt | Class | Status | Roles/providers | Tools | Changed files | Root tests exit | Reviewer | ForgeVerify | Completion |
|---|---|---|---|---:|---|---|---|---|---|
${taskLines}

## 6. Endurance

${endurance.attempted} attempts, ${endurance.completed} completed, ${endurance.blocked} blocked, ${endurance.failed} failed after repairing collector classifications. ${endurance.modelTurns} model turns and ${endurance.toolCalls} tool calls. ${endurance.retries} reported transport retries; four role replacements are distinct from transport retries. Maximum consecutive completions: ${endurance.consecutiveCompletedTasksMaximum}. ${endurance.successfulRoleQualityHandoffs} successful bounded semantic replacement. False completions: ${endurance.falseCompletions}. Live false waits remain unclassified, not zero. The initial diff collector assumed HEAD~1 existed for blocked runs; SQLite recovered the authoritative outcomes.

## 7. Provider recovery

Four spaced live transport observations per provider received responses. Deterministic RouteHealthAuthority campaigns proved cooldown/recovery behavior for both providers, with no retry storm. Actual degradation-to-recovery role behavior was not earned. Later transport success does not retrospectively prove earlier role eligibility. See R66-PROVIDER-RECOVERY-LIVE.json and R66-SCALE-SIMULATION.json.

## 8. Kill/resume

${kill.killCount} actual worker process kills, ${kill.restartCount} restarts, ${kill.successfulResumptions} recovered workers, ${kill.duplicateObservedWrites} duplicate recorded writes. A killed recovery owner retains its existing 60-second lease; attempting recovery before expiry was correctly blocked. The corrected campaign waits for that lease. Scripted test providers, production SQLite/journals and real writes were used. This is worker recovery, not autonomous parent verification/integration recovery. Parent recoverRuns deliberately blocks active runs and loses workspacePath; that mandatory gate remains open. The packaged blocked-task restart is also separate from interrupted active-task recovery.

## 9. Multi-user

Three real logical users ran overlapping tasks through one shared reservation ledger with separate owner connections, sessions, SQLite files and worktrees. All three coders produced changes; all parents stayed blocked on unusable review. Local fairness simulation admitted three light users while limiting a heavy user to three standing holds; no local starvation was observed. Sustained live no-starvation completion and cross-user credential fault injection are not certified. No credentials were used by these anonymous tasks.

## 10. Privacy

All ${endurance.attempted} live attempts and all qualification inputs were explicitly public synthetic/frozen fixtures. Private live payloads sent: zero. With Kilo disabled and only Horde healthy, 250 adversarial private-context decisions denied Horde; private route selections were zero. Public Horde eligibility was separately exercised. No private user code was sent to prove the privacy gate.

## 11. Anti-loop / learning

Model-turn exhaustion stopped the initial refactor honestly. Structured-output repair and semantic replacement remained bounded. No infinite run was observed; safe abort is not everyday completion. Generalized experience records contain numeric/enumerated operational signals, not source, prompt or transcript content. The existing R57 tests prove repeated prior outcomes can change bounded recovery advice. Isolated task databases deliberately prevent attributing a cross-task learned effect to this live campaign. No neural training occurred.

## 12. Accounting

Six deterministic accounting fault cases passed, including real crash after reservation, replay after restart, settlement write failure, duplicate settlement, and UNKNOWN usage/cost preservation. Duplicate settlement, UNKNOWN-to-zero coercion, and successful-inference replay caused by accounting failure were all zero. Remote result/ACK/lease/idempotency contracts and user allowance isolation passed focused regression tests. These ledger simulations perform no paid inference or charge. No paid or BYOK routes were selected across logged live calls. Provider monetary totals were not independently measured and remain UNKNOWN. Missing usage must not be represented as a measured zero.

## 13. Windows packaged soak

Actual Electron package, production cloud manifest, dedicated isolated profile and public fixture. The initial restricted launch failed renderer exit 49; normal outside-sandbox startup succeeded. Recorded soak duration: ${(windows.durationMs/1000).toFixed(1)} seconds; ${windows.samples.length} samples; one blocked task and one restart. Launch ${(windows.launchMs/1000).toFixed(3)} seconds; peak sampled main-process RSS ${money(ui.peakMainRssBytes)} MiB; maximum renderer animation-frame round trip ${ui.maxRendererRoundTripMs.toFixed(2)} ms. Main-process memory is not process-tree memory. The package identified the starting commit with dirty source; final packaging identity is separately recorded if rebuilt.

Final committed-source package observation: ${finalWindows ? JSON.stringify({status:finalWindows.status,identity:finalWindows.identity,durationMs:finalWindows.durationMs,tasks:finalWindows.tasks.map(({lastStatus})=>({lastStatus})),restarts:finalWindows.restarts.length}) : 'not yet recorded'}.

The fresh profile displayed normal first-run/GitHub sign-in. No authenticated session arrived in the ten-minute handoff. Scroll/files/tabs/Settings/Free Capacity during successful coding, second and third tasks, active-task interruption/recovery, socket leak behavior and full process-tree growth remain unproven. The process was closed and relaunched cleanly. No authentication, age acknowledgment, or success was fabricated.

## 14. Scale

Deterministic compiled fabric/ledger: 10, 25, 50 and 100 concurrent users with three overlapping reservations each; 373-user daily profile with 746 sequential tasks. All standing holds were released. 250 alternating degraded-provider decisions admitted healthy simulated supply; false waits zero. The heavy user's fourth hold queued while light B/C/D admitted. Simulation quotas were declared inputs and are not measured Horde upstream throughput. Live users: three, with zero completed overlapping tasks.

## 15. Capacity metrics

Two admitted domains and two independent upstream groups in the campaign. Twelve role routes across the final Kilo fixture receipt and historical-current Horde receipt; healthy production role routes are not inferred from that count. ${capacity.successfulR66LiveCrossDomainCompletions} completed mixed-provider tasks; successful semantic replacement is separately counted. Live false waits null; simulated false waits zero; paid/BYOK route selections zero. Model identity churn simulation removes the old route, holds the alternate inert, qualifies it once with a scripted receipt, and avoids duplicate refresh qualification. Live alternate-model role quality and capability churn under an unchanged model ID remain unproven.

## 16. Repository validation

Status ${tests.status}; canonical totals excluding separate certificate canary: ${JSON.stringify(tests.totals ?? {})}. Observed process-tree RSS peak ${money(tests.peakProcessTreeWorkingSetBytes)} MiB, using independent recursive enumeration every 15 seconds; this is an observed peak. Main phase uses two workers, four heavy phases run serially, heap cap 2048 MiB. The initial serving-pilot failure was corrected by making cross-domain independence Reviewer-only; 89 conservation-focused tests passed before final source. A later lost-route reproduction justified the final small runtime fix and a new source-frozen run. Superseded runs are not reported green. CF14 source and policy were not relaxed. Full workspace build passed.

## 17. Production deployment

${JSON.stringify(deployment)}. Runtime fixes are committed and deployed only after canonical green. Final evidence follows the runtime commit without changing runtime source. Health, readiness, database, revision, remote authentication boundary and Supabase status are recorded separately from task completion.

## 18. Certification

r66-everyday-free-readiness-v1 is a PARTIAL source/evidence integrity certificate. It inherits authoritative routing/qualification/health/anti-loop/experience/dispatch/reservation/completion/accounting/privacy/discovery source paths and adds the R66 implementation and harnesses. The historical R65 certificate is untouched. The default certificate verifier selects the R66 successor once present. FG11, FG12E, canary and secret scans are run after evidence freeze and recorded in R66-FINAL-CANARIES.json / R66-CERTIFICATE-VERIFICATION.json. Canonical canary is counted separately. Byte integrity does not assert everyday closure.

## 19. Remaining blockers

Ordinary role structured output and quality/capacity eligibility remain unreliable after a few tasks; only one task completed on the final source. No sustained consecutive Free completion. Repeated autonomous parent kill/resume is unsupported. Overlapping real users did not complete. Both-provider live degradation/recovery and an authoritative per-denial live no-false-wait count are not earned. Authenticated packaged multi-task daily use is not earned. Model churn lifecycle is deterministic; unchanged-ID capability changes and live alternate qualification are unproven. None is concealed by unit-test green or by the source certificate.

## 20. Evidence paths

G:/CodeForge/docs/evidence/r66-everyday-free-readiness/R66-FINAL-REPORT.md

G:/CodeForge/docs/evidence/r66-everyday-free-readiness/source-certification.json

G:/CodeForge/docs/evidence/r66-everyday-free-readiness/R66-TASK-OUTCOMES.json

G:/CodeForge/docs/evidence/r66-everyday-free-readiness/R66-REPOSITORY-TESTS.json

G:/CodeForge/docs/evidence/r66-everyday-free-readiness/R66-USER-WORK-PRESERVATION.json

Reproducers: G:/CodeForge/benchmarks/r66/. Owned binary/profile/worktree/log files are kept under its ignored tmp/ directory, and are not shipped as source.

## 21. Commits

Starting evidence HEAD ${start.head}; runtime ${runtimeHead}; final evidence hash is reported in chat/Git. Both authorized branches are pushed by fast-forward only. No unrelated tracked or untracked work is committed.
`;
await writeFile(`${directory}/R66-FINAL-REPORT.md`, report);
console.log(JSON.stringify({closureStatus:'CODEFORGE_R66_PARTIAL',runtimeHead,tests:tests.status,attempted:endurance.attempted,completed:endurance.completed}));
