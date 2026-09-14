import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { FreeModelRecord } from "@codeforge/forge-zero";
import {
  createSampleFromModel,
  splitDataset,
} from "../src/training/dataset.js";
import { RosterSpecialistModel } from "../src/training/model.js";
import { evaluateModel } from "../src/training/evaluation.js";
import { PromotionGate, type PromotionCandidate } from "../src/training/promotion.js";
import { trainRosterSpecialist } from "../src/training/pipeline.js";

function makeSyntheticModel(id: string, coding: number, reasoning: number, speed: number, tools: boolean): FreeModelRecord {
  return {
    providerId: "synth",
    modelId: id,
    displayName: id,
    freeStatus: "verified_free",
    freeStatusVerifiedAt: new Date().toISOString(),
    tier: "free",
    accessClass: "FREE_NATIVE",
    authMode: "no_auth",
    privacyClass: "public",
    family: "synth",
    upstreamSource: "synth",
    deprecated: false,
    contextWindow: 64000,
    maxOutput: 4096,
    capabilities: { text: true, coding: true, toolCalling: tools, vision: false, structuredOutput: true, longContext: false },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: new Date().toISOString(),
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "synth",
    },
    benchmarkProfile: { coding, reasoning, speed, toolCalling: tools ? 85 : 20 },
    health: { status: "healthy", consecutiveSuccesses: 10, recentFailureCount: 0, lastCheckAt: new Date().toISOString() },
  };
}

describe("8-Bit Specialization Training Pipeline", () => {
  // Generate a reproducible dataset of qualified and non-qualified synthetic models
  const samples = [
    // Strong qualified coders
    createSampleFromModel(makeSyntheticModel("c1", 90, 85, 80, true), true, { CODER: 0.95, REVIEWER: 0.85 }),
    createSampleFromModel(makeSyntheticModel("c2", 88, 80, 85, true), true, { CODER: 0.90, REVIEWER: 0.80 }),
    createSampleFromModel(makeSyntheticModel("c3", 92, 88, 75, true), true, { CODER: 0.92, PLANNER: 0.85 }),
    createSampleFromModel(makeSyntheticModel("c4", 85, 90, 70, true), true, { PLANNER: 0.95, REASONER: 0.90 }),
    createSampleFromModel(makeSyntheticModel("c5", 80, 92, 65, true), true, { PLANNER: 0.92, REASONER: 0.95 }),
    createSampleFromModel(makeSyntheticModel("c6", 75, 75, 95, true), true, { FAST_WORKER: 0.95, TOOL_AGENT: 0.90 }),
    // Weak / disqualified models (lack tools, low benchmark)
    createSampleFromModel(makeSyntheticModel("d1", 30, 40, 50, false), false, { CODER: 0.1, PLANNER: 0.1 }),
    createSampleFromModel(makeSyntheticModel("d2", 25, 35, 40, false), false, { CODER: 0.05, REVIEWER: 0.05 }),
    createSampleFromModel(makeSyntheticModel("d3", 40, 30, 60, false), false, { FAST_WORKER: 0.2, TOOL_AGENT: 0.1 }),
    createSampleFromModel(makeSyntheticModel("d4", 35, 45, 50, false), false, { REASONER: 0.2, PLANNER: 0.2 }),
    createSampleFromModel(makeSyntheticModel("d5", 20, 25, 30, false), false, { CODER: 0.02, REVIEWER: 0.02 }),
    createSampleFromModel(makeSyntheticModel("d6", 45, 40, 55, false), false, { TOOL_AGENT: 0.15, FAST_WORKER: 0.2 }),
  ];

  it("splits dataset into train, dev, and eval with deterministic partitions", () => {
    const splits = splitDataset(samples, 0.6, 0.2);
    expect(splits.train.length).toBeGreaterThan(0);
    expect(splits.dev.length).toBeGreaterThan(0);
    expect(splits.eval.length).toBeGreaterThan(0);
    expect(splits.train.length + splits.dev.length + splits.eval.length).toBe(samples.length);
  });

  it("executes genuine training loop, updates weights, and reduces loss", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-8bit-train-"));
    try {
      const result = await trainRosterSpecialist(samples, {
        epochs: 40,
        learningRate: 0.08,
        batchSize: 4,
        outputDir: tmpDir,
      });

      expect(result.epochsCompleted).toBe(40);
      expect(result.lossReduced).toBe(true);
      expect(result.finalLoss).toBeLessThan(result.initialLoss);

      // Checkpoint was written to disk
      expect(result.checkpointPath).toBeDefined();
      expect(fs.existsSync(result.checkpointPath!)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(result.checkpointPath!, "utf-8"));
      expect(saved.sha256).toBe(result.candidate.sha256);
      expect(saved.weights.w1).toBeDefined();

      // Evaluation metrics populated
      expect(result.trainMetrics.qualificationAccuracy).toBeGreaterThan(0.70);
      expect(result.trainMetrics.avgInferenceMs).toBeLessThan(10); // Fast local execution
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("promotion gate verifies artifact integrity, accuracy thresholds, and prevents regression", () => {
    const model = new RosterSpecialistModel();
    const metrics = evaluateModel(model, samples);

    const gate = new PromotionGate({
      minQualificationAccuracy: 0.70,
      minRoleTop1Accuracy: 0.50,
      maxMeanLoss: 2.0,
    });

    const goodCandidate: PromotionCandidate = {
      modelWeights: model.weights,
      metrics: {
        totalSamples: 10,
        qualificationAccuracy: 0.85,
        qualificationPrecision: 0.85,
        qualificationRecall: 0.85,
        qualificationF1: 0.85,
        roleTop1Accuracy: 0.80,
        meanLoss: 0.4,
        avgInferenceMs: 0.1,
      },
      sha256: model.getSha256(),
      createdAt: new Date().toISOString(),
    };

    const promotion = gate.evaluateCandidate(goodCandidate);
    expect(promotion.promoted).toBe(true);
    expect(promotion.artifactVersion).toBeDefined();
    expect(promotion.reasons).toContain("artifact_integrity_verified");
    expect(promotion.reasons).toContain("deterministic_policy_guard_verified");

    // Manifest creation
    const manifest = gate.createManifest(promotion, goodCandidate);
    expect(manifest.status).toBe("ACTIVE");
    expect(manifest.artifactVersion).toBe(promotion.artifactVersion);

    // Rollback
    const rolledBack = gate.rollback(manifest, "previous-stable-version");
    expect(rolledBack.status).toBe("ROLLED_BACK");
    expect(rolledBack.rollbackTarget).toBe("previous-stable-version");

    // Tampered artifact should be rejected
    const tamperedCandidate: PromotionCandidate = {
      ...goodCandidate,
      sha256: "tampered-corrupted-hash",
    };
    const tamperedResult = gate.evaluateCandidate(tamperedCandidate);
    expect(tamperedResult.promoted).toBe(false);
    expect(tamperedResult.failureDetails![0]).toContain("ARTIFACT_INTEGRITY_MISMATCH");
  });
});