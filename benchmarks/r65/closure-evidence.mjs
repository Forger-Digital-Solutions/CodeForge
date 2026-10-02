import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = 'docs/evidence/free-capacity-fabric/';
const read = async (name) => JSON.parse(await readFile(`${directory}${name}`, 'utf8'));
const a = await read('R64-DOMAIN-A-LIVE.json');
const b = await read('R65-DOMAIN-B-LIVE.json');
const failover = await read('R65-CROSS-DOMAIN-FAILOVER.json');
const users = await read('R65-MULTIUSER-ISOLATION.json');
const fresh = await read('R65-FRESH-USER-ACCEPTANCE.json');
const qualification = await read('R65-HORDE-QUALIFICATION-google_gemma-4-31b.json');
const decisions = (await readFile(`${directory}R65-FAILOVER-DECISIONS.ndjson`, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
const rotations = failover.routingReceipts.map((item) => item.receipt).filter((receipt) => receipt.action === 'ROTATE');
const requireFact = (fact, code) => { if (!fact) throw new Error(code); };
for (const result of [a.result, b.result, failover.result]) {
  requireFact(result.status === 'completed' && result.review.passed && result.completion.outcome === 'completed', 'PRIOR_COMPLETION_EVIDENCE_INVALID');
}
requireFact(Object.values(qualification.roleResults).length === 6 && Object.values(qualification.roleResults).every((role) => role.status === 'QUALIFIED'), 'HORDE_QUALIFICATION_INVALID');
requireFact(users.checks.length === 11 && users.checks.every((check) => check.pass), 'MULTIUSER_EVIDENCE_INVALID');
requireFact(fresh.noKey && fresh.secretsWritten === 0, 'FRESH_USER_EVIDENCE_INVALID');
requireFact(rotations.length === 2 && rotations.every((receipt) => receipt.previous.providerId === 'kilo-free-direct' && receipt.selected.providerId === 'ai-horde'), 'FAILOVER_EVIDENCE_INVALID');
const providers = new Set(failover.modelTurns.map((turn) => turn.servedProviderId));
requireFact([...providers].every((provider) => ['kilo-free-direct', 'ai-horde'].includes(provider)), 'UNEXPECTED_PROVIDER');
const falseWaits = decisions.filter((decision) => /WAIT/.test(decision.outcome)).length;
requireFact(falseWaits === 0, 'FAILOVER_WAIT_REQUIRES_REVIEW');
const evidence = [];
for (const name of ['R64-DOMAIN-A-LIVE.json', 'R65-DOMAIN-B-LIVE.json', 'R65-CROSS-DOMAIN-FAILOVER.json', 'R65-FAILOVER-DECISIONS.ndjson', 'R65-MULTIUSER-ISOLATION.json', 'R65-FRESH-USER-ACCEPTANCE.json', 'R65-HORDE-QUALIFICATION-google_gemma-4-31b.json']) {
  evidence.push({ path: `${directory}${name}`, sha256: createHash('sha256').update(await readFile(`${directory}${name}`)).digest('hex') });
}
const output = { generatedAt: new Date().toISOString(), status: 'PASS', priorLiveEvidenceVerifiedWithoutRepeatingInference: true,
  domainA: { provider: 'Kilo', supplyClass: 'PACKAGED_FREE_DIRECT', failureScope: 'SOURCE_IP', runId: a.result.runId },
  domainB: { provider: 'AI Horde', supplyClass: 'COMMUNITY_ANONYMOUS_FREE', failureScope: 'GLOBAL_SHARED', poolId: 'shared:ai-horde', privacy: 'PUBLIC_CODE_ONLY', runId: b.result.runId },
  qualification: { model: qualification.modelId, roles: Object.fromEntries(Object.entries(qualification.roleResults).map(([name, value]) => [name, value.status])) },
  failover: { runId: failover.result.runId, controlledFault: failover.domains.A.fault, liveDestination: true, rotateReceipts: rotations.map(({ receiptId, createdAt, role }) => ({ receiptId, createdAt, role })), decisions: decisions.length, waitsObserved: falseWaits },
  multiUser: { checks: users.checks.length, passed: users.checks.filter((check) => check.pass).length, scope: users.pool.quotaDomainType }, evidence };
await writeFile(`${directory}R65-CLOSURE-LIVE-EVIDENCE-VERIFICATION.json`, `${JSON.stringify(output, null, 2)}\n`);
const metrics = { generatedAt: output.generatedAt, measurement: 'Prior real provider public coding fixtures and controlled fault failover; not a claim of private-code Horde eligibility or per-user upstream pools',
  admittedFreeDomains: 2, independentGroups: 2, liveCodingDomains: 2, successfulLiveFailoverRuns: 1, successfulRouteRotations: rotations.length,
  domainA: output.domainA, domainB: output.domainB, paidFallbacksInLiveFixture: 0, byokFallbacksInLiveFixture: 0, falseWaits,
  providerBillTotal: 'UNKNOWN', zeroBillingAuthority: 'Verified zero-price admission and served-provider receipts; no provider billing receipt fabricated',
  evidence: output.evidence, failoverFault: failover.domains.A.fault };
await writeFile(`${directory}R65-CAPACITY-METRICS.json`, `${JSON.stringify(metrics, null, 2)}\n`);
console.log(JSON.stringify({ status: output.status, liveCodingDomains: metrics.liveCodingDomains, rotateReceipts: rotations.length, falseWaits }));
