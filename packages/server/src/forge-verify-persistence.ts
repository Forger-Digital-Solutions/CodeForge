import type { SessionPersistence, WorkItem } from "@codeforge/sessions";
import type { ForgeVerifyObserver, VerificationAttempt, VerificationEvidence, VerificationPlan } from "@codeforge/workflow";

type VerificationWorkItem = Extract<WorkItem, { kind: "verification" }>;

function item(sessionId: string, recordType: VerificationWorkItem["recordType"], id: string, planId: string, runId: string, payload: Record<string, unknown>, status?: string): VerificationWorkItem {
  const now = new Date().toISOString();
  return { kind: "verification", id, sessionId, runId, recordType, planId, payload, ...(status ? { status } : {}), createdAt: now, updatedAt: now };
}

/** Persists ForgeVerify's structured records without making terminal evidence mutable. */
export function createForgeVerifyPersistenceObserver(persistence: SessionPersistence, sessionId: string): ForgeVerifyObserver {
  return {
    planCreated: (plan: VerificationPlan) => {
      persistence.insertImmutableWorkItem(item(sessionId, "plan", plan.planId, plan.planId, plan.runId, plan as unknown as Record<string, unknown>));
    },
    attemptStarted: (attempt: VerificationAttempt) => {
      persistence.upsertWorkItem(item(sessionId, "attempt", attempt.attemptId, attempt.planId, attempt.runId, attempt as unknown as Record<string, unknown>, attempt.status));
    },
    attemptTerminal: (attempt: VerificationAttempt) => {
      persistence.upsertWorkItem(item(sessionId, "attempt", attempt.attemptId, attempt.planId, attempt.runId, attempt as unknown as Record<string, unknown>, attempt.status));
    },
    evidenceCreated: (evidence: VerificationEvidence) => {
      persistence.insertImmutableWorkItem(item(sessionId, "evidence", evidence.evidenceId, evidence.planId, evidence.runId, evidence as unknown as Record<string, unknown>, evidence.status));
    },
  };
}
