import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSessionPersistence } from "@codeforge/sessions";
import { buildExperienceReceipt } from "../../packages/server/dist/experience-learning.js";

const root = path.resolve(import.meta.dirname, "../..");
const evidenceDir = path.join(root, "docs/evidence/r57-autonomous-endurance-learning");
const livePath = path.join(evidenceDir, "live-run.json");
const live = JSON.parse(fs.readFileSync(livePath, "utf8"));
assert.equal(typeof live.dbPath, "string");
const persistence = createSessionPersistence({ dbPath: live.dbPath });
await persistence.init();
try {
  const local = (await persistence.getWorkItemsByKind("autonomous_experience_receipt")).map((item) => item.receipt);
  const generalized = (await persistence.getWorkItemsByKind("generalized_experience_signal")).map((item) => item.signal);
  const interventions = (await persistence.getWorkItemsByKind("strategy_intervention_receipt")).map((item) => ({
    classification: item.classification,
    strategyFingerprint: item.strategyFingerprint,
    failureSignature: item.failureSignature,
    intervention: item.intervention,
  }));
  const runItem = (await persistence.getWorkItemsByKind("autonomous_run"))[0];
  const workers = await persistence.getWorkItemsByKind("subagent_run");
  const result = JSON.parse(runItem.resultJson);
  const projection = buildExperienceReceipt({
    id: runItem.id, sessionId: runItem.sessionId, status: runItem.status,
    error: runItem.error, startedAt: runItem.startedAt, completedAt: runItem.completedAt,
    reviewRounds: runItem.reviewRounds, result, topology: result.topology,
  }, workers);
  const output = { schemaVersion: "r57-live-experience/v1", evidenceClass: "live_provider", runStatus: live.runStatus, local, generalized, interventions, postRunProjection: projection };
  assert.equal(local.length, generalized.length);
  assert.ok(local.length >= 1, "Live autonomous run did not persist an experience receipt");
  assert.equal(/Inspect the repository|src\/math\.mjs|src\/format\.mjs|r56-live-owner/.test(JSON.stringify(generalized)), false);
  fs.writeFileSync(path.join(evidenceDir, "live-experience.json"), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ runStatus: live.runStatus, localReceipts: local.length, generalizedSignals: generalized.length, interventions: interventions.length, labels: generalized.map((item) => item.label), normalizedRoles: projection.generalized.roles }));
} finally {
  await persistence.close();
}
