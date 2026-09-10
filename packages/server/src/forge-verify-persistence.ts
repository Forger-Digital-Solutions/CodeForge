import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import type { ForgeVerifyObserver, VerificationAttempt, VerificationEvidence, VerificationPlan } from "@codeforge/workflow";
import type { GenericVerificationEvidence } from "@codeforge/forge-green";

type VerificationWorkItem = Extract<WorkItem, { kind: "verification" }>;

function item(sessionId: string, recordType: VerificationWorkItem["recordType"], id: string, planId: string, runId: string, payload: Record<string, unknown>, status?: string): VerificationWorkItem {
  const now = new Date().toISOString();
  return { kind: "verification", id, sessionId, runId, recordType, planId, payload, ...(status ? { status } : {}), createdAt: now, updatedAt: now };
}

/** Persists ForgeVerify's structured records without making terminal evidence mutable. */
export function createForgeVerifyPersistenceObserver(persistence: ISessionPersistence, sessionId: string): ForgeVerifyObserver {
  return {
    planCreated: async (plan: VerificationPlan) => {
      await persistence.insertImmutableWorkItem(item(sessionId, "plan", plan.planId, plan.planId, plan.runId, plan as unknown as Record<string, unknown>));
    },
    attemptStarted: async (attempt: VerificationAttempt) => {
      await persistence.upsertWorkItem(item(sessionId, "attempt", attempt.attemptId, attempt.planId, attempt.runId, attempt as unknown as Record<string, unknown>, attempt.status));
    },
    attemptTerminal: async (attempt: VerificationAttempt) => {
      await persistence.upsertWorkItem(item(sessionId, "attempt", attempt.attemptId, attempt.planId, attempt.runId, attempt as unknown as Record<string, unknown>, attempt.status));
    },
    evidenceCreated: async (evidence: VerificationEvidence) => {
      await persistence.insertImmutableWorkItem(item(sessionId, "evidence", evidence.evidenceId, evidence.planId, evidence.runId, evidence as unknown as Record<string, unknown>, evidence.status));
    },
    policyReceiptCreated: async (receipt) => {
      await persistence.insertImmutableWorkItem(item(sessionId, "policy_receipt", receipt.receiptId, receipt.receiptId, sessionId, receipt as unknown as Record<string, unknown>, receipt.decision));
    },
    coverageReceiptCreated: async (receipt) => {
      await persistence.insertImmutableWorkItem(item(sessionId, "coverage_receipt", receipt.coverageId, receipt.coverageId, sessionId, receipt as unknown as Record<string, unknown>, receipt.outcome));
    },
  };
}

export async function loadForgeVerifyEvidence(
  persistence: ISessionPersistence,
  sessionId: string,
  runId?: string,
): Promise<readonly GenericVerificationEvidence[]> {
  const items = await persistence.getWorkItems(sessionId);
  return items
    .filter((candidate): candidate is VerificationWorkItem => candidate.kind === "verification" && candidate.recordType === "evidence" && (!runId || candidate.runId === runId))
    .map((candidate) => candidate.payload as unknown as GenericVerificationEvidence);
}
