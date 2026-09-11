import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type CampaignCandidateKind = "A" | "B" | "C" | "D";

export type ObservationClassification =
  | "VALIDATED"
  | "INVALIDATED"
  | "INCOMPLETE"
  | "INSUFFICIENT_EVIDENCE";

export interface ObservationRecord {
  /** Dedup identity (FG-11 amendment §2). Deterministically recomputed by `occurrenceId()` —
   * never hand-set by a caller. */
  occurrenceId: string;
  /** Diversity/uniqueness key over the canonical evidence alone, independent of occurrence —
   * used for "unique fingerprints" reporting, never for dedup. */
  evidenceFingerprint: string;
  candidateKind: CampaignCandidateKind;
  certifiedSourceStateId: string;
  campaignHarnessId: string;
  observationSchemaVersion: string;
  candidatePolicyVersion: string;
  runId: string;
  taskId: string;
  /** The real anchor of the underlying production event this observation is about — e.g. for B
   * a `(pageId, turnIndex)` pair, for D a `(priorAttemptId, freshAttemptId)` pair. */
  productionOccurrenceId: string;
  classification: ObservationClassification;
  /** Which deliberate control/invalidation case (spec §10/§13/§15) this exercises, if any. */
  controlCase?: string;
  diversityDimensions: Record<string, string>;
  unsafeFalsePositive: boolean;
  falsePositiveReason?: string;
  /** B/C/D only — always labeled PROJECTED, never a claim of actual avoided work. */
  projected?: Record<string, number>;
  /** Candidate A only — actual, measured avoided work. Never merged with `projected`. */
  actual?: Record<string, number>;
  observerOverheadMs: number;
  createdAt: string;
}

export type ObservationInput = Omit<ObservationRecord, "occurrenceId" | "createdAt">;

export function computeOccurrenceId(input: ObservationInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.candidateKind,
        input.certifiedSourceStateId,
        input.campaignHarnessId,
        input.runId,
        input.taskId,
        input.productionOccurrenceId,
        input.evidenceFingerprint,
      ]),
    )
    .digest("hex");
}

/**
 * Append-only, content-addressed, idempotent observation persistence (FG-11 §23/§24, amendment
 * §2). One JSONL file per candidate under `docs/fg11/observations/`. Replaying the identical
 * occurrence (same run, task, production-occurrence anchor, and evidence) is a no-op; a
 * genuinely independent run producing identical evidence gets a different `runId` and therefore
 * a different occurrence id, so it counts again.
 */
export class ObservationStore {
  private readonly seen = new Map<CampaignCandidateKind, Set<string>>();
  private readonly cache = new Map<CampaignCandidateKind, ObservationRecord[]>();

  constructor(private readonly baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  private filePath(candidate: CampaignCandidateKind): string {
    return path.join(this.baseDir, `candidate-${candidate.toLowerCase()}.jsonl`);
  }

  private load(candidate: CampaignCandidateKind): ObservationRecord[] {
    const cached = this.cache.get(candidate);
    if (cached) return cached;
    const file = this.filePath(candidate);
    const records: ObservationRecord[] = [];
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);
      for (const line of lines) {
        try {
          records.push(JSON.parse(line) as ObservationRecord);
        } catch {
          // A corrupt trailing line (e.g. a killed process mid-write) is skipped, never trusted.
        }
      }
    }
    this.cache.set(candidate, records);
    this.seen.set(candidate, new Set(records.map((r) => r.occurrenceId)));
    return records;
  }

  /** Ingests one observation. Returns `{ inserted: false }` when this exact occurrence was
   * already recorded (restart/replay safe — proves §24). */
  ingest(input: ObservationInput): { inserted: boolean; record: ObservationRecord } {
    const records = this.load(input.candidateKind);
    const occurrenceId = computeOccurrenceId(input);
    const seenSet = this.seen.get(input.candidateKind)!;
    const existing = records.find((r) => r.occurrenceId === occurrenceId);
    if (existing) return { inserted: false, record: existing };
    const record: ObservationRecord = { ...input, occurrenceId, createdAt: new Date().toISOString() };
    fs.appendFileSync(this.filePath(input.candidateKind), `${JSON.stringify(record)}\n`, "utf8");
    records.push(record);
    seenSet.add(occurrenceId);
    return { inserted: true, record };
  }

  all(candidate: CampaignCandidateKind): readonly ObservationRecord[] {
    return this.load(candidate);
  }
}

export function createObservationStore(baseDir: string): ObservationStore {
  return new ObservationStore(baseDir);
}
