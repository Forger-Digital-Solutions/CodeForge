import { describe, expect, it } from "vitest";
import { CONTEXT_CAPACITY_UNKNOWN, ContextCapacityError, resolveContextCapacity } from "../src/budget.js";

describe("FG-3E model-aware context budget resolution", () => {
  it("[unknown capacity] falls back to the safe role default, never fabricating a model capacity", () => {
    const capacity = resolveContextCapacity({ requestedTokens: 64_000 });
    expect(capacity).toEqual({ maxContextTokens: 64_000, source: "role_default", clampedToModel: false });
  });

  it("[known, smaller than requested] clamps down to the model's real capacity (exact-pin safety: compact, never swap models)", () => {
    const capacity = resolveContextCapacity({ requestedTokens: 64_000, declaredModelContextWindow: 8_000 });
    expect(capacity).toEqual({ maxContextTokens: 8_000, source: "model_catalog", clampedToModel: true });
  });

  it("[known, larger than requested] keeps the requested size — more room is never by itself a reason to use more", () => {
    const capacity = resolveContextCapacity({ requestedTokens: 32_000, declaredModelContextWindow: 1_000_000 });
    expect(capacity).toEqual({ maxContextTokens: 32_000, source: "model_catalog", clampedToModel: false });
  });

  it("[known, exactly equal] is not treated as a clamp", () => {
    const capacity = resolveContextCapacity({ requestedTokens: 16_000, declaredModelContextWindow: 16_000 });
    expect(capacity.clampedToModel).toBe(false);
    expect(capacity.maxContextTokens).toBe(16_000);
  });

  it("[non-finite / zero / negative declared capacity] is treated as unknown, never as a valid clamp target", () => {
    for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const capacity = resolveContextCapacity({ requestedTokens: 20_000, declaredModelContextWindow: bad });
      expect(capacity.source).toBe("role_default");
      expect(capacity.maxContextTokens).toBe(20_000);
    }
  });

  it("[serving window smaller than requested] clamps to the provider's ingest ceiling — a prompt past it is a guaranteed wire rejection, not capacity", () => {
    const capacity = resolveContextCapacity({ requestedTokens: 64_000, servingInputBudget: 5_600 });
    expect(capacity).toEqual({ maxContextTokens: 5_600, source: "serving_window", clampedToModel: false });
  });

  it("[serving window vs model window] the smaller physical constraint binds, and its source is reported", () => {
    // Serving window tighter than the catalog window: serving binds, not the model.
    expect(resolveContextCapacity({ requestedTokens: 64_000, declaredModelContextWindow: 128_000, servingInputBudget: 5_600 }))
      .toEqual({ maxContextTokens: 5_600, source: "serving_window", clampedToModel: false });
    // Model window tighter than the serving window: the model binds as before.
    expect(resolveContextCapacity({ requestedTokens: 64_000, declaredModelContextWindow: 4_000, servingInputBudget: 5_600 }))
      .toEqual({ maxContextTokens: 4_000, source: "model_catalog", clampedToModel: true });
  });

  it("[absent / non-finite serving window] never bounds — unstamped supply is not a fabricated ceiling", () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const capacity = resolveContextCapacity({ requestedTokens: 20_000, servingInputBudget: bad });
      expect(capacity.maxContextTokens).toBe(20_000);
    }
    // A serving budget at or above the request changes nothing.
    expect(resolveContextCapacity({ requestedTokens: 8_000, servingInputBudget: 12_000 }).maxContextTokens).toBe(8_000);
  });

  it("[ContextCapacityError] carries the code, minimum estimate, and available tokens for callers to act on", () => {
    const error = new ContextCapacityError({ minimumEstimatedTokens: 500, availableTokens: 200 });
    expect(error.code).toBe(CONTEXT_CAPACITY_UNKNOWN);
    expect(error.minimumEstimatedTokens).toBe(500);
    expect(error.availableTokens).toBe(200);
    expect(error.message).toContain("200");
    expect(error.message).toContain("500");
  });
});
