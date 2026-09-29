import fs from "node:fs";
import path from "node:path";
import { createSessionPersistence } from "@codeforge/sessions";

const root = path.resolve(import.meta.dirname, "../..");
const dbPath = path.join(root, "apps/desktop/release/smoke-user-data/codeforge.db");
const out = path.join(root, "docs/evidence/r57-autonomous-endurance-learning/packaged-repeat-diagnostic.json");
const persistence = createSessionPersistence({ dbPath });
await persistence.init();
try {
  const runs = await persistence.getWorkItemsByKind("run_inspection");
  const run = runs.at(-1);
  const events = await persistence.getEvents("default");
  const failures = events.filter((event) => event.type === "turn.failed" && event.payload?.failure).map((event) => ({
    code: event.payload.failure.code,
    providerId: event.payload.failure.providerId ?? null,
    modelId: event.payload.failure.modelId ?? null,
    retryable: event.payload.failure.retryable,
  }));
  const evidence = {
    schemaVersion: "r57-packaged-repeat/v1", evidenceClass: "packaged_live_provider",
    status: run.status, completionOutcome: run.completion?.outcome,
    completionBlockerCodes: (run.completion?.blockers ?? []).map((blocker) => blocker.code),
    independentReviewApproved: run.review?.approved,
    verificationAttempts: (run.verificationAttempts ?? []).map((attempt) => ({ passed: attempt.passed, failed: attempt.failed })),
    failureCodes: failures, paidRoutesSelected: events.filter((event) => event.type === "router.selection").some((event) => event.payload?.providerId === "paid-auto"),
  };
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally {
  await persistence.close();
}
