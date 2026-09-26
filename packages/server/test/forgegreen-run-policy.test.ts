import { describe, expect, it } from "vitest";
import { ForgeGreenRunPolicy, initialForgeGreenLevel } from "../src/forgegreen-run-policy.js";
import { DuplicateActionSupervisor } from "../src/duplicate-suppression.js";

const ALL_ON = { duplicateSuppression: true, toolOutputCompression: true, supersededCompaction: true };
const ALL_OFF = { duplicateSuppression: false, toolOutputCompression: false, supersededCompaction: false };

describe("initialForgeGreenLevel", () => {
  it("defaults a fresh single-context run to FULL", () => {
    expect(initialForgeGreenLevel({ role: "coder" }).level).toBe("FULL");
  });

  it("drops to CONSERVATIVE on inherited evidence or shared state", () => {
    for (const signals of [
      { role: "reviewer" },
      { role: "coder", workstreamScope: "beta" },
      { role: "coder", taskPlan: "[task] ..." },
      { role: "coder", reviewFeedback: "fix the guard" },
      { role: "coder", verificationEvidence: "FAIL: expected 2" },
      { role: "coder", resumeJournal: { journal: {}, replayToolCallIds: [] } },
    ]) {
      const decision = initialForgeGreenLevel({ role: "coder", ...signals });
      expect(decision.level).toBe("CONSERVATIVE");
      expect(decision.reasonCodes.length).toBeGreaterThan(0);
    }
  });
});

describe("ForgeGreenRunPolicy", () => {
  it("FULL permits every control and completed-response dedup", () => {
    const policy = ForgeGreenRunPolicy.forRun({ role: "explorer" }, ALL_ON);
    expect(policy.runsDuplicateClassifier()).toBe(true);
    expect(policy.replaysDuplicates()).toBe(true);
    expect(policy.compressesToolOutput()).toBe(true);
    expect(policy.compactsSuperseded()).toBe(true);
    expect(policy.modelDedupeMode()).toBe("full");
  });

  it("CONSERVATIVE keeps classifier + compression but forbids replays", () => {
    const policy = ForgeGreenRunPolicy.forRun({ role: "reviewer" }, ALL_ON);
    expect(policy.runsDuplicateClassifier()).toBe(true);
    expect(policy.replaysDuplicates()).toBe(false);
    expect(policy.compressesToolOutput()).toBe(true);
    expect(policy.compactsSuperseded()).toBe(true);
    expect(policy.modelDedupeMode()).toBe("inflight");
  });

  it("OFF reproduces the disabled arm exactly", () => {
    const policy = ForgeGreenRunPolicy.forRun({ role: "reviewer" }, ALL_ON);
    policy.escalate("no_effect_write", "x");
    policy.escalate("provider_failover", "y");
    expect(policy.currentLevel).toBe("OFF");
    expect(policy.runsDuplicateClassifier()).toBe(false);
    expect(policy.compressesToolOutput()).toBe(false);
    expect(policy.compactsSuperseded()).toBe(false);
    expect(policy.modelDedupeMode()).toBe("off");
  });

  it("escalation is monotonic and recorded", () => {
    const policy = ForgeGreenRunPolicy.forRun({ role: "explorer" }, ALL_ON);
    expect(policy.currentLevel).toBe("FULL");
    policy.escalate("output_truncated", "finishReason=length");
    expect(policy.currentLevel).toBe("CONSERVATIVE");
    policy.escalate("provider_failover", "a/b -> c/d");
    expect(policy.currentLevel).toBe("OFF");
    policy.escalate("no_effect_write", "ignored");
    const snap = policy.snapshot();
    expect(snap.level).toBe("OFF");
    expect(snap.escalations).toHaveLength(2);
    expect(snap.escalations[0]?.from).toBe("FULL");
    expect(snap.escalations[0]?.to).toBe("CONSERVATIVE");
  });

  it("dedupeEpoch bumps on each escalation so cached answers cannot replay across a signal", () => {
    const policy = ForgeGreenRunPolicy.forRun({ role: "coder" }, ALL_ON);
    const epoch0 = policy.dedupeEpoch();
    policy.escalate("model_response_unusable", "empty stop");
    expect(policy.dedupeEpoch()).toBe(epoch0 + 1);
  });

  it("the static ceiling is never overridden by policy level", () => {
    const policy = ForgeGreenRunPolicy.forRun({ role: "explorer" }, ALL_OFF);
    expect(policy.runsDuplicateClassifier()).toBe(false);
    expect(policy.compressesToolOutput()).toBe(false);
    expect(policy.compactsSuperseded()).toBe(false);
  });
});

describe("conservative duplicate classification", () => {
  const identity = { tool: "read_file", canonicalArguments: { path: "a.ts" } };

  it("replay:false executes the read, still bounds identical repeats", () => {
    const sup = new DuplicateActionSupervisor();
    expect(sup.classify(identity).action).toBe("execute");
    sup.recordReadResult(identity, "contents", true, "exec-1");
    // First repeat: suppression-eligible, but conservative policy executes it.
    const second = sup.classify(identity, { replay: false });
    expect(second.action).toBe("execute");
    expect("suppressedDuplicate" in second && second.suppressedDuplicate).toBe(true);
    expect(sup.metrics.duplicateActionsSuppressed).toBe(0);
    // Second repeat still escalates — the no-progress bound survives without replay.
    const third = sup.classify(identity, { replay: false });
    expect(third.action).toBe("escalate");
    expect(sup.metrics.noProgressEscalations).toBe(1);
  });

  it("replay:true replays once then escalates (unchanged FULL behavior)", () => {
    const sup = new DuplicateActionSupervisor();
    sup.classify(identity);
    sup.recordReadResult(identity, "contents", true, "exec-1");
    expect(sup.classify(identity).action).toBe("suppress");
    expect(sup.metrics.duplicateActionsSuppressed).toBe(1);
    expect(sup.classify(identity).action).toBe("escalate");
  });
});
