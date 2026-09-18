import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import { clonePersistableIntelligenceRecord, type IntelligenceOutcome, type IntelligenceRecord, type VerificationOutcome } from "./schema.js";
import type { ShadowModelArtifact } from "./predictors.js";

export const SHADOW_INTELLIGENCE_TELEMETRY_KIND = "shadow_intelligence_telemetry" as const;

export interface ShadowHealthSnapshot {
  shadowPredictionSuccess: number;
  shadowPredictionFailure: number;
  schemaMismatch: number;
  artifactLoadFailure: number;
  predictionLatencyMs: { p50: number; p95: number };
}

/** Global server-side only control. Renderer preferences are intentionally not accepted here. */
export function shadowIntelligenceEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CODEFORGE_SHADOW_INTELLIGENCE === "enabled";
}

export class ShadowHealthCollector {
  private success = 0;
  private failure = 0;
  private mismatch = 0;
  private artifactFailure = 0;
  private readonly latencies: number[] = [];

  record(input: { status: "LOADED" | "DISABLED" | "MISSING" | "SCHEMA_MISMATCH" | "CORRUPT"; latencyMs: number }): void {
    this.latencies.push(Math.max(0, input.latencyMs));
    if (input.status === "LOADED" || input.status === "DISABLED" || input.status === "MISSING") this.success++;
    else {
      this.failure++;
      if (input.status === "SCHEMA_MISMATCH") this.mismatch++;
      if (input.status === "CORRUPT") this.artifactFailure++;
    }
  }

  snapshot(): ShadowHealthSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (quantile: number): number => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))]!;
    return {
      shadowPredictionSuccess: this.success,
      shadowPredictionFailure: this.failure,
      schemaMismatch: this.mismatch,
      artifactLoadFailure: this.artifactFailure,
      predictionLatencyMs: { p50: at(0.5), p95: at(0.95) },
    };
  }
}

/**
 * Additive durable storage on the authoritative session store. Its generic work-item table already
 * supports typed immutable records in SQLite and PostgreSQL, so this needs no destructive schema
 * migration. Session-keyed reads are the tenant boundary.
 */
export class DurableShadowTelemetryStore {
  constructor(private readonly persistence: ISessionPersistence) {}

  async save(sessionId: string, record: IntelligenceRecord): Promise<void> {
    const now = new Date().toISOString();
    const persisted = clonePersistableIntelligenceRecord(record);
    const item: WorkItem = {
      kind: SHADOW_INTELLIGENCE_TELEMETRY_KIND,
      id: `shadow-intelligence-${sessionId}-${persisted.recordId}`,
      sessionId,
      record: persisted as unknown as Record<string, unknown>,
      createdAt: now,
    } as WorkItem;
    await this.persistence.insertIfAbsent(item);
  }

  async loadBySession(sessionId: string): Promise<IntelligenceRecord[]> {
    const items = await this.persistence.getWorkItems(sessionId);
    return items
      .filter((item) => item.kind === SHADOW_INTELLIGENCE_TELEMETRY_KIND && item.sessionId === sessionId)
      .map((item) => (item as Extract<WorkItem, { kind: typeof SHADOW_INTELLIGENCE_TELEMETRY_KIND }>).record as unknown as IntelligenceRecord);
  }

  async loadByRecord(sessionId: string, recordId: string): Promise<IntelligenceRecord | undefined> {
    const item = await this.persistence.getWorkItem(`shadow-intelligence-${sessionId}-${recordId}`);
    if (!item || item.kind !== SHADOW_INTELLIGENCE_TELEMETRY_KIND || item.sessionId !== sessionId) return undefined;
    return (item as Extract<WorkItem, { kind: typeof SHADOW_INTELLIGENCE_TELEMETRY_KIND }>).record as unknown as IntelligenceRecord;
  }

  /** Adds terminal outcome evidence only to the matching tenant-scoped observation. */
  async attachOutcome(sessionId: string, recordId: string, actualOutcome: IntelligenceOutcome, verification: VerificationOutcome): Promise<IntelligenceRecord | undefined> {
    const existing = await this.loadByRecord(sessionId, recordId);
    if (!existing) return undefined;
    const updated: IntelligenceRecord = { ...existing, actualOutcome, verification: { ...verification } };
    const item = await this.persistence.getWorkItem(`shadow-intelligence-${sessionId}-${recordId}`);
    if (!item || item.kind !== SHADOW_INTELLIGENCE_TELEMETRY_KIND || item.sessionId !== sessionId) return undefined;
    await this.persistence.upsertWorkItem({
      kind: SHADOW_INTELLIGENCE_TELEMETRY_KIND,
      id: item.id,
      sessionId,
      record: updated as unknown as Record<string, unknown>,
      createdAt: item.createdAt,
    } as WorkItem);
    return updated;
  }
}

export function createDurableShadowTelemetryStore(persistence: ISessionPersistence): DurableShadowTelemetryStore {
  return new DurableShadowTelemetryStore(persistence);
}

/** Artifact validation belongs before a shadow prediction and has no production side effects. */
export function artifactSummary(artifact: ShadowModelArtifact): Pick<ShadowModelArtifact, "artifactId" | "inputFeatureSchemaVersion" | "trainingDatasetHash" | "createdAt" | "trainingRecordCount"> {
  return {
    artifactId: artifact.artifactId,
    inputFeatureSchemaVersion: artifact.inputFeatureSchemaVersion,
    trainingDatasetHash: artifact.trainingDatasetHash,
    createdAt: artifact.createdAt,
    trainingRecordCount: artifact.trainingRecordCount,
  };
}
