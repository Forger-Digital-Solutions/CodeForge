import { describe, it, expect } from "vitest";
import { ContextAssembler, calculateContextBudget, estimateTokens } from "@codeforge/context";

describe("Context Engineering & Boundary Certification (CF-07)", () => {
  it("assembles specialized context for Explorer containing repository map and search entry points", async () => {
    const assembler = new ContextAssembler(32000);
    const assembled = await assembler.assemble({
      role: "explorer",
      goal: "Analyze auth middleware structure",
      workspacePath: "/mock/workspace",
    });

    expect(assembled.rolePrompt).toContain("Explorer child agent");
    expect(assembled.systemPrompt).toContain("UNTRUSTED DATA");
    expect(assembled.contextPrompt).toContain("Goal:\nAnalyze auth middleware structure");
    expect(assembled.tokenEstimate).toBeLessThan(32000);
    expect(assembled.truncated).toBe(false);
  });

  it("assembles specialized context for Planner with discovered evidence and findings", async () => {
    const assembler = new ContextAssembler(32000);
    const assembled = await assembler.assemble({
      role: "planner",
      goal: "Plan refactoring of routing engine",
      workspacePath: "/mock/workspace",
      explorerEvidence: [
        { kind: "file", ref: "src/router.ts", description: "Main routing dispatcher" },
      ],
      findings: [
        { id: "f1", severity: "advisory", category: "architecture", message: "Router has 3 circular dependencies" },
      ],
    });

    expect(assembled.rolePrompt).toContain("Planner child agent");
    expect(assembled.contextPrompt).toContain("Discovered Explorer Evidence");
    expect(assembled.contextPrompt).toContain("src/router.ts");
    expect(assembled.contextPrompt).toContain("Architectural Findings");
    expect(assembled.contextPrompt).toContain("Router has 3 circular dependencies");
  });

  it("assembles specialized context for Coder with task plan and boundary delimiters", async () => {
    const assembler = new ContextAssembler(32000);
    const assembled = await assembler.assemble({
      role: "coder",
      goal: "Implement rate limiter",
      workspacePath: "/mock/workspace",
      taskPlan: "1. Add token bucket\n2. Add middleware test",
    });

    expect(assembled.rolePrompt).toContain("Coder autonomous agent");
    expect(assembled.contextPrompt).toContain("Implementation Plan");
    expect(assembled.contextPrompt).toContain("1. Add token bucket");
  });

  it("assembles specialized context for Reviewer with diff and verification results in complete isolation from Coder private thoughts", async () => {
    const assembler = new ContextAssembler(32000);
    const assembled = await assembler.assemble({
      role: "reviewer",
      goal: "Review rate limiter implementation",
      workspacePath: "/mock/workspace",
      diff: "diff --git a/rate-limit.ts b/rate-limit.ts\n+ export function limit() {}",
      verificationEvidence: "All 14 unit tests passed in 12ms",
    });

    expect(assembled.rolePrompt).toContain("Reviewer child agent");
    expect(assembled.contextPrompt).toContain("Git Diff Under Review");
    expect(assembled.contextPrompt).toContain("Verification Results");
    // Verify untrusted data delimiter
    expect(assembled.contextPrompt).toContain("<<<UNTRUSTED_DATA");
    // Reviewer should not contain coder plan or private prompt
    expect(assembled.contextPrompt).not.toContain("Coder autonomous agent");
  });

  it("strictly enforces token budget and fits context within contextWindow limits", async () => {
    const hugeDiff = "+ line\n".repeat(10000);
    const budget = calculateContextBudget({ contextWindow: 4000 });

    const assembler = new ContextAssembler(4000);
    const assembled = await assembler.assemble({
      role: "reviewer",
      goal: "Review large change",
      workspacePath: "/mock/workspace",
      diff: hugeDiff,
    });

    expect(estimateTokens(assembled.contextPrompt)).toBeLessThanOrEqual(4000);
  });
});
