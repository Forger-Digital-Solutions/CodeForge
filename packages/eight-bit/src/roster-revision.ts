import crypto from "node:crypto";
import type { ISessionPersistence } from "@codeforge/sessions";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import type { EightBitRole } from "./types.js";
import type { ModelQualificationReceipt } from "./qualification/types.js";

/**
 * 8-Bit Roster Revision & Churn Management (R1 spec §25–§28, §38, §63–§64).
 *
 * Durable ledger of every roster state change. Each revision records:
 * - incremental revisionNumber
 * - active roster of policy-approved, qualified free models
 * - atomic change records with machine-readable reason codes
 * - SHA-256 integrity hash
 *
 * Authority hierarchy:
 * 1. Policy Authority ALWAYS wins (§28): a healthy or benchmark-winning model denied by policy
 *    is blocked immediately.
 * 2. Qualification is mandatory (§27): discovery creates candidates, never qualified entries.
 * 3. Health & Quota drive automatic demotion/degradation.
 */

export type RosterChangeAction =
  | "CANDIDATE_DISCOVERED"
  | "QUALIFIED"
  | "PROMOTED"
  | "DEMOTED"
  | "RETIRED"
  | "POLICY_EXPIRED"
  | "POLICY_DENIED"
  | "HEALTH_DEGRADED"
  | "HEALTH_RESTORED"
  | "QUOTA_EXHAUSTED";

export interface RosterChange {
  providerId: string;
  modelId: string;
  action: RosterChangeAction;
  roles?: EightBitRole[];
  previousRoles?: EightBitRole[];
  reasonCodes: string[];
  timestamp: string;
}

export interface RosterEntry {
  providerId: string;
  modelId: string;
  displayName: string;
  assignedRoles: EightBitRole[];
  roleScores: Partial<Record<EightBitRole, number>>;
  qualificationStatus: "QUALIFIED" | "PROBATION" | "NOT_QUALIFIED";
  policyStatus: "ALLOWED" | "DENIED" | "EXPIRED";
  healthStatus: string;
}

export interface RosterRevision {
  revisionNumber: number;
  timestamp: string;
  activeRoster: RosterEntry[];
  changes: RosterChange[];
  hash: string;
}

export const ROSTER_REVISION_NAMESPACE = "__eight_bit_roster__";

function revId(revisionNumber: number): string {
  return `eight-bit-roster-rev-${revisionNumber}`;
}

export class RosterRevisionStore {
  constructor(private readonly persistence: ISessionPersistence) {}

  async saveRevision(revision: RosterRevision): Promise<void> {
    await this.persistence.upsertWorkItem({
      kind: "eight_bit_roster_revision",
      id: revId(revision.revisionNumber),
      revision: revision as unknown as Record<string, unknown>,
      createdAt: revision.timestamp,
    });
  }

  async getRevision(revisionNumber: number): Promise<RosterRevision | undefined> {
    const item = await this.persistence.getWorkItem(revId(revisionNumber));
    if (!item || item.kind !== "eight_bit_roster_revision") return undefined;
    return item.revision as unknown as RosterRevision;
  }

  async listRevisions(): Promise<RosterRevision[]> {
    const items = await this.persistence.getWorkItemsByKind("eight_bit_roster_revision");
    const revisions: RosterRevision[] = [];
    for (const item of items) {
      if (item.kind !== "eight_bit_roster_revision") continue;
      revisions.push(item.revision as unknown as RosterRevision);
    }
    return revisions.sort((a, b) => a.revisionNumber - b.revisionNumber);
  }

  async getLatestRevision(): Promise<RosterRevision | undefined> {
    const all = await this.listRevisions();
    return all[all.length - 1];
  }
}

export class RosterChurnManager {
  private currentRevision: RosterRevision;
  private candidates = new Map<string, FreeModelRecord>();

  constructor(
    private readonly store?: RosterRevisionStore,
    initialRevision?: RosterRevision,
  ) {
    if (initialRevision) {
      this.currentRevision = initialRevision;
    } else {
      const now = new Date().toISOString();
      this.currentRevision = {
        revisionNumber: 1,
        timestamp: now,
        activeRoster: [],
        changes: [{
          providerId: "system",
          modelId: "initial",
          action: "PROMOTED",
          reasonCodes: ["initial_empty_roster"],
          timestamp: now,
        }],
        hash: this.computeHash(1, now, []),
      };
    }
  }

  private routeKey(providerId: string, modelId: string): string {
    return `${providerId}::${modelId}`;
  }

  private computeHash(revisionNumber: number, timestamp: string, entries: RosterEntry[]): string {
    const data = JSON.stringify({ revisionNumber, timestamp, entries: entries.map(e => `${e.providerId}:${e.modelId}`) });
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  async init(): Promise<void> {
    if (this.store) {
      const latest = await this.store.getLatestRevision();
      if (latest) {
        this.currentRevision = latest;
      } else {
        await this.store.saveRevision(this.currentRevision);
      }
    }
  }

  getCurrentRevision(): RosterRevision {
    return this.currentRevision;
  }

  getActiveRoster(): RosterEntry[] {
    return [...this.currentRevision.activeRoster];
  }

  /** Discovery creates candidate only — NEVER direct qualification (§27). */
  registerCandidate(candidate: FreeModelRecord): { candidate: boolean; routeKey: string } {
    const key = this.routeKey(candidate.providerId, candidate.modelId);
    this.candidates.set(key, candidate);
    return { candidate: true, routeKey: key };
  }

  getCandidate(providerId: string, modelId: string): FreeModelRecord | undefined {
    return this.candidates.get(this.routeKey(providerId, modelId));
  }

  /**
   * Promotes a qualified model to active roster IF policy approves (§28).
   * Policy denial ALWAYS overrides benchmark score or health!
   */
  async promoteModel(
    model: FreeModelRecord,
    receipt: ModelQualificationReceipt,
    policyCheck: { allowed: boolean; reason?: string },
    assignedRoles: EightBitRole[] = ["CODER"],
  ): Promise<{ success: boolean; newRevision?: RosterRevision; error?: string }> {
    const now = new Date().toISOString();
    const key = this.routeKey(model.providerId, model.modelId);

    // Hard policy gate (§28)
    if (!policyCheck.allowed) {
      const change: RosterChange = {
        providerId: model.providerId,
        modelId: model.modelId,
        action: "POLICY_DENIED",
        reasonCodes: [policyCheck.reason ?? "policy_gate_denial"],
        timestamp: now,
      };
      await this.commitRevision([change], this.currentRevision.activeRoster.filter(e => !(e.providerId === model.providerId && e.modelId === model.modelId)));
      return { success: false, error: `POLICY_DENIED: ${policyCheck.reason}` };
    }

    if (receipt.qualificationState !== "QUALIFIED" && receipt.qualificationState !== "PROBATION") {
      return { success: false, error: `NOT_QUALIFIED: state is ${receipt.qualificationState}` };
    }

    const previousEntry = this.currentRevision.activeRoster.find(
      e => e.providerId === model.providerId && e.modelId === model.modelId,
    );

    const newEntry: RosterEntry = {
      providerId: model.providerId,
      modelId: model.modelId,
      displayName: model.displayName,
      assignedRoles,
      roleScores: {},
      qualificationStatus: receipt.qualificationState,
      policyStatus: "ALLOWED",
      healthStatus: model.health?.status ?? "healthy",
    };

    const changes: RosterChange[] = [{
      providerId: model.providerId,
      modelId: model.modelId,
      action: "PROMOTED",
      roles: assignedRoles,
      previousRoles: previousEntry?.assignedRoles,
      reasonCodes: ["qualification_passed", "policy_verified"],
      timestamp: now,
    }];

    const updatedRoster = [
      ...this.currentRevision.activeRoster.filter(e => !(e.providerId === model.providerId && e.modelId === model.modelId)),
      newEntry,
    ];

    const rev = await this.commitRevision(changes, updatedRoster);
    return { success: true, newRevision: rev };
  }

  /**
   * Retires a model from active roster (e.g. free tier removed, deprecated).
   */
  async retireModel(providerId: string, modelId: string, reasonCodes: string[]): Promise<RosterRevision> {
    const now = new Date().toISOString();
    const existing = this.currentRevision.activeRoster.find(
      e => e.providerId === providerId && e.modelId === modelId,
    );

    const change: RosterChange = {
      providerId,
      modelId,
      action: "RETIRED",
      previousRoles: existing?.assignedRoles,
      reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["free_eligibility_ended"],
      timestamp: now,
    };

    const updatedRoster = this.currentRevision.activeRoster.filter(
      e => !(e.providerId === providerId && e.modelId === modelId),
    );

    return this.commitRevision([change], updatedRoster);
  }

  /**
   * Policy expiration immediately blocks/removes model, even if health is perfectly healthy (§64).
   */
  async expirePolicy(providerId: string, modelId: string, reasonCodes: string[] = ["policy_record_expired"]): Promise<RosterRevision> {
    const now = new Date().toISOString();
    const change: RosterChange = {
      providerId,
      modelId,
      action: "POLICY_EXPIRED",
      reasonCodes,
      timestamp: now,
    };

    const updatedRoster = this.currentRevision.activeRoster.filter(
      e => !(e.providerId === providerId && e.modelId === modelId),
    );

    return this.commitRevision([change], updatedRoster);
  }

  /**
   * Handles health degradation / rate limits / quota exhaustion churn.
   */
  async updateHealth(providerId: string, modelId: string, healthStatus: string, reasonCodes: string[] = []): Promise<RosterRevision | undefined> {
    const existing = this.currentRevision.activeRoster.find(
      e => e.providerId === providerId && e.modelId === modelId,
    );
    if (!existing || existing.healthStatus === healthStatus) return undefined;

    const now = new Date().toISOString();
    const isDegraded = healthStatus === "degraded" || healthStatus === "rate_limited" || healthStatus === "quota_exhausted" || healthStatus === "offline";
    const action: RosterChangeAction = isDegraded ? "HEALTH_DEGRADED" : "HEALTH_RESTORED";

    const change: RosterChange = {
      providerId,
      modelId,
      action,
      roles: existing.assignedRoles,
      reasonCodes: reasonCodes.length > 0 ? reasonCodes : [`health_status_${healthStatus}`],
      timestamp: now,
    };

    const updatedRoster = this.currentRevision.activeRoster.map(e => {
      if (e.providerId === providerId && e.modelId === modelId) {
        return { ...e, healthStatus };
      }
      return e;
    });

    return this.commitRevision([change], updatedRoster);
  }

  private async commitRevision(changes: RosterChange[], newRoster: RosterEntry[]): Promise<RosterRevision> {
    const nextRevNum = this.currentRevision.revisionNumber + 1;
    const now = new Date().toISOString();
    const rev: RosterRevision = {
      revisionNumber: nextRevNum,
      timestamp: now,
      activeRoster: newRoster,
      changes,
      hash: this.computeHash(nextRevNum, now, newRoster),
    };

    this.currentRevision = rev;
    if (this.store) {
      await this.store.saveRevision(rev);
    }
    return rev;
  }
}

export function createRosterRevisionStore(persistence: ISessionPersistence): RosterRevisionStore {
  return new RosterRevisionStore(persistence);
}

export function createRosterChurnManager(store?: RosterRevisionStore, initialRevision?: RosterRevision): RosterChurnManager {
  return new RosterChurnManager(store, initialRevision);
}