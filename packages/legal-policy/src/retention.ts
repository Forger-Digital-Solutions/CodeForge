export type RetentionClass =
  | "USER_CONTENT"
  | "AUTH_DATA"
  | "OPERATIONAL_DATA"
  | "SECURITY_AUDIT"
  | "BILLING_RECORD"
  | "LEGAL_HOLD";

export type RetentionPeriodStatus = "BUSINESS_DECISION_REQUIRED" | "CONFIGURED";

export interface RetentionPolicyEntry {
  class: RetentionClass;
  status: RetentionPeriodStatus;
  /** Days to retain after account deletion before hard-purge; null means "no fixed period is
   *  approved yet" (do not read null as "forever" or "0" — see deleteOnAccountErasure). */
  retentionDays: number | null;
  /** Whether account deletion purges this class immediately as part of the deletion transaction,
   *  independent of retentionDays (which only applies to categories NOT purged on erasure). */
  deleteOnAccountErasure: boolean;
  rationale: string;
}

// R1 remediation spec §27 is explicit: Pass-3's "device tokens 30 days" / "billing records 7
// years" are NOT authoritative business policy. Build the mechanism; do not invent the numbers.
export const DEFAULT_RETENTION_POLICY: Record<RetentionClass, RetentionPolicyEntry> = {
  USER_CONTENT: {
    class: "USER_CONTENT",
    status: "CONFIGURED",
    retentionDays: 0,
    deleteOnAccountErasure: true,
    rationale: "Sessions, messages, continuations, and work items are user content with no independent retention justification; purged as part of account deletion.",
  },
  AUTH_DATA: {
    class: "AUTH_DATA",
    status: "CONFIGURED",
    retentionDays: 0,
    deleteOnAccountErasure: true,
    rationale: "OAuth identities, device/session tokens, and credentials are purged and revoked as part of account deletion.",
  },
  OPERATIONAL_DATA: {
    class: "OPERATIONAL_DATA",
    status: "CONFIGURED",
    retentionDays: 0,
    deleteOnAccountErasure: true,
    rationale: "Routing/receipt records that identify the account are purged as part of account deletion; aggregate/anonymized operational metrics are out of scope for this classification.",
  },
  SECURITY_AUDIT: {
    class: "SECURITY_AUDIT",
    status: "BUSINESS_DECISION_REQUIRED",
    retentionDays: null,
    deleteOnAccountErasure: false,
    rationale: "Pass-3 identified a possible need to retain a minimal security/abuse-prevention audit trail after account erasure. Exact duration is undecided; do not default to a specific number (R1 spec §27).",
  },
  BILLING_RECORD: {
    class: "BILLING_RECORD",
    status: "BUSINESS_DECISION_REQUIRED",
    retentionDays: null,
    deleteOnAccountErasure: false,
    rationale: "Pass-3 draft mentioned 7 years but this is not an approved tax/accounting decision (R1 spec §27). Stripe remains in test mode with zero live billing records today.",
  },
  LEGAL_HOLD: {
    class: "LEGAL_HOLD",
    status: "CONFIGURED",
    retentionDays: null,
    deleteOnAccountErasure: false,
    rationale: "Indefinite by nature; applies only when a specific record is explicitly flagged for a legal hold, never as a default state for ordinary accounts.",
  },
};

export function classesPurgedOnErasure(
  policy: Record<RetentionClass, RetentionPolicyEntry> = DEFAULT_RETENTION_POLICY,
): RetentionClass[] {
  return Object.values(policy)
    .filter((entry) => entry.deleteOnAccountErasure)
    .map((entry) => entry.class);
}

export function classesRetainedOnErasure(
  policy: Record<RetentionClass, RetentionPolicyEntry> = DEFAULT_RETENTION_POLICY,
): RetentionClass[] {
  return Object.values(policy)
    .filter((entry) => !entry.deleteOnAccountErasure)
    .map((entry) => entry.class);
}
