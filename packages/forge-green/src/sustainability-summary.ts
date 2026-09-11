import { derivedSavingsPercent } from "./sustainability-types.js";
import type { MeasurementStatus, SustainabilityReceipt } from "./sustainability-types.js";

/**
 * FG-8 deterministic run-level summary (spec §10). Never fabricates a percentage or count when
 * the underlying denominator/measurement is undefined — omits the line instead, matching the
 * task's own example: "Energy estimate unavailable — provider accelerator data not exposed."
 */
export interface ForgeGreenSummary {
  receiptId: string;
  measurementStatus: MeasurementStatus;
  headline: string;
  contextLine: string | undefined;
  computeReductionLine: string | undefined;
  energyLine: string;
  lines: string[];
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function generateForgeGreenSummary(receipt: SustainabilityReceipt): ForgeGreenSummary {
  if (receipt.measurementStatus !== "complete") {
    const reason = receipt.measurementFailureReasonCodes.join(", ") || "unknown reason";
    return {
      receiptId: receipt.receiptId,
      measurementStatus: receipt.measurementStatus,
      headline: `Measurement ${receipt.measurementStatus} (${reason})`,
      contextLine: undefined,
      computeReductionLine: undefined,
      energyLine: "Energy estimate unavailable — measurement did not complete.",
      lines: [`ForgeGreen`, `Measurement ${receipt.measurementStatus} (${reason})`],
    };
  }

  const headlineParts: string[] = [];
  if (receipt.tokenAccounting.requestCount !== undefined) {
    headlineParts.push(`${formatCount(receipt.tokenAccounting.requestCount)} model request${receipt.tokenAccounting.requestCount === 1 ? "" : "s"}`);
  }
  if (receipt.tokenAccounting.totalTokens !== undefined) {
    headlineParts.push(`${formatCount(receipt.tokenAccounting.totalTokens)} tokens`);
  }
  if (receipt.routingAccounting.fallbackEvents !== undefined && receipt.routingAccounting.fallbackEvents > 0) {
    headlineParts.push(`${receipt.routingAccounting.fallbackEvents} fallback${receipt.routingAccounting.fallbackEvents === 1 ? "" : "s"}`);
  }
  const headline = headlineParts.length > 0 ? headlineParts.join(" · ") : "No model usage recorded for this run.";

  let contextLine: string | undefined;
  if (receipt.contextAccounting.tokensAvoidedMeasured !== undefined && receipt.contextAccounting.tokensAvoidedMeasured > 0) {
    contextLine = `${formatCount(receipt.contextAccounting.tokensAvoidedMeasured)} context tokens avoided (measured, reused pages)`;
  } else {
    const baselineB = receipt.baselines.find((b) => b.baselineKind === "B_NAIVE_FULL_CONTEXT");
    if (baselineB && baselineB.numerator !== undefined) {
      contextLine = `${formatCount(baselineB.numerator)} context bytes avoided versus naive full-context baseline`;
    }
  }

  let computeReductionLine: string | undefined;
  const baselineWithPercent = receipt.baselines
    .map((b) => ({ b, percent: derivedSavingsPercent(b) }))
    .find((x) => x.percent !== undefined);
  if (baselineWithPercent) {
    computeReductionLine = `Estimated compute reduction vs ${baselineWithPercent.b.baselineKind}: ${String(baselineWithPercent.percent)}% (${baselineWithPercent.b.comparisonBasis}, ${baselineWithPercent.b.confidence})`;
  }

  let energyLine: string;
  if (receipt.energyEstimate.sourceType === "unavailable" || receipt.energyEstimate.kilowattHours === undefined) {
    energyLine = "Energy estimate unavailable — no calibrated hardware/provider telemetry for this run.";
  } else {
    energyLine = `Estimated energy: ${receipt.energyEstimate.kilowattHours.toFixed(6)} kWh (${receipt.energyEstimate.confidence}, ${receipt.energyEstimate.estimatorId}@${receipt.energyEstimate.estimatorVersion})`;
  }

  const lines = ["ForgeGreen", headline];
  if (contextLine) lines.push(contextLine);
  if (computeReductionLine) lines.push(computeReductionLine);
  lines.push(energyLine);

  return {
    receiptId: receipt.receiptId,
    measurementStatus: receipt.measurementStatus,
    headline,
    contextLine,
    computeReductionLine,
    energyLine,
    lines,
  };
}
