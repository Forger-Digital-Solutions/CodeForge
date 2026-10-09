import type { ForgeGreenR0Telemetry } from "@codeforge/forge-green";

export function observedProviderFailureCount(telemetry: ForgeGreenR0Telemetry | undefined, modelRequests: number): number | null {
  if (modelRequests === 0) return 0;
  if (!telemetry) return null;
  const accounting = telemetry.providerFailures;
  if (accounting.providerFailures.source !== "OBSERVED" || !Number.isSafeInteger(accounting.providerFailures.value) || accounting.providerFailures.value! < 0) return null;
  let failures = 0;
  let total = 0;
  for (const failure of accounting.failureCodes) {
    if (failure.count.source !== "OBSERVED" || !Number.isSafeInteger(failure.count.value) || failure.count.value! < 0) return null;
    total += failure.count.value ?? 0;
    if (failure.code.startsWith("PROVIDER_") && failure.code !== "PROVIDER_CONTEXT_LIMIT") failures += failure.count.value ?? 0;
  }
  return total === accounting.providerFailures.value ? failures : null;
}
