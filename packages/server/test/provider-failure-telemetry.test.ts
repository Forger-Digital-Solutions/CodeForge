import { describe, expect, it } from "vitest";
import { createForgeGreenR0TelemetryCollector } from "@codeforge/forge-green";
import { observedProviderFailureCount } from "../src/provider-failure-telemetry.js";

describe("R73 observed provider failure telemetry", () => {
  it("keeps absent inference at zero and unobserved issued inference unknown", () => {
    expect(observedProviderFailureCount(undefined, 0)).toBe(0);
    expect(observedProviderFailureCount(undefined, 1)).toBeNull();
  });

  it("counts actual recorded transport failures independently of the final role result", () => {
    const collector = createForgeGreenR0TelemetryCollector({ runId: "run", sessionId: "session", workspaceId: "workspace" });
    for (const code of ["PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT", "INVALID_TOOL_OUTPUT", "PROVIDER_CONTEXT_LIMIT", "AGENT_CANCELLED", "TOOL_ARGUMENT_INVALID"]) {
      collector.recordProviderFailure({ providerId: "scripted", modelId: "model", routeClass: "test", code });
    }
    expect(observedProviderFailureCount(collector.finalize({ wallTimeMs: 1 }), 4)).toBe(2);
  });

  it("rejects incomplete failure-code observations instead of inventing a zero", () => {
    const collector = createForgeGreenR0TelemetryCollector({ runId: "run", sessionId: "session", workspaceId: "workspace" });
    collector.recordProviderFailure({ providerId: "scripted", modelId: "model", routeClass: "test", code: "PROVIDER_TIMEOUT" });
    const telemetry = collector.finalize({ wallTimeMs: 1 });
    telemetry.providerFailures.failureCodes = [];
    expect(observedProviderFailureCount(telemetry, 1)).toBeNull();
  });
});
