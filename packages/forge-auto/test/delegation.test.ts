import { describe, expect, it } from "vitest";
import { createDelegationRecord, renderDelegationSummary, type DelegationSpecialist } from "../src/delegation.js";

describe("Forge Auto Delegation Records", () => {
  it("creates operational delegation records with machine-readable reasons only", () => {
    const specialists: DelegationSpecialist[] = [
      {
        seat: "PLANNER",
        role: "architecture_planning",
        providerId: "openrouter",
        modelId: "deepseek-r1:free",
        selectionReasons: ["selected_for_large_context", "selected_for_planner_role"],
      },
      {
        seat: "SWE",
        role: "code_implementation",
        providerId: "groq",
        modelId: "llama-3.3-70b-versatile",
        selectionReasons: ["selected_for_swe_score_92", "selected_for_tool_reliability"],
      },
    ];

    const record = createDelegationRecord({
      task: "Implement Custom AUTO persistence",
      trustDomain: "FORGE_AUTO_FREE",
      rosterRevision: 42,
      classification: {
        kind: "FEATURE",
        complexity: "MODERATE",
        risk: 45,
        verificationBurden: "STANDARD",
      },
      specialists,
      reviewResult: { performed: true, findings: 0, outcome: "CLEAN" },
      verificationResult: { required: true, burden: "STANDARD", outcome: "PASSED" },
    });

    expect(record.recordId).toMatch(/^delegation-/);
    expect(record.handoffId).toMatch(/^handoff-/);
    expect(record.trustDomain).toBe("FORGE_AUTO_FREE");
    expect(record.rosterRevision).toBe(42);
    expect(record.specialists).toHaveLength(2);

    const summary = renderDelegationSummary(record);
    expect(summary).toContain("[FORGE_AUTO_FREE]");
    expect(summary).toContain("roster r42");
    expect(summary).toContain("PLANNER=openrouter::deepseek-r1:free");
    expect(summary).toContain("verification:PASSED");
    // Explicitly verify NO chain-of-thought is present
    expect(summary).not.toContain("think");
  });
});