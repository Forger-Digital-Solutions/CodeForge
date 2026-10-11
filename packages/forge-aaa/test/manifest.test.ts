import { describe, expect, it } from "vitest";
import { createManifest, sha256Hex, validateManifest } from "../src/index.js";

const valid = {
  assetId: "farmhouse/stair-rail",
  taskId: "aaa-impl-0",
  provenance: { generator: "codeforge-forge-aaa", tool: "blender" as const },
  license: { commercialUse: "yes" as const },
  files: [{ path: "stair-rail.fbx", role: "output" as const, sha256: sha256Hex("data"), bytes: 4 }],
  units: { system: "metric" as const, scale: 1, upAxis: "Z" as const },
  engines: { blender: ["4.5"], unreal: ["4.27"] },
  validation: { checks: [] },
  revision: 1,
};

describe("ForgeAAA asset manifest", () => {
  it("accepts a complete manifest", () => {
    const m = createManifest(valid);
    expect(m.manifestVersion).toBe(1);
    expect(validateManifest(m)).toEqual([]);
  });

  it("rejects manifests missing provenance, files, or units", () => {
    expect(validateManifest({})).toContain("manifestVersion must be 1");
    expect(validateManifest({ ...valid, files: [] })).toContain("files must be a non-empty array");
    expect(validateManifest({ ...valid, files: [{ path: "x", role: "output", sha256: "ZZZ", bytes: 1 }] }).some((e) => e.includes("sha256"))).toBe(true);
    expect(validateManifest({ ...valid, units: { system: "metric", scale: 0, upAxis: "Z" } }).some((e) => e.includes("scale"))).toBe(true);
    expect(validateManifest({ ...valid, license: { commercialUse: "maybe" } }).some((e) => e.includes("license"))).toBe(true);
  });
});
