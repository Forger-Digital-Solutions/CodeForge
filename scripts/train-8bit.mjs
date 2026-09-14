#!/usr/bin/env node
/**
 * 8-Bit Specialization Training CLI (R1 spec §32).
 *
 * Usage:
 *   node scripts/train-8bit.mjs [--epochs 30] [--lr 0.05] [--output-dir ./dist/checkpoints]
 */
import * as path from "node:path";
import * as fs from "node:fs";
import * as Training from "../packages/eight-bit/dist/index.js";

async function main() {
  console.log("=== 8-Bit Roster Intelligence Training Pipeline ===");
  console.log("Device target: Local CPU / Developer Architecture (Safe Deterministic Boundary)");

  const args = process.argv.slice(2);
  const epochsIdx = args.indexOf("--epochs");
  const epochs = epochsIdx !== -1 ? parseInt(args[epochsIdx + 1], 10) : 30;
  const lrIdx = args.indexOf("--lr");
  const lr = lrIdx !== -1 ? parseFloat(args[lrIdx + 1]) : 0.05;
  const outIdx = args.indexOf("--output-dir");
  const outputDir = outIdx !== -1 ? args[outIdx + 1] : path.join(process.cwd(), "artifacts", "eight-bit-specialist");

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Config: Epochs=${epochs}, LearningRate=${lr}, OutputDir=${outputDir}`);

  // Create standard training corpus from known benchmarks
  const corpus = [
    Training.createSampleFromModel({
      providerId: "groq",
      modelId: "llama-3.3-70b-versatile",
      displayName: "Llama 3.3 70B",
      freeStatus: "verified_free",
      tier: "free",
      accessClass: "FREE_NATIVE",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
      contextWindow: 128000,
      benchmarkProfile: { coding: 92, reasoning: 82, speed: 95, toolCalling: 90 },
      health: { status: "healthy", consecutiveSuccesses: 20, recentFailureCount: 0 },
    }, true, { CODER: 0.95, REVIEWER: 0.85 }),
    Training.createSampleFromModel({
      providerId: "openrouter",
      modelId: "deepseek-r1:free",
      displayName: "DeepSeek R1 Free",
      freeStatus: "verified_free",
      tier: "free",
      accessClass: "FREE_NATIVE",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
      contextWindow: 160000,
      benchmarkProfile: { coding: 78, reasoning: 96, speed: 45, toolCalling: 72 },
      health: { status: "healthy", consecutiveSuccesses: 15, recentFailureCount: 0 },
    }, true, { PLANNER: 0.96, REASONER: 0.95 }),
    Training.createSampleFromModel({
      providerId: "cloudflare",
      modelId: "@cf/meta/llama-3.1-70b-instruct",
      displayName: "Llama 3.1 70B Instruct",
      freeStatus: "verified_free",
      tier: "free",
      accessClass: "FREE_NATIVE",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
      contextWindow: 64000,
      benchmarkProfile: { coding: 84, reasoning: 85, speed: 80, toolCalling: 82 },
      health: { status: "healthy", consecutiveSuccesses: 10, recentFailureCount: 0 },
    }, true, { REVIEWER: 0.88, CODER: 0.84 }),
    Training.createSampleFromModel({
      providerId: "cerebras",
      modelId: "llama-3.1-8b",
      displayName: "Llama 3.1 8B",
      freeStatus: "verified_free",
      tier: "free",
      accessClass: "FREE_NATIVE",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: false, longContext: false },
      contextWindow: 8192,
      benchmarkProfile: { coding: 70, reasoning: 68, speed: 100, toolCalling: 88 },
      health: { status: "healthy", consecutiveSuccesses: 25, recentFailureCount: 0 },
    }, true, { FAST_WORKER: 0.95, TOOL_AGENT: 0.90 }),
    Training.createSampleFromModel({
      providerId: "test-disqualified",
      modelId: "bad-model",
      displayName: "Bad Model",
      freeStatus: "disqualified",
      tier: "free",
      accessClass: "FREE_NATIVE",
      capabilities: { text: true, coding: false, toolCalling: false, vision: false, structuredOutput: false, longContext: false },
      contextWindow: 4096,
      benchmarkProfile: { coding: 20, reasoning: 25, speed: 30, toolCalling: 15 },
      health: { status: "degraded", consecutiveSuccesses: 0, recentFailureCount: 8 },
    }, false, { CODER: 0.05, PLANNER: 0.05 }),
  ];

  console.log(`Corpus prepared with ${corpus.length} training samples.`);
  console.log("Starting training run...");

  const result = await Training.trainRosterSpecialist(corpus, {
    epochs,
    learningRate: lr,
    batchSize: 2,
    outputDir,
  });

  console.log(`\nTraining Complete:`);
  console.log(`  Initial Loss: ${result.initialLoss}`);
  console.log(`  Final Loss:   ${result.finalLoss} (Reduced: ${result.lossReduced})`);
  console.log(`  Dev Accuracy: ${result.devMetrics.qualificationAccuracy}`);
  console.log(`  Checkpoint:   ${result.checkpointPath}`);
  console.log(`  SHA-256:      ${result.candidate.sha256}`);

  console.log(`\nPromotion Gate:`);
  console.log(`  Promoted:     ${result.promotionResult.promoted}`);
  console.log(`  Reasons:      ${result.promotionResult.reasons.join(", ")}`);
  if (!result.promotionResult.promoted && result.promotionResult.failureDetails) {
    console.log(`  Failures:     ${result.promotionResult.failureDetails.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
