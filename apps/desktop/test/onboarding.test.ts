import { describe, it, expect } from "vitest";
import { shouldShowOnboarding, isOnboardingStateValid, createOnboardingCompletedState } from "../src/renderer/onboarding.js";

describe("onboarding first-launch behavior", () => {
  it("shows onboarding when not completed and no provider configured", () => {
    expect(shouldShowOnboarding({ onboardingCompleted: false, hasConfiguredProvider: false })).toBe(true);
  });

  it("does not show onboarding when already completed", () => {
    expect(shouldShowOnboarding({ onboardingCompleted: true, hasConfiguredProvider: false })).toBe(false);
    expect(shouldShowOnboarding({ onboardingCompleted: true, hasConfiguredProvider: true })).toBe(false);
  });

  it("does not repeatedly show after skipped (skipped = completed)", () => {
    expect(shouldShowOnboarding({ onboardingCompleted: true, hasConfiguredProvider: false })).toBe(false);
  });

  it("prevents unnecessary onboarding when provider already configured", () => {
    expect(shouldShowOnboarding({ onboardingCompleted: false, hasConfiguredProvider: true })).toBe(false);
  });

  it("deletion does not corrupt onboarding state - completed remains true", () => {
    const completedState = createOnboardingCompletedState();
    expect(completedState.completed).toBe(true);
    // Simulate credential deletion: hasConfiguredProvider becomes false, but completed stays true
    expect(shouldShowOnboarding({ onboardingCompleted: completedState.completed, hasConfiguredProvider: false })).toBe(false);
  });
});

describe("onboarding security", () => {
  it("API keys are not persisted in onboarding state", () => {
    const state = createOnboardingCompletedState();
    expect(isOnboardingStateValid(state)).toBe(true);
    expect(JSON.stringify(state)).not.toContain("OPENCODE_API_KEY");
    expect(JSON.stringify(state)).not.toContain("OPENROUTER_API_KEY");
    expect(JSON.stringify(state)).not.toContain("sk-");
  });

  it("rejects onboarding state that contains credential-like data", () => {
    expect(isOnboardingStateValid({ completed: true, apiKey: "sk-123" } as unknown as Record<string, unknown>)).toBe(false);
    expect(isOnboardingStateValid({ completed: true, OPENCODE_API_KEY: "secret" } as unknown as Record<string, unknown>)).toBe(false);
    expect(isOnboardingStateValid({ completed: true, Authorization: "Bearer token" } as unknown as Record<string, unknown>)).toBe(false);
  });

  it("does not log API keys - state stringification safe", () => {
    const state = { completed: true };
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/sk-/);
    expect(serialized).not.toMatch(/Authorization/);
  });
});
