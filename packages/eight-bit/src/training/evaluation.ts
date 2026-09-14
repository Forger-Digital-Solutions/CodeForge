import type { RosterSpecialistModel } from "./model.js";
import { ROLE_KEYS } from "./model.js";
import type { TrainingSample } from "./dataset.js";

export interface EvaluationMetrics {
  totalSamples: number;
  qualificationAccuracy: number;
  qualificationPrecision: number;
  qualificationRecall: number;
  qualificationF1: number;
  roleTop1Accuracy: number;
  meanLoss: number;
  avgInferenceMs: number;
}

export function evaluateModel(model: RosterSpecialistModel, samples: TrainingSample[]): EvaluationMetrics {
  if (samples.length === 0) {
    return {
      totalSamples: 0,
      qualificationAccuracy: 0,
      qualificationPrecision: 0,
      qualificationRecall: 0,
      qualificationF1: 0,
      roleTop1Accuracy: 0,
      meanLoss: 0,
      avgInferenceMs: 0,
    };
  }

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let roleTop1Correct = 0;
  let totalLoss = 0;

  const t0 = performance.now();

  for (const s of samples) {
    const out = model.forward(s.features);

    // Binary classification evaluation
    const predBinary = out.qualificationProb >= 0.5 ? 1 : 0;
    if (predBinary === 1 && s.qualifiedLabel === 1) tp++;
    else if (predBinary === 1 && s.qualifiedLabel === 0) fp++;
    else if (predBinary === 0 && s.qualifiedLabel === 0) tn++;
    else if (predBinary === 0 && s.qualifiedLabel === 1) fn++;

    // Role top-1 evaluation: compare highest predicted role against highest target role
    let topTargetRole = ROLE_KEYS[0]!;
    let maxTargetScore = -1;
    let topPredRole = ROLE_KEYS[0]!;
    let maxPredScore = -1;

    for (const r of ROLE_KEYS) {
      const t = s.roleLabels[r] ?? 0;
      if (t > maxTargetScore) {
        maxTargetScore = t;
        topTargetRole = r;
      }
      const p = out.roleScores[r] ?? 0;
      if (p > maxPredScore) {
        maxPredScore = p;
        topPredRole = r;
      }
    }

    if (topPredRole === topTargetRole) roleTop1Correct++;

    // Loss
    const pProb = Math.max(1e-7, Math.min(1 - 1e-7, out.qualificationProb));
    const qualLoss = -(s.qualifiedLabel * Math.log(pProb) + (1 - s.qualifiedLabel) * Math.log(1 - pProb));
    let roleLoss = 0;
    for (const r of ROLE_KEYS) {
      roleLoss += ((out.roleScores[r] ?? 0) - (s.roleLabels[r] ?? 0)) ** 2;
    }
    totalLoss += qualLoss + roleLoss;
  }

  const elapsedMs = performance.now() - t0;
  const n = samples.length;

  const qualificationAccuracy = (tp + tn) / n;
  const qualificationPrecision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const qualificationRecall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const qualificationF1 =
    qualificationPrecision + qualificationRecall > 0
      ? (2 * qualificationPrecision * qualificationRecall) / (qualificationPrecision + qualificationRecall)
      : 0;
  const roleTop1Accuracy = roleTop1Correct / n;

  return {
    totalSamples: n,
    qualificationAccuracy: Math.round(qualificationAccuracy * 1000) / 1000,
    qualificationPrecision: Math.round(qualificationPrecision * 1000) / 1000,
    qualificationRecall: Math.round(qualificationRecall * 1000) / 1000,
    qualificationF1: Math.round(qualificationF1 * 1000) / 1000,
    roleTop1Accuracy: Math.round(roleTop1Accuracy * 1000) / 1000,
    meanLoss: Math.round((totalLoss / n) * 1000) / 1000,
    avgInferenceMs: Math.round((elapsedMs / n) * 1000) / 1000,
  };
}