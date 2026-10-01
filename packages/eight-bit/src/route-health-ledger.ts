import crypto from "node:crypto";
import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import type { EightBitRouteHealthAuthority, NormalizedObservation, RouteHealthSnapshot } from "./route-health-authority.js";

/**
 * Durable ledger for the route-health authority. Uses the SAME `ISessionPersistence` surface
 * (work_items) that 8-Bit receipts and per-session route health already use — no second health
 * database (§5). Two kinds:
 *
 *   eight_bit_route_observation      append-only, host-scoped: the normalized learning data (§55)
 *   eight_bit_route_health_authority upsert per route, host-scoped: the temporal snapshot that a
 *                                    restart or another session hydrates from (§7, §8)
 *
 * Writes are best-effort and failure-isolated: a persistence error never blocks routing.
 */
export class EightBitRouteHealthLedger {
  private unsubscribe?: () => void;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: ISessionPersistence,
    private readonly options: { sessionId?: string; persistObservations?: boolean } = {},
  ) {}

  /** Attach to an authority: every observation is appended and every snapshot upserted. */
  attach(authority: EightBitRouteHealthAuthority): () => void {
    this.unsubscribe?.();
    this.unsubscribe = authority.subscribe((observation, snapshot) => {
      this.pending = this.pending
        .then(() => this.record(observation, snapshot))
        .catch(() => undefined);
    });
    return () => this.detach();
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Awaits every queued write (tests / shutdown). */
  async flush(): Promise<void> {
    await this.pending;
  }

  async record(observation: NormalizedObservation, snapshot: RouteHealthSnapshot): Promise<void> {
    const now = new Date().toISOString();
    if (this.options.persistObservations !== false) {
      const item: WorkItem = {
        kind: "eight_bit_route_observation",
        id: `eight-bit-obs-${crypto.randomUUID()}`,
        sessionId: this.options.sessionId,
        providerId: observation.providerId,
        modelId: observation.modelId,
        observation: observation as unknown as Record<string, unknown>,
        createdAt: now,
      };
      await this.persistence.insertIfAbsent(item);
    }
    await this.saveSnapshot(snapshot);
  }

  async saveSnapshot(snapshot: RouteHealthSnapshot): Promise<void> {
    const item: WorkItem = {
      kind: "eight_bit_route_health_authority",
      id: routeHealthAuthorityId(snapshot.providerId, snapshot.modelId, snapshot.quotaDomainId),
      sessionId: this.options.sessionId,
      providerId: snapshot.providerId,
      modelId: snapshot.modelId,
      snapshot: snapshot as unknown as Record<string, unknown>,
      updatedAt: new Date().toISOString(),
    };
    await this.persistence.upsertWorkItem(item);
  }

  async loadSnapshots(): Promise<RouteHealthSnapshot[]> {
    const items = await this.persistence.getWorkItemsByKind("eight_bit_route_health_authority");
    return items
      .filter((i): i is Extract<WorkItem, { kind: "eight_bit_route_health_authority" }> => i.kind === "eight_bit_route_health_authority")
      .map((i) => i.snapshot as unknown as RouteHealthSnapshot);
  }

  async loadObservations(filter: { providerId?: string; modelId?: string; since?: string } = {}): Promise<NormalizedObservation[]> {
    const items = await this.persistence.getWorkItemsByKind("eight_bit_route_observation");
    return items
      .filter((i): i is Extract<WorkItem, { kind: "eight_bit_route_observation" }> => i.kind === "eight_bit_route_observation")
      .filter((i) => (filter.providerId === undefined || i.providerId === filter.providerId) && (filter.modelId === undefined || i.modelId === filter.modelId) && (filter.since === undefined || i.createdAt >= filter.since))
      .map((i) => i.observation as unknown as NormalizedObservation)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  }

  /** Hydrate an authority from the durable snapshots (expired transient conditions are dropped by the authority). */
  async hydrate(authority: EightBitRouteHealthAuthority): Promise<number> {
    const snapshots = await this.loadSnapshots();
    for (const snapshot of snapshots) authority.hydrate(snapshot);
    return snapshots.length;
  }
}

export function routeHealthAuthorityId(providerId: string, modelId: string, quotaDomainId?: string): string {
  return `eight-bit-route-health-authority-${providerId}-${modelId}${quotaDomainId === undefined ? "" : `-domain-${crypto.createHash("sha256").update(quotaDomainId).digest("hex")}`}`;
}

export function createEightBitRouteHealthLedger(persistence: ISessionPersistence, options?: { sessionId?: string; persistObservations?: boolean }): EightBitRouteHealthLedger {
  return new EightBitRouteHealthLedger(persistence, options);
}
