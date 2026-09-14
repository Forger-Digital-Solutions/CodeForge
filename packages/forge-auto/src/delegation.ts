import type { TaskClassification } from "./classification.js";

/**
 * Operational delegation records (R1 spec §81, §120–§121). Machine-readable facts about which
 * specialist served which seat and why — reason codes only, NEVER hidden chain-of-thought.
 * These records are what diagnostics (§97) and failover (§120) consume.
 */

export type TrustDomain = "FORGE_AUTO_FREE" | "FORGE_AUTO_GEMS" | "USER_CUSTOM_AUTO" | "DIRECT_USER_PROVIDER";

export interface DelegationSpecialist {
  seat: string;
  role: string;
  providerId: string;
  modelId: string;
  /** Route that actually served the seat — differs from the plan after failover. */
  servedBy?: { providerId: string; modelId: string };
  selectionReasons: string[];
}

export interface DelegationRecord {
  recordId: string;
  createdAt: string;
  task: string;
  trustDomain: TrustDomain;
  rosterRevision?: number;
  classification?: Pick<TaskClassification, "kind" | "complexity" | "risk" | "verificationBurden">;
  specialists: DelegationSpecialist[];
  /** Identifies the context handoff set shared by these specialists (§121). */
  handoffId: string;
  contextScope?: string[];
  reviewResult?: { performed: boolean; reviewer?: string; findings: number; outcome: "CLEAN" | "FINDINGS" | "SKIPPED" };
  verificationResult?: { required: boolean; burden: string; outcome: "PASSED" | "FAILED" | "PENDING" | "SKIPPED" };
}

let recordCounter = 0;

export function createDelegationRecord(input: Omit<DelegationRecord, "recordId" | "createdAt" | "handoffId"> & { handoffId?: string; createdAt?: string }): DelegationRecord {
  recordCounter += 1;
  const id = `delegation-${Date.now().toString(36)}-${recordCounter.toString(36)}`;
  return {
    recordId: id,
    createdAt: input.createdAt ?? new Date().toISOString(),
    handoffId: input.handoffId ?? `handoff-${id}`,
    task: input.task,
    trustDomain: input.trustDomain,
    ...(input.rosterRevision !== undefined ? { rosterRevision: input.rosterRevision } : {}),
    ...(input.classification ? { classification: input.classification } : {}),
    specialists: input.specialists,
    ...(input.contextScope ? { contextScope: input.contextScope } : {}),
    ...(input.reviewResult ? { reviewResult: input.reviewResult } : {}),
    ...(input.verificationResult ? { verificationResult: input.verificationResult } : {}),
  };
}

/** Renders the record for diagnostics display — operational facts only. */
export function renderDelegationSummary(record: DelegationRecord): string {
  const seats = record.specialists
    .map((s) => `${s.seat}=${s.servedBy ? `${s.servedBy.providerId}::${s.servedBy.modelId}` : `${s.providerId}::${s.modelId}`}`)
    .join(", ");
  const parts = [
    `[${record.trustDomain}]`,
    record.rosterRevision !== undefined ? `roster r${record.rosterRevision}` : "roster unversioned",
    seats,
    record.verificationResult ? `verification:${record.verificationResult.outcome}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}
