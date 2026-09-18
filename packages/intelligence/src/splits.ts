import { createHash } from "node:crypto";
import type { DatasetPartition, IntelligenceRecord } from "./schema.js";
import { INTELLIGENCE_SPLIT_VERSION } from "./schema.js";

export interface SplitAssignment {
  recordId: string;
  partition: DatasetPartition;
  groupId: string;
}

export interface IntelligenceDatasetSplit {
  splitVersion: typeof INTELLIGENCE_SPLIT_VERSION;
  randomSeed: number;
  datasetHash: string;
  assignments: SplitAssignment[];
  counts: Record<DatasetPartition, number>;
  groupCounts: Record<DatasetPartition, number>;
  leakedGroups: string[];
  protectedRecordIds: string[];
}

export interface SplitOptions {
  randomSeed: number;
  validationFraction?: number;
  publicTestFraction?: number;
  protectedHoldoutFraction?: number;
}

class DisjointSet {
  private readonly parent: number[];
  constructor(size: number) { this.parent = Array.from({ length: size }, (_, index) => index); }
  find(index: number): number {
    const parent = this.parent[index];
    if (parent === undefined || parent === index) return index;
    const root = this.find(parent);
    this.parent[index] = root;
    return root;
  }
  join(left: number, right: number): void {
    const l = this.find(left);
    const r = this.find(right);
    if (l !== r) this.parent[Math.max(l, r)] = Math.min(l, r);
  }
}

function familyKeys(record: IntelligenceRecord): string[] {
  const lineage = record.lineage;
  return [lineage.taskFamilyHash, lineage.fixtureFamilyHash, lineage.repositoryHash, lineage.benchmarkLineageHash]
    .filter((value): value is string => value !== undefined)
    .map((value) => `family:${value}`);
}

function hashToUnit(value: string, seed: number): number {
  const hash = createHash("sha256").update(`${seed}:${value}`).digest();
  return hash.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Uses connected components, not a row shuffle: sharing any known task/fixture/repository/
 * benchmark lineage moves the complete component together. That is conservative by design.
 */
export function splitByTaskFamily(records: IntelligenceRecord[], options: SplitOptions): IntelligenceDatasetSplit {
  const sets = new DisjointSet(records.length);
  const firstByKey = new Map<string, number>();
  records.forEach((record, index) => {
    for (const key of familyKeys(record)) {
      const first = firstByKey.get(key);
      if (first === undefined) firstByKey.set(key, index);
      else sets.join(first, index);
    }
  });
  const members = new Map<number, number[]>();
  records.forEach((_, index) => {
    const root = sets.find(index);
    const list = members.get(root) ?? [];
    list.push(index);
    members.set(root, list);
  });
  const protectedFraction = options.protectedHoldoutFraction ?? 0.2;
  const publicFraction = options.publicTestFraction ?? 0.15;
  const validationFraction = options.validationFraction ?? 0.15;
  if (protectedFraction < 0 || publicFraction < 0 || validationFraction < 0 || protectedFraction + publicFraction + validationFraction >= 1) {
    throw new Error("split fractions must be non-negative and leave a training remainder");
  }
  const assignments: SplitAssignment[] = [];
  const counts: Record<DatasetPartition, number> = { TRAINING: 0, VALIDATION: 0, PUBLIC_TEST: 0, PROTECTED_HOLDOUT: 0 };
  const groupCounts: Record<DatasetPartition, number> = { TRAINING: 0, VALIDATION: 0, PUBLIC_TEST: 0, PROTECTED_HOLDOUT: 0 };
  for (const indices of [...members.values()].sort((a, b) => records[a[0]!]!.recordId.localeCompare(records[b[0]!]!.recordId))) {
    const groupId = createHash("sha256").update(indices.map((index) => records[index]!.recordId).sort().join(",")).digest("hex");
    const rank = hashToUnit(groupId, options.randomSeed);
    const partition: DatasetPartition = rank < protectedFraction ? "PROTECTED_HOLDOUT"
      : rank < protectedFraction + publicFraction ? "PUBLIC_TEST"
      : rank < protectedFraction + publicFraction + validationFraction ? "VALIDATION"
      : "TRAINING";
    groupCounts[partition]++;
    for (const index of indices) {
      assignments.push({ recordId: records[index]!.recordId, partition, groupId });
      counts[partition]++;
    }
  }
  const groupsByPartition = new Map<string, Set<DatasetPartition>>();
  for (const assignment of assignments) {
    const partitions = groupsByPartition.get(assignment.groupId) ?? new Set<DatasetPartition>();
    partitions.add(assignment.partition);
    groupsByPartition.set(assignment.groupId, partitions);
  }
  const leakedGroups = [...groupsByPartition.entries()].filter(([, partitions]) => partitions.size > 1).map(([group]) => group);
  const datasetHash = createHash("sha256").update(JSON.stringify(records.map((record) => record.recordId).sort())).digest("hex");
  return {
    splitVersion: INTELLIGENCE_SPLIT_VERSION,
    randomSeed: options.randomSeed,
    datasetHash,
    assignments: assignments.sort((a, b) => a.recordId.localeCompare(b.recordId)),
    counts,
    groupCounts,
    leakedGroups,
    protectedRecordIds: assignments.filter((assignment) => assignment.partition === "PROTECTED_HOLDOUT").map((assignment) => assignment.recordId).sort(),
  };
}

/** Protected evidence is never an input to fitting or threshold selection. */
export function trainingRecords(records: IntelligenceRecord[], split: IntelligenceDatasetSplit): IntelligenceRecord[] {
  const byId = new Map(records.map((record) => [record.recordId, record]));
  return split.assignments
    .filter((assignment) => assignment.partition === "TRAINING")
    .map((assignment) => byId.get(assignment.recordId))
    .filter((record): record is IntelligenceRecord => record !== undefined);
}
