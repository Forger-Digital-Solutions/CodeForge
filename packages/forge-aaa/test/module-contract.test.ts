import { describe, expect, it } from "vitest";
import { parseModuleContractFromText, validateModuleContract } from "../src/index.js";

const doorContract = {
  contractVersion: 1,
  moduleId: "dtw/building/door-western/v1",
  moduleType: "door",
  displayName: "Western hinged door",
  dimensions: { widthCm: 104, depthCm: 24, heightCm: 214 },
  pivot: { kind: "hinge-left", offsetCm: [-50, 0, 0] },
  sockets: [{ id: "frame", localPosCm: [0, 0, 0], accepts: ["wall"] }],
  collision: { profile: "block-dynamic", blocksWhenClosed: true, passesWhenOpen: true },
  interaction: { interface: "IForgeInteractable", states: ["closed", "opening", "open", "closing"], initialState: "closed" },
  persistence: { identityFrom: "actorName", stateFields: ["state", "yawDeg"], schemaVersion: 1 },
  provenance: { authoredBy: "hand" },
  engines: { unreal: ["4.27"], blender: ["4.5"] },
};

describe("ForgeAAA building module contract", () => {
  it("accepts a complete door contract", () => {
    const c = validateModuleContract(doorContract);
    expect(c.moduleType).toBe("door");
    expect(c.interaction?.initialState).toBe("closed");
    expect(c.persistence?.schemaVersion).toBe(1);
  });

  it("rejects malformed core fields", () => {
    for (const raw of [
      { ...doorContract, contractVersion: 2 },
      { ...doorContract, moduleId: "bad id!" },
      { ...doorContract, moduleType: "spaceship" },
      { ...doorContract, dimensions: { widthCm: 0, depthCm: 24, heightCm: 214 } },
      { ...doorContract, pivot: { kind: "custom" } },
      { ...doorContract, collision: { profile: "ghostly" } },
      { ...doorContract, provenance: { authoredBy: "ai" } },
    ]) {
      expect(() => validateModuleContract(raw)).toThrowError(/FORGE|moduleContract/);
    }
  });

  it("requires interaction.initialState to be a declared state", () => {
    const raw = {
      ...doorContract,
      interaction: { interface: "IForgeInteractable", states: ["a", "b"], initialState: "z" },
    };
    expect(() => validateModuleContract(raw)).toThrowError(/initialState/);
  });

  it("parses a contract out of fenced model output", () => {
    const fenced = `Here is the contract:\n\`\`\`json\n${JSON.stringify(doorContract)}\n\`\`\`\n— done.`;
    const parsed = parseModuleContractFromText(fenced);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.contract.moduleId).toBe(doorContract.moduleId);
  });

  it("rejects output with no JSON object", () => {
    const parsed = parseModuleContractFromText("I cannot produce JSON today.");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("no JSON object");
  });
});
