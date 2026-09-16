import { describe, expect, it } from "vitest";
import {
  assertTrainingUseAllowed,
  structuredMetadataProvenance,
  TrainingUseViolationError,
  type DatasetProvenance,
} from "../src/dataset/provenance.js";
import { rowLabelIsCoherent, type EightBitDatasetRow } from "../src/dataset/schema.js";
import { freezeSplits, type FrozenSplits } from "../src/dataset/splits.js";
import {
  OBSERVED_CAPACITY_CONSTANTS,
  rowsFromCapacitySimulation,
  rowsFromDiscoveryCatalog,
  rowsFromFleetQualification,
  rowsFromSmokeWorkers,
  rowsFromCorpusTasks,
  simulateCapacityTrajectories,
  type FleetQualificationRecord,
} from "../src/dataset/builder.js";

function provenance(overrides: Partial<DatasetProvenance> = {}): DatasetProvenance {
  return {
    sourceType: "R3_CORPUS_ATTEMPT",
    sourceRefs: ["evidence/x.json"],
    containsModelOutputContent: false,
    providerTermsRestrictTraining: false,
    trainingUse: "TRAINING_USE_APPROVED",
    trainingUseRationale: "test",
    containsPrivateSourceCode: false,
    containsCredentials: false,
    containsPersonalData: false,
    evidenceObservedAt: "2026-09-15T20:00:00.000Z",
    ...overrides,
  };
}

describe("training-use gate", () => {
  it("admits approved structured metadata", () => {
    expect(() =>
      assertTrainingUseAllowed({ rowId: "r1", provenance: provenance() }),
    ).not.toThrow();
  });

  it("rejects every non-approved training-use state", () => {
    for (const state of ["TRAINING_USE_RESTRICTED", "TRAINING_USE_UNKNOWN", "TRAINING_USE_BLOCKED"] as const) {
      expect(() => assertTrainingUseAllowed({ rowId: "r", provenance: provenance({ trainingUse: state }) }))
        .toThrow(TrainingUseViolationError);
    }
  });

  it("rejects rows embedding credentials or private source code even when approved", () => {
    expect(() =>
      assertTrainingUseAllowed({ rowId: "r", provenance: provenance({ containsCredentials: true }) }),
    ).toThrow(TrainingUseViolationError);
    expect(() =>
      assertTrainingUseAllowed({ rowId: "r", provenance: provenance({ containsPrivateSourceCode: true }) }),
    ).toThrow(TrainingUseViolationError);
  });

  it("rejects third-party model output content whose provider terms restrict training", () => {
    expect(() =>
      assertTrainingUseAllowed({
        rowId: "r",
        provenance: provenance({
          containsModelOutputContent: true,
          providerTermsRestrictTraining: true,
        }),
      }),
    ).toThrow(TrainingUseViolationError);
  });

  it("structuredMetadataProvenance never embeds output content and is approved", () => {
    const p = structuredMetadataProvenance({
      sourceType: "QUALIFICATION_PROBE",
      sourceRefs: ["a.json"],
      evidenceObservedAt: "2026-09-15T00:00:00.000Z",
    });
    expect(p.containsModelOutputContent).toBe(false);
    expect(p.trainingUse).toBe("TRAINING_USE_APPROVED");
  });
});

function makeRow(overrides: Partial<EightBitDatasetRow> & { rowId: string; canonicalModelId?: string; observedAt?: string; derived?: boolean }): EightBitDatasetRow {
  const canonicalModelId = overrides.canonicalModelId ?? "openai/gpt-oss-120b";
  return {
    rowId: overrides.rowId,
    datasetSchemaVersion: 1,
    taskKind: "ROUTE_OUTCOME",
    providerId: "groq",
    providerModelId: "openai/gpt-oss-120b",
    canonicalModelId,
    modelFamily: "gpt-oss",
    features: {
      observedEconomicsState: "FREE_LIMITED",
      observedPrivacyState: "PRIVACY_UNKNOWN",
      observedHealthState: "HEALTHY",
      evidenceCompleteness: 0.5,
    },
    label: { routeOutcome: "SUCCESS" },
    provenance: provenance({
      sourceType: overrides.derived ? "DERIVED_SIMULATION" : "R3_CORPUS_ATTEMPT",
      evidenceObservedAt: overrides.observedAt ?? "2026-09-15T20:00:00.000Z",
    }),
  };
}

describe("split freeze", () => {
  it("never places a canonical model in two splits", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      makeRow({ rowId: `r${i}`, canonicalModelId: `lab/model-${i}` }),
    );
    const frozen: FrozenSplits = freezeSplits(rows, {
      datasetManifestHash: "deadbeef",
      temporalCutoff: "2026-09-16T00:00:00.000Z",
    });
    expect(frozen.leakedGroups).toEqual([]);
    expect(frozen.counts.TRAIN + frozen.counts.DEV + frozen.counts.PROTECTED_HOLDOUT).toBe(40);
  });

  it("routes real rows newer than the cutoff wholly to the temporal holdout, grouped", () => {
    const rows = [
      makeRow({ rowId: "old-1", canonicalModelId: "lab/alpha", observedAt: "2026-09-14T00:00:00.000Z" }),
      makeRow({ rowId: "old-2", canonicalModelId: "lab/alpha", observedAt: "2026-09-14T01:00:00.000Z" }),
      makeRow({ rowId: "new-1", canonicalModelId: "lab/alpha", observedAt: "2026-09-20T00:00:00.000Z" }),
      makeRow({ rowId: "other-new", canonicalModelId: "lab/beta", observedAt: "2026-09-19T00:00:00.000Z" }),
    ];
    const frozen = freezeSplits(rows, {
      datasetManifestHash: "deadbeef",
      temporalCutoff: "2026-09-15T00:00:00.000Z",
    });
    const splitOf = Object.fromEntries(frozen.assignments.map((a) => [a.rowId, a.split]));
    expect(splitOf["new-1"]).toBe("TEMPORAL_HOLDOUT");
    expect(splitOf["other-new"]).toBe("TEMPORAL_HOLDOUT");
    expect(splitOf["old-1"]).toBe("TEMPORAL_HOLDOUT");
    expect(splitOf["old-2"]).toBe("TEMPORAL_HOLDOUT");
  });

  it("confines derived simulations to TRAIN and excludes them from real-row counts", () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => makeRow({ rowId: `r${i}`, canonicalModelId: `lab/model-${i}` })),
      makeRow({ rowId: "sim-1", derived: true, canonicalModelId: "lab/sim-model" }),
    ];
    const frozen = freezeSplits(rows, {
      datasetManifestHash: "deadbeef",
      temporalCutoff: "2026-09-16T00:00:00.000Z",
    });
    const splitOf = Object.fromEntries(frozen.assignments.map((a) => [a.rowId, a.split]));
    expect(splitOf["sim-1"]).toBe("TRAIN");
    expect(frozen.realRowsPerSplit.DEV + frozen.realRowsPerSplit.PROTECTED_HOLDOUT + frozen.realRowsPerSplit.TEMPORAL_HOLDOUT)
      .toBe(frozen.counts.DEV + frozen.counts.PROTECTED_HOLDOUT + frozen.counts.TEMPORAL_HOLDOUT);
  });

  it("moves a shared canonical group wholly to TRAIN when a derived row shares it", () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => makeRow({ rowId: `r${i}`, canonicalModelId: `lab/model-${i}` })),
      makeRow({ rowId: "real-shared", canonicalModelId: "lab/shared-model" }),
      makeRow({ rowId: "sim-shared", derived: true, canonicalModelId: "lab/shared-model" }),
    ];
    const frozen = freezeSplits(rows, {
      datasetManifestHash: "deadbeef",
      temporalCutoff: "2026-09-16T00:00:00.000Z",
    });
    const splitOf = Object.fromEntries(frozen.assignments.map((a) => [a.rowId, a.split]));
    expect(splitOf["real-shared"]).toBe("TRAIN");
    expect(splitOf["sim-shared"]).toBe("TRAIN");
    expect(frozen.leakedGroups).toEqual([]);
  });

  it("is deterministic for identical inputs (same sha256)", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      makeRow({ rowId: `r${i}`, canonicalModelId: `lab/model-${i}` }),
    );
    const a = freezeSplits(rows, { datasetManifestHash: "h", temporalCutoff: "2026-09-16T00:00:00.000Z" });
    const b = freezeSplits(rows, { datasetManifestHash: "h", temporalCutoff: "2026-09-16T00:00:00.000Z" });
    expect(a.sha256).toBe(b.sha256);
  });

  it("refuses rows failing the training-use gate", () => {
    const rows = [makeRow({ rowId: "bad" })];
    rows[0]!.provenance.trainingUse = "TRAINING_USE_BLOCKED";
    expect(() =>
      freezeSplits(rows, { datasetManifestHash: "h", temporalCutoff: "2026-09-16T00:00:00.000Z" }),
    ).toThrow(TrainingUseViolationError);
  });
});

describe("label coherence", () => {
  it("requires the label dimension matching the task kind", () => {
    const row = makeRow({ rowId: "x" });
    expect(rowLabelIsCoherent(row)).toBe(true);
    expect(rowLabelIsCoherent({ ...row, taskKind: "ROLE_SUITABILITY" })).toBe(false);
    expect(rowLabelIsCoherent({ ...row, taskKind: "ECONOMICS_STATE" })).toBe(false);
    expect(rowLabelIsCoherent({ ...row, label: {} })).toBe(false);
  });
});

describe("evidence extractors", () => {
  it("maps corpus task records to route outcomes with quota signal from notes", () => {
    const rows = rowsFromCorpusTasks(
      [
        {
          task_id: "A-001",
          status: "CAPACITY_BLOCKED",
          failure_class: "provider_rate_limited",
          notes: ["groq error (429): Limit 200000, Used 199000"],
          started_at: "2026-09-15T23:06:40.709Z",
          finished_at: "2026-09-15T23:08:26.994Z",
          provider_routes: { "groq::openai/gpt-oss-120b": { requests: 3, inputTokens: 0, outputTokens: 0 } },
        },
      ],
      "tests/evidence/r3/corpus-runs/campaign-1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label.routeOutcome).toBe("QUOTA_EXHAUSTED");
    expect(rows[0]!.canonicalModelId).toBe("openai/gpt-oss-120b");
    expect(rows[0]!.provenance.sourceRefs[0]).toContain("tasks/A-001.json");
  });

  it("maps smoke worker telemetry to outcomes, success when no provider failure", () => {
    const rows = rowsFromSmokeWorkers(
      [
        {
          role: "Task Planner",
          status: "completed",
          model: { providerId: "groq", modelId: "openai/gpt-oss-120b" },
          telemetry: { wallTimeMs: 61887, modelRequests: 1, inputTokens: 1475, outputTokens: 670, toolCalls: 0, retryCount: 0, providerFailures: 0 },
          startedAt: "2026-09-15T20:28:57.461Z",
          completedAt: "2026-09-15T20:29:59.337Z",
        },
        {
          role: "Repository Explorer",
          status: "failed",
          model: { providerId: "groq", modelId: "openai/gpt-oss-120b" },
          telemetry: { wallTimeMs: 369512, modelRequests: 6, inputTokens: 7495, outputTokens: 413, toolCalls: 5, retryCount: 0, providerFailures: 1 },
          startedAt: "2026-09-15T21:34:22.018Z",
        },
      ],
      "S-001",
      "tests/evidence/r3/corpus-runs/campaign-1",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.label.routeOutcome).toBe("SUCCESS");
    expect(rows[0]!.features.role).toBe("Task Planner");
    expect(rows[1]!.label.routeOutcome).toBe("RATE_LIMITED");
  });

  it("skips workers without a resolved model or zero requests", () => {
    const rows = rowsFromSmokeWorkers(
      [
        {
          role: "Repository Explorer",
          status: "failed",
          model: null,
          telemetry: { wallTimeMs: 1, modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, retryCount: 0, providerFailures: 0 },
          startedAt: "2026-09-15T21:34:22.018Z",
        },
      ],
      "S-001",
      "x",
    );
    expect(rows).toHaveLength(0);
  });

  it("extracts role suitability labels from fleet qualification evidence", () => {
    const record: FleetQualificationRecord = {
      schemaVersion: 1,
      generatedAt: "2026-09-15T00:43:38.053Z",
      providers: [
        {
          providerId: "groq",
          status: "CERTIFIED",
          qualifications: [
            {
              modelId: "openai/gpt-oss-120b",
              qualificationState: "QUALIFIED",
              roleStatuses: { CODER: "QUALIFIED", TOOL_AGENT: "PROBATION", ANALYST: "NOT_QUALIFIED" },
              caseDetails: {
                "CODER:compact.tool_call": { passed: true, latencyMs: 362 },
                "CODER:compact.edit": { passed: true, latencyMs: 1080 },
              },
            },
          ],
        },
      ],
    };
    const rows = rowsFromFleetQualification(record, "docs/evidence/managed-free-r2-fleet-qualification.json");
    expect(rows).toHaveLength(3);
    const byRole = Object.fromEntries(rows.map((r) => [r.features.role, r.label.roleSuitability]));
    expect(byRole["CODER"]).toBe("QUALIFIED");
    expect(byRole["TOOL_AGENT"]).toBe("PROBATION");
    expect(byRole["ANALYST"]).toBe("NOT_QUALIFIED");
    expect(rows[0]!.features.latencyP50Ms).toBe(362);
    expect(rows[0]!.modelFamily).toBe("gpt-oss");
  });

  it("extracts economics labels from discovery catalogs, verified_free to FREE_CONFIRMED", () => {
    const rows = rowsFromDiscoveryCatalog(
      [
        { modelId: "nvidia/nemotron-3-super-120b-a12b:free", freeStatus: "verified_free", contextWindow: 1000000, toolCalling: true, structuredOutput: false },
        { modelId: "unknown/model:free", freeStatus: "unverified" },
      ],
      "openrouter",
      "2026-09-13T16:49:06.712Z",
      "apps/desktop/release/r5-evidence/free-cloud/discovery-refresh-current.json",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.label.economicsState).toBe("FREE_CONFIRMED");
    expect(rows[0]!.canonicalModelId).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(rows[1]!.label.economicsState).toBe("ECONOMICS_UNKNOWN");
  });

  it("capacity simulation is deterministic and bounded by certified constants", () => {
    const a = simulateCapacityTrajectories(OBSERVED_CAPACITY_CONSTANTS, 50, 1337);
    const b = simulateCapacityTrajectories(OBSERVED_CAPACITY_CONSTANTS, 50, 1337);
    expect(a).toEqual(b);
    expect(a.every((s) => s.dailyTokensUsed >= 0)).toBe(true);
    const outcomes = new Set(a.map((s) => s.outcome));
    expect(outcomes.size).toBeGreaterThan(1);
    const rows = rowsFromCapacitySimulation(a, ["route-anchored-1"], "2026-09-15T21:49:35.500Z");
    expect(rows).toHaveLength(50);
    expect(rows[0]!.provenance.sourceType).toBe("DERIVED_SIMULATION");
    expect(rows[0]!.provenance.derivedFrom).toContain("route-anchored-1");
  });
});
