import crypto from "node:crypto";
import type { EightBitRole } from "../types.js";

/**
 * 8-Bit Roster Specialist Neural Classifier & Ranker (R1 spec §29–§31).
 *
 * Lightweight compact neural specialist for fast local inference and training.
 * Architecture:
 * - Input: 13 normalized features
 * - Hidden Layer: Dense (16 units) + ReLU
 * - Output Head 1: Qualification probability (1 unit, Sigmoid)
 * - Output Head 2: Role scores (9 units, Sigmoid)
 */

export const ROLE_KEYS: readonly EightBitRole[] = [
  "CODER",
  "REASONER",
  "PLANNER",
  "REVIEWER",
  "FAST_WORKER",
  "LONG_CONTEXT",
  "VISION",
  "TOOL_AGENT",
  "ANALYST",
] as const;

export interface ModelWeights {
  version: string;
  inputDim: number;
  hiddenDim: number;
  w1: number[][]; // [hiddenDim][inputDim]
  b1: number[];   // [hiddenDim]
  wQual: number[]; // [hiddenDim]
  bQual: number;
  wRoles: number[][]; // [numRoles][hiddenDim]
  bRoles: number[];   // [numRoles]
}

export interface ForwardOutput {
  hidden: number[];
  hiddenPreAct: number[];
  qualificationProb: number;
  roleScores: Record<EightBitRole, number>;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x))));
}

function relu(x: number): number {
  return Math.max(0, x);
}

function reluGrad(x: number): number {
  return x > 0 ? 1 : 0;
}

export class RosterSpecialistModel {
  public weights: ModelWeights;
  private readonly random: () => number;

  constructor(weights?: ModelWeights, random: () => number = Math.random) {
    this.random = random;
    if (weights) {
      this.weights = weights;
    } else {
      this.weights = this.initWeights(13, 16);
    }
  }

  private initWeights(inputDim: number, hiddenDim: number): ModelWeights {
    // Xavier / He initialization
    const scale1 = Math.sqrt(2 / inputDim);
    const w1 = Array.from({ length: hiddenDim }, () =>
      Array.from({ length: inputDim }, () => (this.random() * 2 - 1) * scale1),
    );
    const b1 = Array.from({ length: hiddenDim }, () => 0.01);

    const scaleQual = Math.sqrt(2 / hiddenDim);
    const wQual = Array.from({ length: hiddenDim }, () => (this.random() * 2 - 1) * scaleQual);
    const bQual = 0;

    const wRoles = Array.from({ length: ROLE_KEYS.length }, () =>
      Array.from({ length: hiddenDim }, () => (this.random() * 2 - 1) * scaleQual),
    );
    const bRoles = Array.from({ length: ROLE_KEYS.length }, () => 0.01);

    return {
      version: "8bit-specialist-v1",
      inputDim,
      hiddenDim,
      w1,
      b1,
      wQual,
      bQual,
      wRoles,
      bRoles,
    };
  }

  forward(features: number[]): ForwardOutput {
    const { inputDim, hiddenDim, w1, b1, wQual, bQual, wRoles, bRoles } = this.weights;

    // 1. Hidden layer
    const hiddenPreAct = new Array<number>(hiddenDim);
    const hidden = new Array<number>(hiddenDim);
    for (let h = 0; h < hiddenDim; h++) {
      let sum = b1[h]!;
      const row = w1[h]!;
      for (let i = 0; i < inputDim; i++) {
        sum += row[i]! * (features[i] ?? 0);
      }
      hiddenPreAct[h] = sum;
      hidden[h] = relu(sum);
    }

    // 2. Qualification head
    let qualPreAct = bQual;
    for (let h = 0; h < hiddenDim; h++) {
      qualPreAct += wQual[h]! * hidden[h]!;
    }
    const qualificationProb = sigmoid(qualPreAct);

    // 3. Role heads
    const roleScores: Record<string, number> = {};
    for (let r = 0; r < ROLE_KEYS.length; r++) {
      let rSum = bRoles[r]!;
      const rRow = wRoles[r]!;
      for (let h = 0; h < hiddenDim; h++) {
        rSum += rRow[h]! * hidden[h]!;
      }
      roleScores[ROLE_KEYS[r]!] = sigmoid(rSum);
    }

    return {
      hidden,
      hiddenPreAct,
      qualificationProb,
      roleScores: roleScores as Record<EightBitRole, number>,
    };
  }

  /**
   * One gradient step on a batch of samples.
   * Returns mean loss for the batch.
   */
  trainStep(
    samples: Array<{ features: number[]; targetQual: number; targetRoles: Record<EightBitRole, number> }>,
    lr = 0.01,
  ): number {
    const { inputDim, hiddenDim, w1, b1, wQual, bQual, wRoles, bRoles } = this.weights;
    let totalLoss = 0;

    // Accumulators for gradients
    const gradW1 = Array.from({ length: hiddenDim }, () => Array.from({ length: inputDim }, () => 0));
    const gradB1 = Array.from({ length: hiddenDim }, () => 0);
    const gradWQual = Array.from({ length: hiddenDim }, () => 0);
    let gradBQual = 0;
    const gradWRoles = Array.from({ length: ROLE_KEYS.length }, () => Array.from({ length: hiddenDim }, () => 0));
    const gradBRoles = Array.from({ length: ROLE_KEYS.length }, () => 0);

    for (const sample of samples) {
      const out = this.forward(sample.features);

      // BCE loss for qualification: -y*log(p) - (1-y)*log(1-p)
      const p = Math.max(1e-7, Math.min(1 - 1e-7, out.qualificationProb));
      const qualLoss = -(sample.targetQual * Math.log(p) + (1 - sample.targetQual) * Math.log(1 - p));

      // MSE loss for roles
      let roleLoss = 0;
      for (const role of ROLE_KEYS) {
        const pred = out.roleScores[role];
        const target = sample.targetRoles[role] ?? 0;
        roleLoss += (pred - target) ** 2;
      }

      totalLoss += qualLoss + roleLoss;

      // Backprop: dL/d(qualPreAct) = p - target
      const dQualPreAct = p - sample.targetQual;
      gradBQual += dQualPreAct;
      for (let h = 0; h < hiddenDim; h++) {
        gradWQual[h] = (gradWQual[h] ?? 0) + dQualPreAct * (out.hidden[h] ?? 0);
      }

      // Backprop for roles: dL/d(rPreAct) = 2*(pred - target) * pred * (1 - pred)
      const dRolePreAct = new Array<number>(ROLE_KEYS.length);
      for (let r = 0; r < ROLE_KEYS.length; r++) {
        const role = ROLE_KEYS[r]!;
        const pred = out.roleScores[role] ?? 0;
        const target = sample.targetRoles[role] ?? 0;
        const dPred = 2 * (pred - target);
        const dPre = dPred * pred * (1 - pred);
        dRolePreAct[r] = dPre;
        gradBRoles[r] = (gradBRoles[r] ?? 0) + dPre;
        const gradWRow = gradWRoles[r];
        if (gradWRow) {
          for (let h = 0; h < hiddenDim; h++) {
            gradWRow[h] = (gradWRow[h] ?? 0) + dPre * (out.hidden[h] ?? 0);
          }
        }
      }

      // Backprop into hidden layer
      for (let h = 0; h < hiddenDim; h++) {
        let dHidden = dQualPreAct * (wQual[h] ?? 0);
        for (let r = 0; r < ROLE_KEYS.length; r++) {
          const wRoleRow = wRoles[r];
          dHidden += (dRolePreAct[r] ?? 0) * (wRoleRow?.[h] ?? 0);
        }
        const dHiddenPreAct = dHidden * reluGrad(out.hiddenPreAct[h] ?? 0);
        gradB1[h] = (gradB1[h] ?? 0) + dHiddenPreAct;
        const gradW1Row = gradW1[h];
        if (gradW1Row) {
          for (let i = 0; i < inputDim; i++) {
            gradW1Row[i] = (gradW1Row[i] ?? 0) + dHiddenPreAct * (sample.features[i] ?? 0);
          }
        }
      }
    }

    const m = samples.length;
    // Apply updates
    this.weights.bQual -= (lr * gradBQual) / m;
    for (let h = 0; h < hiddenDim; h++) {
      this.weights.wQual[h] = (this.weights.wQual[h] ?? 0) - (lr * (gradWQual[h] ?? 0)) / m;
      this.weights.b1[h] = (this.weights.b1[h] ?? 0) - (lr * (gradB1[h] ?? 0)) / m;
      const w1Row = this.weights.w1[h];
      const gW1Row = gradW1[h];
      if (w1Row && gW1Row) {
        for (let i = 0; i < inputDim; i++) {
          w1Row[i] = (w1Row[i] ?? 0) - (lr * (gW1Row[i] ?? 0)) / m;
        }
      }
    }

    for (let r = 0; r < ROLE_KEYS.length; r++) {
      this.weights.bRoles[r] = (this.weights.bRoles[r] ?? 0) - (lr * (gradBRoles[r] ?? 0)) / m;
      const wRoleRow = this.weights.wRoles[r];
      const gWRoleRow = gradWRoles[r];
      if (wRoleRow && gWRoleRow) {
        for (let h = 0; h < hiddenDim; h++) {
          wRoleRow[h] = (wRoleRow[h] ?? 0) - (lr * (gWRoleRow[h] ?? 0)) / m;
        }
      }
    }

    return totalLoss / m;
  }

  getSha256(): string {
    return crypto.createHash("sha256").update(JSON.stringify(this.weights)).digest("hex");
  }
}
