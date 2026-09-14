import { describe, expect, it } from "vitest";
import { classifyTask, type TaskSignals } from "../src/classification.js";

describe("Forge Auto Task Classification", () => {
  it("classifies security vulnerabilities with EXTENSIVE verification and 4-specialist plan", () => {
    const signals: TaskSignals = {
      goal: "Security patch: fix authentication bypass and secret leak in token handler",
      changedFileScope: 2,
    };
    const c = classifyTask(signals);
    expect(c.kind).toBe("SECURITY");
    expect(c.verificationBurden).toBe("EXTENSIVE");
    expect(c.risk).toBeGreaterThanOrEqual(70);
    expect(c.specialistPlan).toEqual(["PLANNER", "SWE", "REVIEWER", "VERIFIER"]);
    expect(c.reasons).toContain("classified_security");
    expect(c.reasons).toContain("risk_credential_touching");
  });

  it("classifies test failures with VERIFIER specialist", () => {
    const signals: TaskSignals = {
      goal: "Fix broken vitest tests in session store",
      requiresTests: true,
    };
    const c = classifyTask(signals);
    expect(c.kind).toBe("TEST_FAILURE");
    expect(c.specialistPlan).toContain("VERIFIER");
    expect(c.specialistPlan).toContain("SWE");
  });

  it("classifies architectural refactors as COMPLEX with all 4 specialists", () => {
    const signals: TaskSignals = {
      goal: "Refactor across module boundary and redesign trust domain protocol",
      changedFileScope: 12,
      repositoryFileCount: 3000,
    };
    const c = classifyTask(signals);
    expect(c.kind).toBe("ARCHITECTURE");
    expect(c.complexity).toBe("COMPLEX");
    expect(c.specialistPlan).toHaveLength(4);
    expect(c.specialistPlan).toEqual(["PLANNER", "SWE", "REVIEWER", "VERIFIER"]);
  });

  it("classifies documentation typo as TRIVIAL with LIGHT verification", () => {
    const signals: TaskSignals = {
      goal: "Fix typo in readme docs comment",
      changedFileScope: 1,
    };
    const c = classifyTask(signals);
    expect(c.kind).toBe("DOCUMENTATION");
    expect(c.complexity).toBe("TRIVIAL");
    expect(c.verificationBurden).toBe("LIGHT");
    expect(c.specialistPlan).toEqual(["SWE"]);
  });

  it("classifies bug fix with SWE and REVIEWER", () => {
    const signals: TaskSignals = {
      goal: "Fix race condition deadlock in concurrent worker queue",
      changedFileScope: 3,
    };
    const c = classifyTask(signals);
    expect(c.kind).toBe("BUG_FIX");
    expect(c.specialistPlan).toContain("SWE");
    expect(c.specialistPlan).toContain("REVIEWER");
  });

  it("classifies database schema migration with high risk and verification", () => {
    const signals: TaskSignals = {
      goal: "Implement sqlite schema migration for work_items table",
      changedFileScope: 4,
    };
    const c = classifyTask(signals);
    expect(c.kind).toBe("DATABASE");
    expect(c.specialistPlan).toEqual(["PLANNER", "SWE", "REVIEWER", "VERIFIER"]);
  });
});