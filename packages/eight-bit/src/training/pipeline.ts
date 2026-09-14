import * as fs from "node:fs";
import * as path from "node:path";
import { splitDataset, type DatasetSplit, type TrainingSample } from "./dataset.js";
import { RosterSpecialistModel, type ModelWeights } from "./model.js";
import { evaluateModel, type EvaluationMetrics } from "./evaluation.js";
import { PromotionGate, type PromotionCandidate, type PromotionResult } from "./promotion.js";

export interface TrainingConfig {
  epochs: number;
  learningRate: number;
  batchSize: number;
  outputDir?: string;
  seed?: number;
}

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  epochs: 30,
  learningRate: 0.05,
  batchSize: 8,
};

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface TrainingRunResult {
  epochsCompleted: number;
  initialLoss: number;
  finalLoss: number;
  lossReduced: boolean;
  trainMetrics: EvaluationMetrics;
  devMetrics: EvaluationMetrics;
  evalMetrics: EvaluationMetrics;
  checkpointPath?: string;
  candidate: PromotionCandidate;
  promotionResult: PromotionResult;
}

export async function trainRosterSpecialist(
  samples: TrainingSample[],
  config: Partial<TrainingConfig> = {},
): Promise<TrainingRunResult> {
  const cfg = { ...DEFAULT_TRAINING_CONFIG, ...config };
  const splits: DatasetSplit = splitDataset(samples);

  const random = seededRandom(cfg.seed ?? 8_000_001);
  const model = new RosterSpecialistModel(undefined, random);
  const initialMetrics = evaluateModel(model, splits.train);
  const initialLoss = initialMetrics.meanLoss;

  let currentLoss = initialLoss;

  // Training loop over epochs
  for (let epoch = 0; epoch < cfg.epochs; epoch++) {
    // Shuffle train split
    const shuffled = [...splits.train];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }

    for (let i = 0; i < shuffled.length; i += cfg.batchSize) {
      const batch = shuffled.slice(i, i + cfg.batchSize).map((s) => ({
        features: s.features,
        targetQual: s.qualifiedLabel,
        targetRoles: s.roleLabels,
      }));
      currentLoss = model.trainStep(batch, cfg.learningRate);
    }
  }

  const finalLoss = currentLoss;
  const trainMetrics = evaluateModel(model, splits.train);
  const devMetrics = evaluateModel(model, splits.dev);
  const evalMetrics = evaluateModel(model, splits.eval);

  const sha256 = model.getSha256();
  const candidate: PromotionCandidate = {
    modelWeights: model.weights,
    metrics: devMetrics,
    sha256,
    createdAt: new Date().toISOString(),
  };

  let checkpointPath: string | undefined;
  if (cfg.outputDir) {
    fs.mkdirSync(cfg.outputDir, { recursive: true });
    checkpointPath = path.join(cfg.outputDir, `checkpoint-${sha256.slice(0, 8)}.json`);
    fs.writeFileSync(
      checkpointPath,
      JSON.stringify(
        {
          weights: model.weights,
          metrics: devMetrics,
          sha256,
          config: cfg,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  const gate = new PromotionGate();
  const promotionResult = gate.evaluateCandidate(candidate);

  return {
    epochsCompleted: cfg.epochs,
    initialLoss: Math.round(initialLoss * 1000) / 1000,
    finalLoss: Math.round(finalLoss * 1000) / 1000,
    lossReduced: finalLoss < initialLoss,
    trainMetrics,
    devMetrics,
    evalMetrics,
    checkpointPath,
    candidate,
    promotionResult,
  };
}
