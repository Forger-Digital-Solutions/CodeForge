import { randomUUID } from "node:crypto";
import type { ICloudDatabase } from "@codeforge/cloud-db";
import type { ISessionPersistence } from "@codeforge/sessions";
import { DEFAULT_RETENTION_POLICY, classesPurgedOnErasure, classesRetainedOnErasure } from "@codeforge/legal-policy";
import type { HostedWorkflowAuthority } from "./hosted-workflow-authority.js";

/**
 * Confirms deletion completed without retaining an inventory of the deleted account's content
 * (R1 legal remediation spec §85) — only categories and counts, never row-level data.
 */
export interface AccountDeletionReceipt {
  deletionRequestId: string;
  userId: string;
  completedAt: string;
  categoriesProcessed: string[];
  retainedCategories: string[];
  retentionReasonCodes: Record<string, string>;
  sessionsDeleted: number;
}

/**
 * GDPR Article 17 erasure, coordinated across the two physically separate schemas a CodeForge
 * Cloud account's data can live in (LEG-P0-02):
 *
 *  1. @codeforge/sessions (hosted workflow sessions, turns/messages, work items, events) — a
 *     separate migration ledger from @codeforge/cloud-db (see PostgresCloudDatabase's
 *     MIGRATIONS_TABLE comment), even when both point at the same physical Postgres cluster, so it
 *     cannot share the single SQL transaction deleteUserAccount() uses below.
 *  2. @codeforge/cloud-db (identity, billing, entitlements, GitHub App installations,
 *     publications, ...) — one real transaction, see ICloudDatabase.deleteUserAccount().
 *
 * Session data is purged FIRST: if that step fails, the account — and the ability to retry
 * deletion — still exists untouched. If it succeeds but step 2 then fails, retrying the whole
 * call is safe: deleteSession/deleteEventsForSession are no-ops against an already-deleted
 * session, and deleteUserAccount() is independently idempotent (R1 spec §31).
 */
export async function deleteAccount(params: {
  db: ICloudDatabase;
  sessionPersistence: ISessionPersistence;
  hostedWorkflowAuthority: HostedWorkflowAuthority;
  userId: string;
  now?: Date;
}): Promise<AccountDeletionReceipt> {
  const { db, sessionPersistence, hostedWorkflowAuthority, userId } = params;

  const ownedWorkflows = await hostedWorkflowAuthority.list(userId);
  for (const workflow of ownedWorkflows) {
    await sessionPersistence.withTransaction(async (tx) => {
      await tx.deleteEventsForSession(workflow.sessionId);
      await tx.deleteSession(workflow.sessionId);
    });
  }

  await db.deleteUserAccount(userId);

  const retentionReasonCodes: Record<string, string> = {};
  for (const entry of Object.values(DEFAULT_RETENTION_POLICY)) {
    if (!entry.deleteOnAccountErasure) retentionReasonCodes[entry.class] = entry.status;
  }

  return {
    deletionRequestId: `del-${randomUUID()}`,
    userId,
    completedAt: (params.now ?? new Date()).toISOString(),
    categoriesProcessed: [...classesPurgedOnErasure(), "SESSION_CONTENT"],
    retainedCategories: classesRetainedOnErasure(),
    retentionReasonCodes,
    sessionsDeleted: ownedWorkflows.length,
  };
}
