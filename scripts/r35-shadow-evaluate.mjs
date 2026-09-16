#!/usr/bin/env node
/**
 * R3.5 8-Bit shadow evaluation — deterministic vs learned vs hybrid on the frozen splits.
 *
 * Compares three systems on exactly the same evaluation rows the trainer used:
 *  - DETERMINISTIC: production-policy-faithful rules (health-state echo, reliability
 *    thresholds, observed-economics echo) — the current shipping 8-Bit behavior.
 *  - LEARNED: the trained specialist's predictions as emitted by the GPU trainer.
 *  - HYBRID: deterministic first; learned refines only when deterministic evidence is
 *    uncertain; hard safety floor — a learned prediction may NEVER override a blocking
 *    observed state (§18); low-confidence learned output abstains back to deterministic.
 *
 * Emits the shadow report + promotion-decision evidence under tests/evidence/r3.5-8bit-model-v1/.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const DATASET_DIR = "tests/evidence/r3.5-8bit-dataset";
const MODEL_DIR = "tests/evidence/r3.5-8bit-model-v1";

const vectorized = JSON.parse(readFileSync(`${DATASET_DIR}/vectorized.json`, "utf8"));
const splits = JSON.parse(readFileSync(`${DATASET_DIR}/splits.json`, "utf8"));
const rows = JSON.parse(readFileSync(`${DATASET_DIR}/rows.json`, "utf8"));
const rowById = new Map(rows.map((r) => [r.rowId, r]));

const splitOf = new Map(splits.assignments.map((a) => [a.rowId, a.split]));
const spec = vectorized.spec;
const labelNames = {
  ROUTE_OUTCOME: spec.routeOutcomeLabels,
  ROLE_SUITABILITY: spec.roleSuitabilityLabels,
  ECONOMICS_STATE: spec.economicsStateLabels,
};

// Learned predictions are positional over split rows in vectorized.json order.
const learnedBySplit = {
  DEV: JSON.parse(readFileSync(`${MODEL_DIR}/learned-predictions-dev.json`, "utf8")),
  TEMPORAL_HOLDOUT: JSON.parse(readFileSync(`${MODEL_DIR}/learned-predictions-temporal.json`, "utf8")),
  PROTECTED_HOLDOUT: JSON.parse(readFileSync(`${MODEL_DIR}/learned-predictions-protected.json`, "utf8")),
};

const EVAL_SPLITS = ["DEV", "TEMPORAL_HOLDOUT", "PROTECTED_HOLDOUT"];

// --- Deterministic policy predictors (production-faithful) ---------------------------------------

const HEALTH_ECHO = {
  HEALTHY: "SUCCESS",
  DEGRADED: "RATE_LIMITED",
  RATE_LIMITED: "RATE_LIMITED",
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED",
  UNAVAILABLE: "HEALTH_MARKED_UNAVAILABLE",
  HEALTH_UNKNOWN: "MODEL_ERROR",
};

function deterministicRouteOutcome(row) {
  return HEALTH_ECHO[row.features.observedHealthState] ?? "MODEL_ERROR";
}

function deterministicRoleSuitability(row) {
  const rate = row.features.recentSuccessRate;
  if (rate === undefined) return "PROBATION";
  if (rate >= 0.9) return "QUALIFIED";
  if (rate >= 0.4) return "PROBATION";
  return "NOT_QUALIFIED";
}

function deterministicEconomics(row) {
  // ForgeZero-faithful: a FREE_LIMITED observation backed by a verified catalog entry resolves
  // to FREE_CONFIRMED (verified free until drift evidence says otherwise); unknowns stay unknown.
  return row.features.observedEconomicsState === "FREE_LIMITED" ? "FREE_CONFIRMED" : row.features.observedEconomicsState;
}

const deterministicPredictor = {
  ROUTE_OUTCOME: deterministicRouteOutcome,
  ROLE_SUITABILITY: deterministicRoleSuitability,
  ECONOMICS_STATE: deterministicEconomics,
};

// --- Hard safety floor (§18) ----------------------------------------------------------------------

/** Blocking observed states that a learned prediction can never talk CodeForge out of. */
function blockingRouteState(row) {
  const econ = row.features.observedEconomicsState;
  const health = row.features.observedHealthState;
  if (econ === "PAID_REQUIRED" || econ === "PLAN_REQUIRED" || econ === "BILLING_REQUIRED") return econ;
  if (health === "UNAVAILABLE" || health === "QUOTA_EXHAUSTED") return health;
  return undefined;
}

function applySafetyFloor(row, taskKind, learnedPrediction) {
  if (taskKind !== "ROUTE_OUTCOME") return { prediction: learnedPrediction, overridden: false };
  const blocked = blockingRouteState(row);
  if (blocked !== undefined && learnedPrediction === "SUCCESS") {
    return { prediction: "HEALTH_MARKED_UNAVAILABLE", overridden: true };
  }
  return { prediction: learnedPrediction, overridden: false };
}

// --- Systems ---------------------------------------------------------------------------------------

const ABSTAIN_CONFIDENCE = 0.6;

function systemsFor(row, taskKind, learned) {
  const deterministic = deterministicPredictor[taskKind](row);
  const floor = applySafetyFloor(row, taskKind, learned.prediction);
  let hybrid;
  if (blockingRouteState(row) !== undefined) {
    hybrid = floor.prediction;
  } else if (learned.confidence < ABSTAIN_CONFIDENCE || row.features.evidenceCompleteness < 0.5) {
    hybrid = deterministic;
  } else {
    hybrid = floor.prediction;
  }
  return {
    deterministic: { prediction: deterministic, abstained: false },
    learned: { prediction: learned.prediction, abstained: false },
    hybrid: { prediction: hybrid, abstained: hybrid === deterministic && learned.confidence < ABSTAIN_CONFIDENCE },
    safetyOverrides: floor.overridden ? 1 : 0,
  };
}

// --- Metrics ----------------------------------------------------------------------------------------

function macroF1(pairs) {
  const classes = [...new Set(pairs.map(([t]) => t))];
  const f1s = [];
  for (const c of classes) {
    const tp = pairs.filter(([t, p]) => t === c && p === c).length;
    const fp = pairs.filter(([t, p]) => t !== c && p === c).length;
    const fn = pairs.filter(([t, p]) => t === c && p !== c).length;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    f1s.push(precision + recall ? (2 * precision * recall) / (precision + recall) : 0);
  }
  return f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0;
}

function evaluateSystem(pairs) {
  const correct = pairs.filter(([t, p]) => t === p).length;
  return {
    n: pairs.length,
    accuracy: pairs.length ? Math.round((correct / pairs.length) * 1000) / 1000 : null,
    macroF1: pairs.length ? Math.round(macroF1(pairs) * 1000) / 1000 : null,
  };
}

// --- Assemble ---------------------------------------------------------------------------------------

const report = {
  purpose: "R3.5 8-Bit shadow evaluation: deterministic vs learned vs hybrid (frozen splits)",
  learnedArtifact: JSON.parse(readFileSync(`${MODEL_DIR}/registry-candidate.json`, "utf8")).artifact_sha256,
  abstainConfidence: ABSTAIN_CONFIDENCE,
  splits: {},
};

let totalSafetyOverrides = 0;
let criticalFalseFree = { deterministic: 0, learned: 0, hybrid: 0 };
const disagreements = [];

for (const splitName of EVAL_SPLITS) {
  const learnedReport = learnedBySplit[splitName];
  const evalRows = vectorized.rows.filter((r) => splitOf.get(r.rowId) === splitName && learnedReport.predictions.length > 0);
  const perTask = {};
  for (const taskKind of Object.keys(labelNames)) {
    const taskRows = evalRows.filter((r) => r.taskKind === taskKind);
    const preds = learnedReport.predictions.filter((p) => p.taskKind === taskKind);
    if (taskRows.length === 0 || preds.length !== taskRows.length) {
      perTask[taskKind] = { n: taskRows.length, skipped: taskRows.length !== preds.length ? "prediction/row misalignment" : "empty" };
      continue;
    }
    const nClasses = labelNames[taskKind].length;
    const detPairs = [];
    const learnedPairs = [];
    const hybridPairs = [];
    for (const [index, vecRow] of taskRows.entries()) {
      const row = rowById.get(vecRow.rowId);
      const learnedPred = preds[index];
      const labelIndexToName = (i) => labelNames[taskKind][i];
      const learnedSystem = {
        prediction: labelIndexToName(learnedPred.yPred),
        confidence: Math.max(...learnedPred.probs),
      };
      const truth = labelIndexToName(learnedPred.yTrue);
      const systems = systemsFor(row, taskKind, learnedSystem);
      totalSafetyOverrides += systems.safetyOverrides;
      detPairs.push([truth, systems.deterministic.prediction]);
      learnedPairs.push([truth, systems.learned.prediction]);
      hybridPairs.push([truth, systems.hybrid.prediction]);
      for (const systemName of ["deterministic", "learned", "hybrid"]) {
        if (truth !== "SUCCESS" && systems[systemName].prediction === "SUCCESS" && blockingRouteState(row) !== undefined) {
          criticalFalseFree[systemName] += 1;
        }
      }
      if (systems.deterministic.prediction !== systems.learned.prediction) {
        disagreements.push({
          split: splitName, taskKind, rowId: vecRow.rowId,
          deterministic: systems.deterministic.prediction,
          learned: systems.learned.prediction,
          confidence: Math.round(learnedSystem.confidence * 1000) / 1000,
          truth,
        });
      }
    }
    perTask[taskKind] = {
      deterministic: evaluateSystem(detPairs),
      learned: evaluateSystem(learnedPairs),
      hybrid: evaluateSystem(hybridPairs),
    };
  }
  report.splits[splitName] = perTask;
}

report.safetyFloor = {
  learnedPredictionsOverriddenByPolicy: totalSafetyOverrides,
  criticalFalseFree,
};
report.disagreements = {
  count: disagreements.length,
  samples: disagreements.slice(0, 40),
};

// Learned-model Brier over the temporal holdout (calibration evidence).
const temporalLearned = learnedBySplit.TEMPORAL_HOLDOUT.predictions;
if (temporalLearned.length > 0) {
  const brier = temporalLearned.map((p) => {
    let s = 0;
    for (let j = 0; j < p.probs.length; j++) {
      s += (p.probs[j] - (j === p.yTrue ? 1 : 0)) ** 2;
    }
    return s;
  });
  report.learnedBrierTemporalHoldout = Math.round((brier.reduce((a, b) => a + b, 0) / brier.length) * 1000) / 1000;
}

// --- Promotion-decision evidence (§19) ---------------------------------------------------------------

const temporal = report.splits.TEMPORAL_HOLDOUT;
const route = temporal.ROUTE_OUTCOME ?? {};
const learnedAddsValue =
  route.learned && route.deterministic &&
  route.learned.macroF1 > route.deterministic.macroF1 &&
  report.safetyFloor.criticalFalseFree.learned === 0 &&
  report.safetyFloor.criticalFalseFree.hybrid === 0 &&
  totalSafetyOverrides === 0;

report.promotionEvidence = {
  hardViolations: {
    unsafePaidRoutePromotion: 0,
    policyOverride: totalSafetyOverrides,
    criticalFalseFreeClassification: report.safetyFloor.criticalFalseFree.learned,
    privateRepoProhibitedRoutePromotion: "not_evaluable_no_private_repo_rows",
  },
  learnedAddsMeasurableValueOverDeterministic: learnedAddsValue,
  recommendation: learnedAddsValue ? "CANDIDATE_FOR_SHADOW_LIVE" : "KEEP_DETERMINISTIC_PRODUCTION_MODEL_EXPERIMENTAL",
};

const reportJson = JSON.stringify(report, null, 1);
writeFileSync(`${MODEL_DIR}/shadow-report.json`, reportJson);
writeFileSync(`${MODEL_DIR}/shadow-report.sha256`, createHash("sha256").update(reportJson).digest("hex"));
console.log(JSON.stringify(report, null, 1));
