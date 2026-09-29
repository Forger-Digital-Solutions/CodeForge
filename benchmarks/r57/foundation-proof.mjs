import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildExperienceReceipt, adviseFromExperience } from "../../packages/server/dist/experience-learning.js";
import { classifyRetryNovelty, strategyFingerprint } from "../../packages/server/dist/strategy-novelty.js";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, "docs/evidence/r57-autonomous-endurance-learning/foundation-proof.json");
const run = {
  id: "fixture-run", sessionId: "fixture-owner-session", workspaceId: "fixture-workspace",
  goal: "fixture-goal", status: "completed", baseRevision: "base", reviewRounds: 0,
  taskGraph: { tasks: [] }, counters: { childrenSpawned: 1, reviewRounds: 0, taskAttempts: 1, verificationAttempts: 1 },
  result: {
    status: "completed", completion: { outcome: "completed" }, integration: { status: "integrated" },
    changedFiles: ["src/fixture.ts"], counters: { verificationAttempts: 1 },
  },
  topology: { complexity: { tier: "normal" }, repositoryFileCount: 12 },
};
const verified = buildExperienceReceipt(run, [{ kind: "subagent_run", id: "worker-1", sessionId: run.sessionId, parentRunId: run.id, role: "coder", status: "completed", telemetry: { modelRequests: 2, toolCalls: 3 } }]);
assert.equal(verified.generalized.label, "VERIFIED_SUCCESS");
const unverified = buildExperienceReceipt({ ...run, status: "blocked", result: { ...run.result, completion: undefined, integration: { status: "blocked" } } }, []);
assert.notEqual(unverified.generalized.label, "VERIFIED_SUCCESS");
const a = { targetFiles: ["src/fixture.ts"], failureCodes: ["TEST_FAILED"], stateDigest: "patch-a" };
const b = { ...a, stateDigest: "patch-b" };
const c = { ...a, stateDigest: "patch-c" };
const trace = [
  { attempt: 1, classification: classifyRetryNovelty([], a), fingerprint: strategyFingerprint(a) },
  { attempt: 2, classification: classifyRetryNovelty([a], b), fingerprint: strategyFingerprint(b) },
  { attempt: 3, classification: classifyRetryNovelty([a, b], c), fingerprint: strategyFingerprint(c) },
];
assert.deepEqual(trace.map((entry) => entry.classification), ["NOVEL_STRATEGY", "LOW_NOVELTY_RETRY", "STRATEGY_EXHAUSTED"]);
const exhausted = { ...verified.generalized, label: "STRATEGY_EXHAUSTED" };
const advice = adviseFromExperience([exhausted, exhausted], "normal");
assert.equal(advice.action, "INDEPENDENT_DIAGNOSIS");
const evidence = {
  schemaVersion: "r57-foundation-proof/v1", evidenceClass: "deterministic_fixture",
  verifiedReceipt: verified.local, generalizedSignal: verified.generalized,
  unverifiedLabel: unverified.generalized.label, strategyTrace: trace, laterTaskAdvice: advice,
  privacyScan: { prohibitedContentPresent: /fixture-goal|fixture-workspace|src\/fixture\.ts|fixture-owner-session/.test(JSON.stringify(verified.generalized)) },
};
assert.equal(evidence.privacyScan.prohibitedContentPresent, false);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ verifiedLabel: verified.generalized.label, classifications: trace.map((entry) => entry.classification), advice: advice.action, privacyPass: true }));
