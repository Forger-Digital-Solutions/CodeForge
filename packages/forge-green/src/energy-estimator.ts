import type { HardwareTelemetrySample } from "./hardware-telemetry.js";
import type {
  CarbonEstimate,
  EnergyEstimate,
  NormalizedTiming,
  NormalizedTokenUsage,
} from "./sustainability-types.js";

/**
 * FG-8 pluggable energy estimation (spec §7/§8). No single hard-coded watts-per-token constant:
 * every estimator is versioned, declares its own methodology/assumptions, and a receipt persists
 * exactly which estimator (id + version) produced its numbers, so swapping the default estimator
 * later never reinterprets an old receipt's numbers under a newer methodology.
 */
export interface EnergyEstimatorInput {
  tokens: NormalizedTokenUsage;
  timing: NormalizedTiming;
  hardware: HardwareTelemetrySample | undefined;
}

export interface EnergyEstimationResult {
  energy: EnergyEstimate;
  carbon: CarbonEstimate;
}

export interface EnergyEstimator {
  readonly estimatorId: string;
  readonly estimatorVersion: string;
  estimate(input: EnergyEstimatorInput): EnergyEstimationResult;
}

/** Default estimator. Missing data must stay missing — never turned into zero. Used whenever no
 * more specific estimator is configured (which is the production default today: OpenRouter free
 * models expose neither accelerator identity nor power-draw telemetry). */
export class InsufficientDataEstimator implements EnergyEstimator {
  readonly estimatorId = "insufficient-data";
  readonly estimatorVersion = "1";

  estimate(): EnergyEstimationResult {
    const base = {
      estimatorId: this.estimatorId,
      estimatorVersion: this.estimatorVersion,
      methodology: "No calibrated energy model is wired to a hardware or provider telemetry source for this run.",
      assumptions: [] as string[],
      hardwareClass: undefined,
      region: undefined,
      confidence: "INSUFFICIENT_DATA" as const,
      sourceType: "unavailable" as const,
    };
    return {
      energy: { ...base, joules: undefined, wattHours: undefined, kilowattHours: undefined },
      carbon: { ...base, gramsCO2e: undefined },
    };
  }
}

/**
 * Deterministic reference estimator — proves the interface is pluggable and testable. NOT wired
 * as the production default and NOT calibrated against measured hardware: it applies a fixed,
 * openly-stated joules-per-token constant purely so a known input always yields a known,
 * reproducible output in tests. Always reports `MODELED_ESTIMATE` confidence, never higher.
 */
export class ReferenceHeuristicEstimator implements EnergyEstimator {
  readonly estimatorId = "reference-heuristic";
  readonly estimatorVersion = "1";

  /** Joules per token — an illustrative placeholder, not a calibrated hardware measurement. */
  private static readonly JOULES_PER_TOKEN = 0.002;
  /** Grams CO2e per watt-hour — a generic illustrative grid-average placeholder. */
  private static readonly GRAMS_CO2E_PER_WATT_HOUR = 0.4;

  estimate(input: EnergyEstimatorInput): EnergyEstimationResult {
    const totalTokens = input.tokens.totalTokens;
    const assumptions = [
      `${ReferenceHeuristicEstimator.JOULES_PER_TOKEN} J/token illustrative constant (not hardware-calibrated)`,
      `${ReferenceHeuristicEstimator.GRAMS_CO2E_PER_WATT_HOUR} gCO2e/Wh illustrative grid-average constant`,
    ];
    const base = {
      estimatorId: this.estimatorId,
      estimatorVersion: this.estimatorVersion,
      methodology: "Fixed illustrative joules-per-token constant applied to total measured tokens. Reference/test estimator only.",
      assumptions,
      hardwareClass: input.hardware?.acceleratorIdentity,
      region: undefined,
      confidence: "MODELED_ESTIMATE" as const,
      sourceType: "estimated" as const,
    };
    if (totalTokens === undefined) {
      return {
        energy: { ...base, joules: undefined, wattHours: undefined, kilowattHours: undefined, confidence: "INSUFFICIENT_DATA", sourceType: "unavailable" },
        carbon: { ...base, gramsCO2e: undefined, confidence: "INSUFFICIENT_DATA", sourceType: "unavailable" },
      };
    }
    const joules = totalTokens * ReferenceHeuristicEstimator.JOULES_PER_TOKEN;
    const wattHours = joules / 3600;
    const kilowattHours = wattHours / 1000;
    const gramsCO2e = wattHours * ReferenceHeuristicEstimator.GRAMS_CO2E_PER_WATT_HOUR;
    return {
      energy: { ...base, joules, wattHours, kilowattHours },
      carbon: { ...base, gramsCO2e },
    };
  }
}

const registry = new Map<string, EnergyEstimator>();

export function registerEnergyEstimator(estimator: EnergyEstimator): void {
  registry.set(estimator.estimatorId, estimator);
}

export function getEnergyEstimator(estimatorId: string): EnergyEstimator | undefined {
  return registry.get(estimatorId);
}

export const DEFAULT_ENERGY_ESTIMATOR_ID = "insufficient-data";

registerEnergyEstimator(new InsufficientDataEstimator());
registerEnergyEstimator(new ReferenceHeuristicEstimator());

export function createDefaultEnergyEstimator(): EnergyEstimator {
  return getEnergyEstimator(DEFAULT_ENERGY_ESTIMATOR_ID) ?? new InsufficientDataEstimator();
}
