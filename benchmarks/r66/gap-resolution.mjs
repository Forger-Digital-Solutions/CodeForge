import { writeFile, readFile } from 'node:fs/promises';
const directory = 'docs/evidence/r66-everyday-free-readiness';
const state = JSON.parse(await readFile('docs/codeforge-forgegreen-certified-source-state.json', 'utf8'));
const output = { generatedAt: new Date().toISOString(), sourceStateId: state.sourceStateId, status: 'PARTIAL', sourceFreeze: 'Final runtime includes malformed-output route identity preservation and Reviewer-only cross-domain preference.',
  fixed: [
    { id: 'EXPLORER_UNANNOUNCED_BUDGET', evidence: 'R66-KILO-ROLE-QUALITY-final.json: all roles QUALIFIED with unchanged call caps/thresholds', limitation: 'Normal Explorer output still truncates or fails schema.' },
    { id: 'PLANNER_COMPLETE_JSON_DISCARDED', evidence: 'Complete JSON tagged length is scored; grounded literal NodeNext imports are recognized. Phantom imports still fail.' },
    { id: 'ROLE_TIER_BEHIND_DOMAIN', evidence: 'Measured tier precedes domain order; R66-CONSERVATION-REGRESSIONS.json: 89 passed.' },
    { id: 'REVIEW_INDEPENDENCE_BEHIND_DOMAIN', evidence: 'Reviewer-only bounded independence preference crosses domains. Coding conservation order preserved.' },
    { id: 'ANONYMOUS_QUALITY_HANDOFF_EXCLUDED', evidence: 'Anonymous Kilo/Horde are eligible for the existing one-replacement handoff.' },
    { id: 'MALFORMED_OUTPUT_LOST_SERVED_ROUTE', evidence: 'Negative reproduction failed before fix; 77 focused tests passed after fix; final-source bug task completed after Horde-to-Kilo review replacement.' },
    { id: 'SCANNER_GIT_INVENTORY_BUFFER', evidence: 'Git inventory uses 16 MiB buffer; full scanner/self-test passed; detection and classification rules unchanged.' },
  ],
  remaining: [
    { priority: 'P1', id: 'ORDINARY_ROLE_OUTPUT_RELIABILITY', evidence: 'Final-source campaign: 1/6 complete; unusable review output and later unavailability. Fixture qualification alone is insufficient.' },
    { priority: 'P1', id: 'AUTONOMOUS_PARENT_RESTART', evidence: 'recoverRuns marks interrupted parent blocked and restores workspacePath as empty. Four worker crashes recovered safely; no parent end-to-end recovery.' },
    { priority: 'P1', id: 'LIVE_ELIGIBILITY_ORACLE', evidence: 'Later healthy transport does not explain earlier UNHEALTHY:HEALTHY role denials. No authoritative per-denial live false-wait count was recorded.' },
    { priority: 'P1', id: 'PACKAGED_AUTHENTICATED_DAILY_USE', evidence: 'Actual package/onboarding stayed responsive for ten minutes; GitHub sign-in and successful coding workspace interactions remain unproven.' },
    { priority: 'P2', id: 'UNCHANGED_ID_MODEL_CHURN', evidence: 'Different-model identity churn is bounded in simulation. Capability changes under the same ID need separate evidence.' },
    { priority: 'P2', id: 'QUALIFICATION_PERSISTENCE_FAILURE', evidence: 'Server attaches SqliteQualificationPersistence; ordinary receipts persist. qualifyLane still swallows save failure and may admit only in memory; fault durability not earned.' },
  ], p0Observed: [],
};
await writeFile(`${directory}/R66-GAP-RESOLUTION.json`, `${JSON.stringify(output, null, 2)}\n`);
await writeFile(`${directory}/R66-DATABASE-RECOVERY.json`, `${JSON.stringify({generatedAt:new Date().toISOString(),status:'PARTIAL',productionSupabase:'ACTIVE_HEALTHY',productionReadinessDatabase:'connected',localProof:'R66-ACCOUNTING-REMOTE-REGRESSIONS.json: transaction rollback, immutable idempotent accounting, real SQLite crash/reopen and lease replay',productionDisconnectInjected:false,realPostgresReconnectCampaign:'NOT_RUN',limitation:'Local/mock database contracts are not live Supabase disconnect/reconnect proof. Existing optional PostgreSQL tests remain skipped without an isolated PostgreSQL target.'},null,2)}\n`);
console.log(JSON.stringify({status:output.status,fixed:output.fixed.length,remaining:output.remaining.length}));
