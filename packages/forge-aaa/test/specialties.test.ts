import { describe, expect, it } from "vitest";
import { classifyGoalSpecialties, FORGE_AAA_SPECIALTIES } from "../src/index.js";

describe("ForgeAAA specialties", () => {
  it("defines exactly the twelve logical specialists", () => {
    expect(FORGE_AAA_SPECIALTIES).toHaveLength(12);
    expect(new Set(FORGE_AAA_SPECIALTIES.map((s) => s.id)).size).toBe(12);
    const names = FORGE_AAA_SPECIALTIES.map((s) => s.displayName);
    for (const expected of ["ForgeArchitect", "ForgeModeler", "ForgeMaterial", "ForgeWorld", "ForgeAtmosphere", "ForgeCharacter", "ForgeGameplay", "ForgeSimulation", "ForgeAudio", "ForgeCinematic", "ForgeOptimizer", "ForgeVerify"]) {
      expect(names).toContain(expected);
    }
  });

  it("maps every specialty onto an existing orchestrator role", () => {
    const valid = new Set(["PLANNER", "CODER", "REVIEWER", "EXPLORER", "TESTER", "LEAD"]);
    for (const s of FORGE_AAA_SPECIALTIES) expect(valid.has(s.rosterRole)).toBe(true);
  });

  it("classifies goals onto ranked specialties", () => {
    expect(classifyGoalSpecialties("fix the farmhouse stair geometry and collision in the model")[0]).toBeDefined();
    expect(classifyGoalSpecialties("repair broken stair mesh collision")).toContain("forge-modeler");
    expect(classifyGoalSpecialties("design the economy simulation")[0]).toBe("forge-simulation");
    expect(classifyGoalSpecialties("tweak the weather and lighting")).toContain("forge-atmosphere");
  });

  it("falls back to architecture for unclassifiable goals", () => {
    expect(classifyGoalSpecialties("zzzz qqqq")).toEqual(["forge-architect"]);
  });
});
