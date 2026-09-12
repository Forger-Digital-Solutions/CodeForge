import { describe, expect, it } from "vitest";
import { readZeroUnitEnvironmentCredentials } from "../src/provider-environment.js";

describe("desktop environment provider credentials", () => {
  it("loads only zero-unit provider routes without persisting or exposing values", () => {
    const result = readZeroUnitEnvironmentCredentials({
      OPENROUTER_API_KEY: "openrouter-secret",
      ZHIPU_API_KEY: "zai-secret",
      OPENCODE_API_KEY: "opencode-secret",
      GROQ_API_KEY: "allowance-billing-ambiguous",
      OPENAI_API_KEY: "paid",
    });
    expect(Object.keys(result).sort()).toEqual(["opencode", "openrouter", "zai"]);
    expect(result.openrouter).toBe("openrouter-secret");
    expect(JSON.stringify(result)).not.toContain("allowance-billing-ambiguous");
    expect(JSON.stringify(result)).not.toContain("paid");
  });

  it("rejects empty and overlong environment values", () => {
    expect(readZeroUnitEnvironmentCredentials({ OPENROUTER_API_KEY: "" })).toEqual({});
    expect(readZeroUnitEnvironmentCredentials({ OPENROUTER_API_KEY: "x".repeat(513) })).toEqual({});
  });
});
