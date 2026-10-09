import { describe, expect, it } from "vitest";
import { createProviderAdapterFromDefinition } from "@codeforge/providers";
import { getProviderDefinition } from "../src/provider-definitions.js";

describe("SambaNova production Free supply boundaries", () => {
  it("limits the documented Free allowance to the three production Free models", () => {
    expect(getProviderDefinition("sambanova")?.freeAccess).toMatchObject({ spillover: "ACCOUNT_DEPENDENT", allowanceScope: "allowlist",
      allowanceModels: ["DeepSeek-V3.1", "Meta-Llama-3.3-70B-Instruct", "gpt-oss-120b"] });
  });

  it("excludes evaluation-only models even when their IDs contain no preview label", async () => {
    const adapter = createProviderAdapterFromDefinition(getProviderDefinition("sambanova")!, { apiKey: "fixture-key", fetchFn: async () => new Response(JSON.stringify({ data: [
      { id: "DeepSeek-V3.1" }, { id: "gpt-oss-120b" }, { id: "DeepSeek-V3.2" }, { id: "gemma-4-31B-it" }, { id: "unknown-new-model" },
    ] }), { status: 200 }) });
    expect((await adapter!.listModels()).map(model => model.modelId)).toEqual(["DeepSeek-V3.1", "gpt-oss-120b"]);
  });
});
