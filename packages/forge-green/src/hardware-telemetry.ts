import type { SustainabilityConfidence } from "./sustainability-types.js";

/**
 * FG-8 hardware telemetry interface. Interface + null implementation ONLY in this phase — no
 * `nvidia-smi`/ROCm process spawning, no polling loop. CodeForge must not depend on the current
 * developer's hardware to certify FG-8: `NullHardwareTelemetryAdapter` is the default and always
 * reports `INSUFFICIENT_DATA`, which is the honest state absent a real adapter.
 */
export interface HardwareTelemetrySample {
  cpuUsagePercent: number | undefined;
  gpuUtilizationPercent: number | undefined;
  gpuMemoryUsedBytes: number | undefined;
  powerDrawWatts: number | undefined;
  acceleratorIdentity: string | undefined;
  confidence: SustainabilityConfidence;
  sourceType: "measured" | "unavailable";
  sampledAt: string;
}

export interface HardwareTelemetryAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  sample(): Promise<HardwareTelemetrySample>;
}

/** Default adapter. Always returns `INSUFFICIENT_DATA` for every field — never invents a value.
 * Future adapters (NVIDIA `nvidia-smi`, AMD ROCm-SMI, generic CPU accounting) implement the same
 * interface; swapping the adapter never changes historical receipts, which persist the adapter
 * id/version they were sampled with. */
export class NullHardwareTelemetryAdapter implements HardwareTelemetryAdapter {
  readonly adapterId = "null";
  readonly adapterVersion = "1";

  async sample(): Promise<HardwareTelemetrySample> {
    return {
      cpuUsagePercent: undefined,
      gpuUtilizationPercent: undefined,
      gpuMemoryUsedBytes: undefined,
      powerDrawWatts: undefined,
      acceleratorIdentity: undefined,
      confidence: "INSUFFICIENT_DATA",
      sourceType: "unavailable",
      sampledAt: new Date().toISOString(),
    };
  }
}

export function createNullHardwareTelemetryAdapter(): HardwareTelemetryAdapter {
  return new NullHardwareTelemetryAdapter();
}
