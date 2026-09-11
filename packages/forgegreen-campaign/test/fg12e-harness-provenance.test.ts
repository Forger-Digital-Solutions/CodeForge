import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeFg12eHarnessId, FG12E_BENCHMARK_HARNESS_FILES, freezeFg12eIdentity } from "../src/fg12e/harness-identity.js";
import { CAMPAIGN_HARNESS_FILES, computeCampaignHarnessId, loadCertifiedSourceState } from "../src/source-state.js";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

describe("FG-12E harness provenance", () => {
  it("every FG-12E harness file exists and is a benchmark/harness file, never a production file", () => {
    for (const file of FG12E_BENCHMARK_HARNESS_FILES) {
      expect(fs.existsSync(path.join(repoRoot, file)), file).toBe(true);
      expect(file.startsWith("packages/forgegreen-campaign/src/fg12e/") || file === "scripts/forgegreen-fg12e-performance-trial.mjs", file).toBe(true);
    }
    // Covers definitions, pairing, timing, statistics, orchestration, and report generation.
    for (const required of ["workloads.ts", "pair-runner.ts", "timing.ts", "break-even.ts", "report.ts", "forgegreen-fg12e-performance-trial.mjs"]) {
      expect(FG12E_BENCHMARK_HARNESS_FILES.some((f) => f.endsWith(required)), required).toBe(true);
    }
  });

  it("the FG-12E harness id is deterministic and distinct from the FG-12D campaign harness id", () => {
    const a = computeFg12eHarnessId(repoRoot);
    const b = computeFg12eHarnessId(repoRoot);
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect(a.id).not.toBe(computeCampaignHarnessId(repoRoot).id);
    // FG-12E never widens the FG-12D harness file list (its id must stay byte-stable).
    expect(CAMPAIGN_HARNESS_FILES.some((f) => f.includes("fg12e"))).toBe(false);
  });

  it("freezing the FG-12E identity re-verifies the certified Candidate D source-state and does not change it", () => {
    const identity = freezeFg12eIdentity(repoRoot);
    const certified = loadCertifiedSourceState(repoRoot);
    expect(identity.certifiedSourceStateId).toBe(certified.sourceStateId);
    expect(certified.materialFiles.some((f) => f.includes("fg12e"))).toBe(false);
    expect(identity.fg12dCampaignHarnessId).toBe(computeCampaignHarnessId(repoRoot).id);
    expect(identity.fg12eHarnessId).toBe(computeFg12eHarnessId(repoRoot).id);
  });
});
