import { createHmac, timingSafeEqual } from "node:crypto";
import type { ICloudDatabase } from "@codeforge/cloud-db";
import type { GitHubAppAuthorizationService } from "./github-app-authorization.js";

/**
 * GitHub App webhook ingestion (R22 M7).
 *
 * Trust chain: the shared webhook secret is the ONLY authenticity signal — every delivery is
 * HMAC-SHA256-verified over the raw body before parsing, and the X-GitHub-Delivery GUID is
 * claimed atomically before any state mutation so a retried or replayed delivery can never
 * apply a revocation twice. Payloads are untrusted input: only the fields needed for access
 * invalidation are read, repository content inside payloads is never executed or persisted,
 * and a syntactically valid signature on a semantically bogus body degrades to `ignored`.
 */

export const GITHUB_WEBHOOK_ERRORS = {
  SIGNATURE_MISSING: "GITHUB_WEBHOOK_SIGNATURE_MISSING",
  SIGNATURE_INVALID: "GITHUB_WEBHOOK_SIGNATURE_INVALID",
  DELIVERY_MISSING: "GITHUB_WEBHOOK_DELIVERY_MISSING",
  PAYLOAD_INVALID: "GITHUB_WEBHOOK_PAYLOAD_INVALID",
  PAYLOAD_TOO_LARGE: "GITHUB_WEBHOOK_PAYLOAD_TOO_LARGE",
} as const;

export type GitHubWebhookErrorCode = (typeof GITHUB_WEBHOOK_ERRORS)[keyof typeof GITHUB_WEBHOOK_ERRORS];

export class GitHubWebhookError extends Error {
  constructor(readonly code: GitHubWebhookErrorCode, message: string) {
    super(message);
    this.name = "GitHubWebhookError";
  }
}

/** Payload cap: a webhook body is metadata; anything larger is either abuse or a bug upstream. */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

/** HMAC-SHA256 over the raw body, `sha256=` prefixed hex, timing-safe compare. */
export function verifyGitHubWebhookSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const presented = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(presented)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(presented.toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type GitHubWebhookAction =
  | "processed"
  | "duplicate_skipped"
  | "ignored"
  | "installation_revoked"
  | "installation_suspended"
  | "installation_resynced"
  | "repositories_removed";

export interface GitHubWebhookResult {
  action: GitHubWebhookAction;
  event: string;
  deliveryId: string;
  detail?: string;
}

interface WebhookPayloadShape {
  action?: string;
  installation?: { id?: number };
  repositories_added?: Array<{ id?: number }>;
  repositories_removed?: Array<{ id?: number }>;
  repository?: { id?: number };
}

export class GitHubWebhookService {
  private readonly db: ICloudDatabase;
  private readonly secret: string;
  private readonly authorization: GitHubAppAuthorizationService;

  constructor(config: { db: ICloudDatabase; webhookSecret: string; authorization: GitHubAppAuthorizationService }) {
    this.db = config.db;
    this.secret = config.webhookSecret;
    this.authorization = config.authorization;
  }

  /**
   * Full ingestion path: verify → dedup-claim → dispatch → complete. Any thrown
   * GitHubWebhookError maps to a 4xx; unknown throws leave the delivery `failed`.
   */
  async handleDelivery(params: {
    signatureHeader?: string;
    deliveryId?: string;
    event?: string;
    rawBody: Buffer | string;
  }): Promise<GitHubWebhookResult> {
    const rawBody = typeof params.rawBody === "string" ? Buffer.from(params.rawBody, "utf8") : params.rawBody;
    if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
      throw new GitHubWebhookError(GITHUB_WEBHOOK_ERRORS.PAYLOAD_TOO_LARGE, "webhook body exceeds 1 MiB");
    }
    if (!params.deliveryId || params.deliveryId.length > 255) {
      throw new GitHubWebhookError(GITHUB_WEBHOOK_ERRORS.DELIVERY_MISSING, "X-GitHub-Delivery header missing or malformed");
    }
    if (!verifyGitHubWebhookSignature(this.secret, rawBody, params.signatureHeader)) {
      throw new GitHubWebhookError(
        params.signatureHeader ? GITHUB_WEBHOOK_ERRORS.SIGNATURE_INVALID : GITHUB_WEBHOOK_ERRORS.SIGNATURE_MISSING,
        "X-Hub-Signature-256 verification failed",
      );
    }

    let payload: WebhookPayloadShape;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as WebhookPayloadShape;
    } catch {
      throw new GitHubWebhookError(GITHUB_WEBHOOK_ERRORS.PAYLOAD_INVALID, "webhook body is not valid JSON");
    }
    const event = params.event ?? "";
    const action = typeof payload.action === "string" ? payload.action : undefined;
    const installationId = typeof payload.installation?.id === "number" ? payload.installation.id : undefined;

    const claim = await this.db.claimGitHubWebhookDelivery({
      deliveryId: params.deliveryId,
      event,
      ...(action ? { action } : {}),
      ...(installationId !== undefined ? { installationId } : {}),
    });
    if (!claim.claimed) {
      return { action: "duplicate_skipped", event, deliveryId: params.deliveryId };
    }

    try {
      const result = await this.dispatch(event, action, payload, installationId);
      await this.db.completeGitHubWebhookDelivery(params.deliveryId, result.action === "ignored" ? "ignored" : "processed");
      return { ...result, event, deliveryId: params.deliveryId };
    } catch (error) {
      await this.db.completeGitHubWebhookDelivery(params.deliveryId, "failed").catch(() => undefined);
      throw error;
    }
  }

  private async dispatch(
    event: string,
    action: string | undefined,
    payload: WebhookPayloadShape,
    installationId: number | undefined,
  ): Promise<{ action: GitHubWebhookAction; detail?: string }> {
    switch (`${event}:${action ?? ""}`) {
      case "ping:":
        return { action: "ignored", detail: "ping" };

      case "installation:deleted": {
        const installation = await this.installationByGitHubId(installationId);
        if (!installation) return { action: "ignored", detail: "unknown installation" };
        await this.authorization.revokeInstallation(installation.id);
        return { action: "installation_revoked", detail: `installation ${installationId} deleted` };
      }

      case "installation:suspend": {
        const installation = await this.installationByGitHubId(installationId);
        if (!installation) return { action: "ignored", detail: "unknown installation" };
        // Suspension denies every grant through the status check without destroying them —
        // a later unsuspend resync restores exactly what GitHub still reports.
        await this.db.updateGitHubInstallationStatus(installation.id, "suspended");
        return { action: "installation_suspended", detail: `installation ${installationId} suspended` };
      }

      case "installation:unsuspend": {
        const installation = await this.installationByGitHubId(installationId);
        if (!installation) return { action: "ignored", detail: "unknown installation" };
        await this.db.updateGitHubInstallationStatus(installation.id, "active");
        await this.authorization.refreshInstallation(installation.id);
        return { action: "installation_resynced", detail: `installation ${installationId} unsuspended` };
      }

      case "installation_repositories:removed": {
        const installation = await this.installationByGitHubId(installationId);
        if (!installation) return { action: "ignored", detail: "unknown installation" };
        const removed = (payload.repositories_removed ?? [])
          .map((r) => r.id)
          .filter((id): id is number => typeof id === "number");
        for (const repositoryId of removed) {
          const grant = await this.db.getGitHubRepositoryAuthorization(repositoryId);
          if (grant && grant.installationId === installation.id && grant.authorizationState === "authorized") {
            await this.db.updateGitHubRepositoryAuthorizationState(grant.id, "deleted");
          }
        }
        return { action: "repositories_removed", detail: `${removed.length} repositories detached` };
      }

      case "installation_repositories:added":
      case "installation:new_permissions_accepted": {
        const installation = await this.installationByGitHubId(installationId);
        if (!installation) return { action: "ignored", detail: "unknown installation" };
        await this.authorization.refreshInstallation(installation.id);
        return { action: "installation_resynced", detail: `installation ${installationId} re-synced` };
      }

      case "repository:renamed":
      case "repository:transferred":
      case "repository:deleted":
      case "repository:privatized":
      case "repository:publicized": {
        // Repo-level changes reconcile through GitHub's own view — never trust the payload's
        // description of the repository, only its identity.
        const installation = await this.installationByGitHubId(installationId);
        if (!installation) return { action: "ignored", detail: "unknown installation" };
        await this.authorization.refreshInstallation(installation.id);
        return { action: "installation_resynced", detail: `repository ${action} reconciled` };
      }

      default:
        return { action: "ignored", detail: `unhandled event ${event}${action ? `:${action}` : ""}` };
    }
  }

  private async installationByGitHubId(installationId: number | undefined) {
    if (installationId === undefined) return undefined;
    return this.db.getGitHubInstallationByInstallationId(installationId);
  }
}

export function createGitHubWebhookService(config: { db: ICloudDatabase; webhookSecret: string; authorization: GitHubAppAuthorizationService }): GitHubWebhookService {
  return new GitHubWebhookService(config);
}
