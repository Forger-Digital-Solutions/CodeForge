import crypto from "node:crypto";
import type { SessionPersistence, WorkItem } from "@codeforge/sessions";
import type { RemoteRepositoryIdentity, RemotePullRequest } from "./github-pr-client.js";

export const PUBLICATION_ERRORS = {
  REMOTE_NOT_CONFIGURED: "REMOTE_NOT_CONFIGURED", REMOTE_UNSUPPORTED: "REMOTE_UNSUPPORTED", REMOTE_AUTH_FAILED: "REMOTE_AUTH_FAILED",
  REMOTE_TARGET_DIVERGED: "REMOTE_TARGET_DIVERGED", REMOTE_BRANCH_DIVERGED: "REMOTE_BRANCH_DIVERGED", REMOTE_PUSH_FAILED: "REMOTE_PUSH_FAILED",
  REMOTE_RATE_LIMITED: "REMOTE_RATE_LIMITED", REMOTE_PROVIDER_UNAVAILABLE: "REMOTE_PROVIDER_UNAVAILABLE", REMOTE_PR_CREATE_FAILED: "REMOTE_PR_CREATE_FAILED",
  REMOTE_PR_CONFLICT: "REMOTE_PR_CONFLICT", PUBLICATION_CANCELLED: "PUBLICATION_CANCELLED", PUBLICATION_LEASE_CONFLICT: "PUBLICATION_LEASE_CONFLICT",
  PUBLICATION_AUTHORIZATION_STALE: "PUBLICATION_AUTHORIZATION_STALE", DELIVERY_NOT_LOCAL_READY: "DELIVERY_NOT_LOCAL_READY",
} as const;
export type PublicationErrorCode = (typeof PUBLICATION_ERRORS)[keyof typeof PUBLICATION_ERRORS];
export type PublicationStatus = "local_ready" | "remote_authorized" | "validating_remote" | "publishing_branch" | "creating_pr" | "remote_pr_ready" | "blocked" | "failed" | "cancelled" | "remote_diverged" | "authorization_required";

export interface PublicationAuthorization { actorId: string; nonce: string; authorizedAt: string; binding: string; }
export interface RemotePublicationReceipt { publicationId: string; deliveryId: string; repository: string; targetBranch: string; capturedTargetSha: string; remoteBranch: string; publishedSha: string; publishedTree: string; verificationReceipt: string; reviewReceipt: string; secretGateReceipt: string; prProvider: "github"; prNumber: number; prUrl: string; createdAt: string; terminalState: "remote_pr_ready"; }
export interface RemotePublication {
  kind: "remote_publication"; id: string; deliveryId: string; missionId: string; sessionId: string; workspaceId: string;
  status: PublicationStatus; remoteName: string; remoteUrl?: string; repository?: RemoteRepositoryIdentity; targetBranch: string; capturedTargetSha?: string;
  localDeliveryBranch: string; localDeliveryHead: string; localDeliveryTree: string; remoteBranch: string; expectedRemoteSha: string;
  authorization?: PublicationAuthorization; pushCompletedAt?: string; pr?: RemotePullRequest; error?: PublicationErrorCode; leaseId?: string; createdAt: string; updatedAt: string; receipt?: RemotePublicationReceipt;
}

export function publicationBinding(deliveryId: string, head: string, tree: string, target: string): string { return crypto.createHash("sha256").update(JSON.stringify({ deliveryId, head, tree, target })).digest("hex"); }
export function remoteBranchFor(publicationId: string, deliveryId: string): string { const safe = deliveryId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "delivery"; return `codeforge/delivery/${safe}-${publicationId.replace(/[^A-Za-z0-9]/g, "").slice(-12)}`; }

export class RemotePublicationStore {
  constructor(private readonly persistence?: SessionPersistence) {}
  save(value: RemotePublication): void { this.persistence?.upsertWorkItem({ kind: "remote_publication", id: value.id, sessionId: value.sessionId, deliveryId: value.deliveryId, workspaceId: value.workspaceId, status: value.status, publicationJson: JSON.stringify(value), ...(value.error ? { error: value.error } : {}), createdAt: value.createdAt, updatedAt: value.updatedAt } as unknown as WorkItem); }
  get(id: string): RemotePublication | undefined { const item = this.persistence?.getWorkItem(id) as (WorkItem & Record<string, unknown>) | undefined; if (!item || item.kind !== "remote_publication" || typeof item.publicationJson !== "string") return undefined; return JSON.parse(item.publicationJson) as RemotePublication; }
  findByDelivery(deliveryId: string): RemotePublication | undefined { return (this.persistence?.getWorkItemsByKind("remote_publication") ?? []).map((item) => this.get(item.id)).find((item) => item?.deliveryId === deliveryId); }
  list(deliveryId?: string): RemotePublication[] { return (this.persistence?.getWorkItemsByKind("remote_publication") ?? []).map((item) => this.get(item.id)).filter((item): item is RemotePublication => Boolean(item) && (!deliveryId || item!.deliveryId === deliveryId)); }
}
