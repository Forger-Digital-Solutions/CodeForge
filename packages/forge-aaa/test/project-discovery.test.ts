import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertProjectMode, classifyForgeAaaProject, inspectForgeAaaProject } from "../src/index.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-aaa-proj-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return dir;
}

describe("ForgeAAA project discovery", () => {
  it("classifies a missing path as disposable pilot unless explicitly new", async () => {
    const missing = await inspectForgeAaaProject(path.join(os.tmpdir(), "does-not-exist-zzz"));
    expect(missing.exists).toBe(false);
    expect(classifyForgeAaaProject(missing).mode).toBe("PILOT_PROJECT");
    expect(classifyForgeAaaProject(missing, { explicitlyNew: true }).mode).toBe("NEW_PROJECT");
  });

  it("classifies authored content as EXISTING_PROJECT and derives the engine target", async () => {
    const dir = await fixture({
      "Game.uproject": JSON.stringify({ EngineAssociation: "4.27" }),
      "Content/House/SM_Stairs.uasset": "binary-stub",
      "Source/Game/Game.Build.cs": "stub",
    });
    const inspection = await inspectForgeAaaProject(dir);
    expect(inspection.unreal.uprojectFiles).toHaveLength(1);
    expect(inspection.contentSignals.authoredAssetCount).toBeGreaterThan(0);
    const c = classifyForgeAaaProject(inspection);
    expect(c.mode).toBe("EXISTING_PROJECT");
    expect(c.engineTarget).toBe("ue-4.27");
    expect(c.hasAuthoredContent).toBe(true);
    expect(c.protections.some((p) => p.includes("authored"))).toBe(true);
  });

  it("classifies a scaffold-only descriptor directory as PILOT_PROJECT", async () => {
    const dir = await fixture({ "Game.uproject": JSON.stringify({ EngineAssociation: "4.27" }) });
    const c = classifyForgeAaaProject(await inspectForgeAaaProject(dir));
    expect(c.mode).toBe("PILOT_PROJECT");
    expect(c.hasAuthoredContent).toBe(false);
    expect(c.protections.some((p) => p.includes("pilot"))).toBe(true);
  });

  it("keeps a generated-asset pilot as PILOT_PROJECT — produced output is not authorship", async () => {
    const dir = await fixture({
      "Game.uproject": JSON.stringify({ EngineAssociation: "4.27" }),
      "Content/ForgeAAA/SM_Stair.uasset": "generated-by-forgeaaa",
      ".forge-aaa/manifest.json": "{}",
    });
    const inspection = await inspectForgeAaaProject(dir);
    expect(inspection.contentSignals.generatedAssetCount).toBe(1);
    expect(inspection.contentSignals.authoredAssetCount).toBe(0);
    const c = classifyForgeAaaProject(inspection);
    expect(c.mode).toBe("PILOT_PROJECT");
    expect(c.rationale.some((r) => r.includes("ForgeAAA-generated"))).toBe(true);
    // But a real authored asset alongside generated ones still promotes correctly.
    const authored = await fixture({
      "Game.uproject": JSON.stringify({ EngineAssociation: "4.27" }),
      "Content/ForgeAAA/SM_Stair.uasset": "generated-by-forgeaaa",
      "Content/House/SM_Wall.uasset": "human-authored",
    });
    const c2 = classifyForgeAaaProject(await inspectForgeAaaProject(authored));
    expect(c2.mode).toBe("EXISTING_PROJECT");
    expect(c2.hasAuthoredContent).toBe(true);
  });

  it("refuses mutating modes against authored content and vice versa", async () => {
    const authored = await inspectForgeAaaProject(await fixture({ "Content/a.uasset": "x" }));
    expect(() => assertProjectMode(authored, "PILOT_PROJECT")).toThrowError(/forbidden|denied/i);
    const empty = await inspectForgeAaaProject(await fixture({}));
    expect(() => assertProjectMode(empty, "EXISTING_PROJECT")).toThrowError(/refusing/);
  });

  it("detects unreal layout and blend files without touching ignored dirs", async () => {
    const dir = await fixture({
      "Game.uproject": JSON.stringify({ EngineAssociation: "5.4" }),
      "Content/x.uasset": "x",
      "Plugins/P/plugin.txt": "x",
      "Source/x.cpp": "x",
      "assets/house.blend": "x",
      "DerivedDataCache/junk.bin": "x",
      "Intermediate/junk.bin": "x",
    });
    const i = await inspectForgeAaaProject(dir);
    expect(i.unreal.hasContent && i.unreal.hasPlugins && i.unreal.hasSource).toBe(true);
    expect(i.blender.blendFiles).toHaveLength(1);
    expect(classifyForgeAaaProject(i).engineTarget).toBe("ue-5");
  });
});
