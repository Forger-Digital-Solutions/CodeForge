import { describe, it, expect } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { ForgeRouter } from "@codeforge/router";
import {
  NormalizedModelRegistry,
  discoverAndVerifyFree,
  recordFromLive,
  type ModelsDevDoc,
  type LiveModelInfo,
} from "../src/index.js";

const NOW = new Date("2026-08-29T12:00:00Z");
const now = () => NOW;

function registryWithSnapshot(): NormalizedModelRegistry {
  const reg = new NormalizedModelRegistry({ now });
  reg.loadDoc(
    {
      openrouter: {
        id: "openrouter",
        api: "https://openrouter.ai/api/v1",
        models: {
          "z-ai/glm-5.2:free": { id: "z-ai/glm-5.2:free", name: "GLM 5.2 (free)", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 200000 }, cost: { input: 0, output: 0 } },
          "paid/model": { id: "paid/model", tool_call: true, limit: { context: 8000 }, cost: { input: 1, output: 2 } },
        },
      },
    } as ModelsDevDoc,
    "live",
    NOW.toISOString(),
  );
  return reg;
}

describe("Free model discovery + verification (connected provider)", () => {
  it("verifies $0 models from a live connected catalog and makes them Auto-routable", () => {
    const reg = registryWithSnapshot();
    const fw = new ForgeZero({ context: { now } });

    const live: LiveModelInfo[] = [
      { modelId: "z-ai/glm-5.2:free", isFree: true, contextWindow: 200000, toolCalling: true },
      { modelId: "paid/model", isFree: false },
    ];
    const result = discoverAndVerifyFree(reg, "openrouter", live, { now });
    expect(result.verifiedCount).toBe(1);
    for (const rec of result.records) fw.register(rec);

    const eligible = fw.eligibleModels();
    expect(eligible.map((m) => m.modelId)).toEqual(["z-ai/glm-5.2:free"]);
    expect(eligible[0]!.freeStatus).toBe("verified_free");

    const router = new ForgeRouter({ firewall: fw });
    const decision = router.route({ taskType: "coding", estimatedContextTokens: 8000, requiredCapabilities: ["coding"] });
    expect(decision!.model.modelId).toBe("z-ai/glm-5.2:free");
  });

  it("a free candidate is NOT eligible until discovery verifies it live", () => {
    const reg = registryWithSnapshot();
    const fw = new ForgeZero({ context: { now } });
    // Register the candidate straight from facts (freeStatus unknown) → not eligible.
    const candidate = reg.toFreeModelRecord(reg.get("openrouter", "z-ai/glm-5.2:free")!);
    fw.register(candidate);
    expect(fw.eligibleModels()).toHaveLength(0);
    expect(candidate.freeStatus).toBe("unknown");
  });

  it("discovers newly-appeared free models not present in the snapshot", () => {
    const reg = registryWithSnapshot();
    const live: LiveModelInfo[] = [{ modelId: "brand-new/model:free", isFree: true, contextWindow: 64000, toolCalling: true }];
    const result = discoverAndVerifyFree(reg, "openrouter", live, { now });
    expect(result.verifiedCount).toBe(1);
    expect(result.records[0]!.modelId).toBe("brand-new/model:free");
    expect(result.records[0]!.freeStatus).toBe("verified_free");
  });

  it("recordFromLive classifies a gateway $0 model as FREE_ROUTED", () => {
    const rec = recordFromLive("openrouter", { modelId: "x/y:free", isFree: true, contextWindow: 40000 });
    expect(rec.accessClass).toBe("FREE_ROUTED");
    expect(rec.capabilities.longContext).toBe(true);
  });
});
