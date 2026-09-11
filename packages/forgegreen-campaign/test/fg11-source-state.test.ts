import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { computeCampaignHarnessId, computeContentStateId, loadCertifiedSourceState, verifyCertifiedSourceState } from "../src/source-state.js";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

describe("FG-11 source-state / campaign-harness identity", () => {
  it("is deterministic for the same file content", () => {
    const a = computeContentStateId(repoRoot, ["packages/forgegreen-campaign/src/policy.ts"]);
    const b = computeContentStateId(repoRoot, ["packages/forgegreen-campaign/src/policy.ts"]);
    expect(a.id).toBe(b.id);
  });

  it("changes when a material file's content changes", () => {
    const cleanupDirs: string[] = [];
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg11-source-state-"));
      cleanupDirs.push(dir);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "fg11@test.local"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "FG11"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
      const before = computeContentStateId(dir, ["a.ts"]);
      fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 2;\n");
      const after = computeContentStateId(dir, ["a.ts"]);
      expect(after.id).not.toBe(before.id);
    } finally {
      for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not change for an unrelated file outside the material set", () => {
    const cleanupDirs: string[] = [];
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg11-source-state-unrelated-"));
      cleanupDirs.push(dir);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
      fs.writeFileSync(path.join(dir, "unrelated.ts"), "export const u = 1;\n");
      const before = computeContentStateId(dir, ["a.ts"]);
      fs.writeFileSync(path.join(dir, "unrelated.ts"), "export const u = 2;\n");
      const after = computeContentStateId(dir, ["a.ts"]);
      expect(after.id).toBe(before.id);
    } finally {
      for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the live repository currently matches the certified source-state document", () => {
    const certified = loadCertifiedSourceState(repoRoot);
    const result = verifyCertifiedSourceState(repoRoot, certified);
    expect(result.stable).toBe(true);
    expect(result.changedFiles).toEqual([]);
  });

  it("computes a stable campaign-harness id over the harness files listed in CAMPAIGN_HARNESS_FILES", () => {
    const a = computeCampaignHarnessId(repoRoot);
    const b = computeCampaignHarnessId(repoRoot);
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
  });
});
