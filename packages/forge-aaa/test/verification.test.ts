import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runForgeAaaChecks, sha256Hex, type ForgeAaaCheck } from "../src/index.js";

describe("ForgeAAA verification pipeline", () => {
  it("file checks measure real state — hash, size, existence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-aaa-verify-"));
    const file = path.join(dir, "asset.bin");
    await fs.writeFile(file, "content");
    const report = await runForgeAaaChecks([
      { kind: "file-exists", id: "exists", path: file },
      { kind: "file-hash", id: "hash", path: file, sha256: sha256Hex("content") },
      { kind: "file-hash", id: "hash-bad", path: file, sha256: sha256Hex("other") },
      { kind: "file-max-bytes", id: "size", path: file, maxBytes: 10 },
    ]);
    expect(report.checks.find((c) => c.id === "exists")?.status).toBe("passed");
    expect(report.checks.find((c) => c.id === "hash")?.status).toBe("passed");
    expect(report.checks.find((c) => c.id === "hash-bad")?.status).toBe("failed");
    expect(report.checks.find((c) => c.id === "size")?.status).toBe("passed");
    expect(report.verified).toBe(false);
  });

  it("json field checks inspect actual file content", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-aaa-verify-"));
    const file = path.join(dir, "manifest.json");
    await fs.writeFile(file, JSON.stringify({ assetId: "a", revision: 1 }));
    const report = await runForgeAaaChecks([{ kind: "json-schema-fields", id: "fields", path: file, requiredFields: ["assetId", "revision", "missing"] }]);
    expect(report.checks[0]?.status).toBe("failed");
    expect(report.checks[0]?.detail).toContain("missing");
  });

  it("engine checks report blocked when the adapter is absent — never pass", async () => {
    const report = await runForgeAaaChecks([
      { kind: "blender-scene", id: "b", blendFile: "x.blend" },
      { kind: "unreal-project", id: "u", uprojectPath: "x.uproject" },
    ]);
    expect(report.checks.map((c) => c.status)).toEqual(["blocked", "blocked"]);
    expect(report.verified).toBe(false);
    expect(report.blocked).toBe(2);
  });

  it("custom checks propagate honest outcomes", async () => {
    const checks: ForgeAaaCheck[] = [
      { kind: "custom", id: "c1", description: "ok", run: async () => ({ status: "passed", detail: "measured" }) },
      { kind: "custom", id: "c2", description: "boom", run: async () => { throw new Error("crash"); } },
    ];
    const report = await runForgeAaaChecks(checks);
    expect(report.checks[0]?.status).toBe("passed");
    expect(report.checks[1]?.status).toBe("failed");
  });
});
