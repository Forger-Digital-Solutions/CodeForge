import crypto from "node:crypto";
import type { SessionPersistence, WorkItem } from "@codeforge/sessions";
import type { ChangeDelivery } from "./delivery-state.js";
import {
  CloudPublicationClient,
  CloudPublicationError,
  CLOUD_PUBLICATION_ERRORS,
  TERMINAL_CLOUD_PUBLICATION_STATES,
  type CloudPublicationView,
} from "./cloud-publication-client.js";

export type CloudPublicationStatus =
  | "identity_required"
  | "authorization_required"
  | "authorization_pending"
  | "preparing"
  | CloudPublicationView["state"];

export interface CloudPublicationRecord {
  kind: "cloud_publication";
  id: string;
  sessionId: string;
  deliveryId: string;
  workspaceId: string;
  status: CloudPublicationStatus;
  cloudPublicationId?: string;
  publicationJson?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudPublicationBridgeOptions {
  persistence?: SessionPersistence;
  getDelivery: (id: string) => ChangeDelivery | undefined;
  /** Undefined when Cloud publication is not configured for this desktop install. */
  client?: CloudPublicationClient;
}

const ERROR_TO_STATUS: Record<string, CloudPublicationStatus> = {
  [CLOUD_PUBLICATION_ERRORS.CLOUD_IDENTITY_REQUIRED]: "identity_required",
  [CLOUD_PUBLICATION_ERRORS.REPOSITORY_AUTHORIZATION_REQUIRED]: "authorization_required",
  REPOSITORY_NOT_AUTHORIZED: "authorization_required",
  INSTALLATION_REVOKED: "authorization_revoked",
  PROMOTION_TARGET_DIVERGED: "target_diverged",
};

/**
 * The desktop side of CF-11B.
 *
 * It owns no remote authority: it packages the certified delivery, hands it to Cloud, and mirrors
 * whatever Cloud reports. Every terminal status stored here originates from a Cloud response.
 */
export class CloudPublicationBridge {
  constructor(private readonly options: CloudPublicationBridgeOptions) {}

  get configured(): boolean {
    return Boolean(this.options.client);
  }

  get(deliveryId: string): CloudPublicationRecord | undefined {
    const items = this.options.persistence?.getWorkItemsByKind("cloud_publication") ?? [];
    for (const item of items) {
      const record = this.parse(item);
      if (record?.deliveryId === deliveryId) return record;
    }
    return undefined;
  }

  list(deliveryId?: string): CloudPublicationRecord[] {
    return (this.options.persistence?.getWorkItemsByKind("cloud_publication") ?? [])
      .map((item) => this.parse(item))
      .filter((item): item is CloudPublicationRecord => Boolean(item) && (!deliveryId || item!.deliveryId === deliveryId));
  }

  /** Reports whether Cloud currently authorizes this delivery's repository. No credential returned. */
  async describeAuthorization(deliveryId: string): Promise<{ authorized: boolean; fullName?: string; repositoryId?: number; reason?: string }> {
    if (!this.options.client) return { authorized: false, reason: CLOUD_PUBLICATION_ERRORS.CLOUD_NOT_CONFIGURED };
    try {
      const authorization = await this.options.client.resolveRepositoryAuthorization(deliveryId);
      return { authorized: true, fullName: authorization.fullName, repositoryId: authorization.repositoryId };
    } catch (error) {
      return { authorized: false, reason: error instanceof CloudPublicationError ? String(error.code) : "CLOUD_REQUEST_FAILED" };
    }
  }

  async publish(deliveryId: string): Promise<CloudPublicationRecord> {
    const delivery = this.requireDelivery(deliveryId);
    if (!this.options.client) {
      return this.save(this.seed(delivery, "authorization_required", CLOUD_PUBLICATION_ERRORS.CLOUD_NOT_CONFIGURED));
    }
    const existing = this.get(deliveryId);
    if (existing?.status === "completed") return existing;

    const record = existing ?? this.seed(delivery, "preparing");
    record.status = "preparing";
    record.error = undefined;
    this.save(record);

    try {
      const view = await this.options.client.publishDelivery(deliveryId);
      return this.applyView(record, view);
    } catch (error) {
      return this.applyError(record, error);
    }
  }

  async refresh(deliveryId: string): Promise<CloudPublicationRecord | undefined> {
    const record = this.get(deliveryId);
    if (!record?.cloudPublicationId || !this.options.client) return record;
    if (TERMINAL_CLOUD_PUBLICATION_STATES.includes(record.status as CloudPublicationView["state"])) return record;
    try {
      return this.applyView(record, await this.options.client.getStatus(record.cloudPublicationId));
    } catch (error) {
      return this.applyError(record, error);
    }
  }

  async retry(deliveryId: string): Promise<CloudPublicationRecord> {
    const record = this.get(deliveryId);
    if (!record) throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
    if (!this.options.client) return this.applyError(record, new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.CLOUD_NOT_CONFIGURED));
    if (TERMINAL_CLOUD_PUBLICATION_STATES.includes(record.status as CloudPublicationView["state"])) return record;
    if (!record.cloudPublicationId) return this.publish(deliveryId);
    try {
      return this.applyView(record, await this.options.client.retry(record.cloudPublicationId));
    } catch (error) {
      return this.applyError(record, error);
    }
  }

  private applyView(record: CloudPublicationRecord, view: CloudPublicationView): CloudPublicationRecord {
    record.cloudPublicationId = view.id;
    record.status = view.state;
    record.publicationJson = JSON.stringify(view);
    record.error = view.errorCode;
    return this.save(record);
  }

  private applyError(record: CloudPublicationRecord, error: unknown): CloudPublicationRecord {
    const code = error instanceof CloudPublicationError ? String(error.code) : "CLOUD_REQUEST_FAILED";
    record.status = ERROR_TO_STATUS[code] ?? "failed_retryable";
    record.error = code;
    return this.save(record);
  }

  private seed(delivery: ChangeDelivery, status: CloudPublicationStatus, error?: string): CloudPublicationRecord {
    const now = new Date().toISOString();
    return {
      kind: "cloud_publication",
      id: `cloud-publication-${crypto.randomUUID()}`,
      sessionId: delivery.sessionId,
      deliveryId: delivery.id,
      workspaceId: delivery.workspaceId,
      status,
      ...(error ? { error } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  private save(record: CloudPublicationRecord): CloudPublicationRecord {
    record.updatedAt = new Date().toISOString();
    this.options.persistence?.upsertWorkItem(record as unknown as WorkItem);
    return record;
  }

  private parse(item: WorkItem): CloudPublicationRecord | undefined {
    const candidate = item as WorkItem & Record<string, unknown>;
    if (candidate.kind !== "cloud_publication") return undefined;
    return candidate as unknown as CloudPublicationRecord;
  }

  private requireDelivery(deliveryId: string): ChangeDelivery {
    const delivery = this.options.getDelivery(deliveryId);
    if (!delivery || delivery.status !== "ready") throw new CloudPublicationError(CLOUD_PUBLICATION_ERRORS.DELIVERY_NOT_LOCAL_READY);
    return delivery;
  }
}

export function createCloudPublicationBridge(options: CloudPublicationBridgeOptions): CloudPublicationBridge {
  return new CloudPublicationBridge(options);
}
