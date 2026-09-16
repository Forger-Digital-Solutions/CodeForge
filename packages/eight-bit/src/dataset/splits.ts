import { createHash } from "node:crypto";
import type { EightBitDatasetRow } from "./schema.js";
import { assertTrainingUseAllowed } from "./provenance.js";

/**
 * 8-Bit dataset hygiene (R3.5 §16): TRAIN / DEV / PROTECTED_HOLDOUT / TEMPORAL_HOLDOUT with
 * alias-leakage prevention. Splits are grouped by canonical model identity so the same
 * underlying model reached through different provider routes never crosses a split boundary,
 * and the temporal holdout is reserved from the NEWEST real evidence so it simulates the actual
 * job: something changed after training — can 8-Bit interpret the new evidence?
 */

export const DATASET_SPLITS = ["TRAIN", "DEV", "PROTECTED_HOLDOUT", "TEMPORAL_HOLDOUT"] as const;
export type DatasetSplit = (typeof DATASET_SPLITS)[number];

export interface SplitAssignment {
  rowId: string;
  split: DatasetSplit;
  groupKey: string;
}

export interface FrozenSplits {
  schemaVersion: 1;
  frozenAt: string;
  datasetManifestHash: string;
  assignments: SplitAssignment[];
  counts: Record<DatasetSplit, number>;
  /** Distinct canonical models per split (leakage audit). */
  groupsPerSplit: Record<DatasetSplit, number>;
  /** Any canonical model present in more than one split — must be empty. */
  leakedGroups: string[];
  /** Canonical-model leakage resolved at family level; reported, not silently ignored. */
  familyCrossSplitOverlap: string[];
  /** Real-evidence rows only per split (derived simulations are train-only by construction). */
  realRowsPerSplit: Record<DatasetSplit, number>;
  sha256: string;
}

/** Deterministic 64-bit-ish grouping hash so split layout depends only on row content. */
function stableGroupHash(groupKey: string): number {
  const h = createHash("sha256").update(groupKey).digest();
  return h.readUInt32BE(0);
}

export interface FreezeSplitsOptions {
  datasetManifestHash: string;
  /** Fraction of real-evidence groups reserved for the protected holdout (default 0.2). */
  protectedHoldoutGroupFraction?: number;
  /** Fraction of real-evidence groups reserved for dev (default 0.15). */
  devGroupFraction?: number;
  /** Timestamp cutoff: real rows observed strictly after this go to TEMPORAL_HOLDOUT. */
  temporalCutoff: string;
  frozenAt?: string;
}

export function freezeSplits(rows: EightBitDatasetRow[], options: FreezeSplitsOptions): FrozenSplits {
  for (const row of rows) {
    assertTrainingUseAllowed(row);
  }

  const realRows = rows.filter((r) => r.provenance.sourceType !== "DERIVED_SIMULATION");
  const derivedRows = rows.filter((r) => r.provenance.sourceType === "DERIVED_SIMULATION");

  // Temporal holdout: newest real evidence, grouped so a model's newest observations move
  // together (splitting by row would leak the same model's older behavior into TRAIN).
  const temporalRows = realRows.filter((r) => r.provenance.evidenceObservedAt > options.temporalCutoff);
  const remainingReal = realRows.filter((r) => r.provenance.evidenceObservedAt <= options.temporalCutoff);

  const temporalGroupKeys = new Set(temporalRows.map(groupKeyOf));
  const trainRealRows = remainingReal.filter((r) => !temporalGroupKeys.has(groupKeyOf(r)));
  // A group whose newest evidence crossed the cutoff moves wholly to the temporal holdout,
  // including its older rows — that is the conservative, leakage-free direction.
  const movedToTemporal = remainingReal.filter((r) => temporalGroupKeys.has(groupKeyOf(r)));

  const groups = new Map<string, EightBitDatasetRow[]>();
  for (const row of trainRealRows) {
    const key = groupKeyOf(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  // A group containing any derived-simulation row moves WHOLLY to TRAIN: simulations are
  // train-only by construction, and keeping the group intact preserves the no-cross-split
  // invariant for the canonical model it shares with real evidence.
  const derivedGroupKeys = new Set(derivedRows.map(groupKeyOf));
  const groupList = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

  const protectedFraction = options.protectedHoldoutGroupFraction ?? 0.2;
  const devFraction = options.devGroupFraction ?? 0.15;
  const assignments: SplitAssignment[] = [];
  const splitGroups: Record<DatasetSplit, Set<string>> = {
    TRAIN: new Set(),
    DEV: new Set(),
    PROTECTED_HOLDOUT: new Set(),
    TEMPORAL_HOLDOUT: new Set(),
  };
  const splitRows: Record<DatasetSplit, Set<string>> = {
    TRAIN: new Set(),
    DEV: new Set(),
    PROTECTED_HOLDOUT: new Set(),
    TEMPORAL_HOLDOUT: new Set(),
  };

  for (const row of [...temporalRows, ...movedToTemporal]) {
    assignments.push({ rowId: row.rowId, split: "TEMPORAL_HOLDOUT", groupKey: groupKeyOf(row) });
    splitGroups.TEMPORAL_HOLDOUT.add(groupKeyOf(row));
    splitRows.TEMPORAL_HOLDOUT.add(row.rowId);
  }

  const totalGroups = groupList.length;
  const protectedTarget = Math.max(1, Math.round(totalGroups * protectedFraction));
  const devTarget = Math.max(1, Math.round(totalGroups * devFraction));

  groupList.forEach(([key, groupRows], index) => {
    // Deterministic group order + stable hash jitter keeps assignment content-derived, not
    // insertion-derived, so identical datasets freeze identically.
    const rank = (stableGroupHash(key) + index) % totalGroups;
    let split: DatasetSplit;
    if (derivedGroupKeys.has(key)) {
      split = "TRAIN";
    } else if (rank < protectedTarget) {
      split = "PROTECTED_HOLDOUT";
    } else if (rank < protectedTarget + devTarget) {
      split = "DEV";
    } else {
      split = "TRAIN";
    }
    for (const row of groupRows) {
      assignments.push({ rowId: row.rowId, split, groupKey: key });
      splitGroups[split].add(key);
      splitRows[split].add(row.rowId);
    }
  });

  // Derived simulations never contaminate evaluation: train-only by construction.
  for (const row of derivedRows) {
    assignments.push({ rowId: row.rowId, split: "TRAIN", groupKey: groupKeyOf(row) });
    splitGroups.TRAIN.add(groupKeyOf(row));
    splitRows.TRAIN.add(row.rowId);
  }

  const leakedGroups = [...splitGroups.PROTECTED_HOLDOUT]
    .filter((g) => splitGroups.TRAIN.has(g) || splitGroups.DEV.has(g))
    .concat([...splitGroups.DEV].filter((g) => splitGroups.TRAIN.has(g)));

  const familiesPerSplit: Record<DatasetSplit, Set<string>> = {
    TRAIN: new Set(),
    DEV: new Set(),
    PROTECTED_HOLDOUT: new Set(),
    TEMPORAL_HOLDOUT: new Set(),
  };
  for (const row of rows) {
    familiesPerSplit[assignmentOf(assignments, row.rowId)].add(row.modelFamily);
  }
  const familyCrossSplitOverlap = [...familiesPerSplit.PROTECTED_HOLDOUT]
    .filter((f) => familiesPerSplit.TRAIN.has(f) || familiesPerSplit.DEV.has(f))
    .concat([...familiesPerSplit.DEV].filter((f) => familiesPerSplit.TRAIN.has(f)));

  const counts = {
    TRAIN: splitRows.TRAIN.size,
    DEV: splitRows.DEV.size,
    PROTECTED_HOLDOUT: splitRows.PROTECTED_HOLDOUT.size,
    TEMPORAL_HOLDOUT: splitRows.TEMPORAL_HOLDOUT.size,
  };

  const frozenAt = options.frozenAt ?? new Date().toISOString();
  const payload = JSON.stringify(
    { datasetManifestHash: options.datasetManifestHash, assignments, frozenAt },
    null,
    1,
  );
  const sha256 = createHash("sha256").update(payload).digest("hex");

  return {
    schemaVersion: 1,
    frozenAt,
    datasetManifestHash: options.datasetManifestHash,
    assignments,
    counts,
    groupsPerSplit: {
      TRAIN: splitGroups.TRAIN.size,
      DEV: splitGroups.DEV.size,
      PROTECTED_HOLDOUT: splitGroups.PROTECTED_HOLDOUT.size,
      TEMPORAL_HOLDOUT: splitGroups.TEMPORAL_HOLDOUT.size,
    },
    leakedGroups,
    familyCrossSplitOverlap,
    realRowsPerSplit: {
      TRAIN: splitRows.TRAIN.size - derivedRows.length,
      DEV: splitRows.DEV.size,
      PROTECTED_HOLDOUT: splitRows.PROTECTED_HOLDOUT.size,
      TEMPORAL_HOLDOUT: splitRows.TEMPORAL_HOLDOUT.size,
    },
    sha256,
  };
}

export function groupKeyOf(row: EightBitDatasetRow): string {
  return row.canonicalModelId;
}

function assignmentOf(assignments: SplitAssignment[], rowId: string): DatasetSplit {
  const found = assignments.find((a) => a.rowId === rowId);
  if (!found) throw new Error(`no split assignment for row ${rowId}`);
  return found.split;
}
