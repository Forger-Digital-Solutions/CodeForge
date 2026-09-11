import type { LegalDocumentId, LegalDocumentVersion } from "./legal-documents.js";

export type AcceptanceMechanism = "FIRST_RUN_ACK" | "SETTINGS_REACCEPT" | "API_EXPLICIT";

/**
 * Minimal evidence of acceptance. Deliberately excludes IP address and device fingerprint
 * (R1 remediation spec §34: "Avoid storing IP / device fingerprint unless actually necessary
 * and approved") — accountId + document/version + timestamp + mechanism is sufficient evidence
 * of what was accepted, when, and how.
 */
export interface AcceptanceRecord {
  accountId: string;
  documentId: LegalDocumentId;
  version: string;
  acceptedAt: string;
  mechanism: AcceptanceMechanism;
}

export function buildAcceptanceRecord(input: {
  accountId: string;
  documentId: LegalDocumentId;
  version: string;
  mechanism: AcceptanceMechanism;
  now?: Date;
}): AcceptanceRecord {
  return {
    accountId: input.accountId,
    documentId: input.documentId,
    version: input.version,
    acceptedAt: (input.now ?? new Date()).toISOString(),
    mechanism: input.mechanism,
  };
}

/**
 * True when the account's most recent acceptance for this document does not match the
 * currently-active version (including the case of no acceptance at all).
 */
export function needsReacceptance(
  latestAcceptance: AcceptanceRecord | null,
  activeVersion: LegalDocumentVersion | null,
): boolean {
  if (!activeVersion) return false;
  if (!latestAcceptance) return true;
  return latestAcceptance.version !== activeVersion.version;
}
