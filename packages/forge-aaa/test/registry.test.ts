import { describe, expect, it } from "vitest";
import { FORGE_AAA_SEED_CANDIDATES, ForgeAaaRegistry } from "../src/index.js";

describe("ForgeAAA registry", () => {
  it("seeds named leads as UNAVAILABLE — no provider identity is invented", () => {
    const registry = new ForgeAaaRegistry();
    for (const id of ["lead/gpt-6.1-sol", "lead/claude-opus-5.5"]) {
      const entry = registry.entry(id);
      expect(entry?.classification).toBe("UNAVAILABLE");
      expect(entry?.candidate.provider).toBeUndefined();
    }
    expect(registry.eligibleLeads()).toHaveLength(0);
  });

  it("refuses promotion without executed+passed evidence", () => {
    const registry = new ForgeAaaRegistry();
    expect(() => registry.recordQualification({
      candidateId: "tool/blender-adapter", at: new Date().toISOString(),
      executed: false, passed: true, operation: "probe", outcome: "VERIFIED_AVAILABLE", detail: "synthetic",
    })).toThrowError(/executed\+passed/);
    expect(registry.effectiveClassification("tool/blender-adapter")).toBe("EXPERIMENTAL");
  });

  it("promotes EXPERIMENTAL → INTEGRATED only on real executed evidence", () => {
    const registry = new ForgeAaaRegistry();
    registry.recordQualification({
      candidateId: "tool/blender-adapter", at: new Date().toISOString(),
      executed: true, passed: true, operation: "blender-headless-probe", outcome: "INTEGRATED", detail: "blender --version parsed + scene report", evidenceRef: "sha256:abc",
    });
    expect(registry.effectiveClassification("tool/blender-adapter")).toBe("INTEGRATED");
    expect(registry.eligibleFor("forge-modeler").map((e) => e.candidate.id)).toContain("tool/blender-adapter");
  });

  it("demotion requires executed evidence; rejection stays sticky", () => {
    const registry = new ForgeAaaRegistry();
    registry.recordQualification({
      candidateId: "svc/meshy", at: new Date().toISOString(), executed: true, passed: false,
      operation: "probe", outcome: "INCOMPATIBLE", detail: "API schema mismatch",
    });
    expect(registry.effectiveClassification("svc/meshy")).toBe("INCOMPATIBLE");
    registry.register({ ...FORGE_AAA_SEED_CANDIDATES.find((c) => c.id === "svc/meshy")!, classification: "EXPERIMENTAL" });
    // Re-register does not erase the executed INCOMPATIBLE evidence.
    expect(registry.effectiveClassification("svc/meshy")).toBe("INCOMPATIBLE");
  });

  it("snapshots and restores qualifications only — seeds stay in code", () => {
    const registry = new ForgeAaaRegistry();
    registry.recordQualification({
      candidateId: "tool/unreal-adapter", at: new Date().toISOString(), executed: true, passed: true,
      operation: "detect", outcome: "VERIFIED_AVAILABLE", detail: "UE 4.27.2 detected",
    });
    const snap = registry.snapshot();
    const restored = new ForgeAaaRegistry();
    restored.restore(snap);
    expect(restored.effectiveClassification("tool/unreal-adapter")).toBe("VERIFIED_AVAILABLE");
    expect(snap.registered).toHaveLength(0);
  });
});
