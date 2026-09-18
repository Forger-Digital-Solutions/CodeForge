import { describe, expect, it } from "vitest";
import { observeForgeGreenShadow } from "../src/shadow.js";

describe("R13 ForgeGreen shadow predictor", () => {
  it("labels topology-ablation-derived evidence as simulated and does not change deterministic advice", () => {
    const record = observeForgeGreenShadow({ sessionId: "s", runId: "r", requestedTopology: 4, deterministicRecommendedTopology: 2, initialContextTokens: 12000, finalContextTokens: 9000, toolCallCount: 8 }, { enabled: true });
    expect(record.lineage.provenance).toBe("SIMULATED");
    expect(record.topology.topologyRecommended).toBe(2);
    expect(record.shadowRecommendation?.recommendationKind).toBe("TOPOLOGY");
  });
});
