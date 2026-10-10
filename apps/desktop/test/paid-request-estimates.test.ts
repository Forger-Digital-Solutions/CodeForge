import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonalAccountEstimate } from "@codeforge/server";
import { PaidEstimatePresenter } from "../src/paid-request-estimates.js";
import type { PersonalPaidEstimateView } from "../src/paid-request-estimate-types.js";

const estimate: PersonalAccountEstimate = { ownerUserId: "alice", connectionId: "fixture-connection", providerId: "openrouter", modelId: "fixture-model",
  requestId: "fixture-request", estimatedCostUsd: 0.002, remainingBudgetUsd: 0.998, currency: "USD", pricingSource: "official", purpose: "INFERENCE", workspacePath: "fixture-workspace" };

describe("paid request estimate presentation", () => {
  afterEach(() => vi.useRealTimers());
  it("binds the acknowledgment to the active renderer and accepts it once", async () => {
    let view!: PersonalPaidEstimateView;
    const presenter = new PaidEstimatePresenter({ surface: () => ({ senderId: 7, visible: true, send: next => { view = next; } }),
      isCurrent: () => true, maskedIdentity: () => "•••• 1234" });
    const presentation = presenter.present(estimate);
    await Promise.resolve();
    expect(view.estimatedCostUsd).toBe(0.002); expect(JSON.stringify(view)).not.toContain("alice"); expect(JSON.stringify(view)).not.toContain("fixture-workspace");
    expect(presenter.acknowledge(view.presentationId, 8)).toBe(false);
    expect(presenter.acknowledge("fabricated", 7)).toBe(false);
    expect(presenter.acknowledge(view.presentationId, 7)).toBe(true); await presentation;
    expect(presenter.acknowledge(view.presentationId, 7)).toBe(false);
  });
  it("rejects stale owner or workspace authority even after the view was emitted", async () => {
    let current = true; let view!: PersonalPaidEstimateView;
    const presenter = new PaidEstimatePresenter({ surface: () => ({ senderId: 7, visible: true, send: next => { view = next; } }), isCurrent: () => current, maskedIdentity: () => "•••• 1234" });
    const presentation = presenter.present(estimate); await Promise.resolve(); current = false;
    expect(presenter.acknowledge(view.presentationId, 7)).toBe(false);
    await expect(presentation).rejects.toThrow("PERSONAL_PAID_ESTIMATE_AUTHORITY_CHANGED");
  });
  it("blocks hidden or unavailable surfaces and times out without wire authorization", async () => {
    const hidden = new PaidEstimatePresenter({ surface: () => ({ senderId: 7, visible: false, send: () => {} }), isCurrent: () => true, maskedIdentity: () => "•••• 1234" });
    await expect(hidden.present(estimate)).rejects.toThrow("PERSONAL_PAID_ESTIMATE_UNAVAILABLE");
    vi.useFakeTimers();
    const silent = new PaidEstimatePresenter({ surface: () => ({ senderId: 7, visible: true, send: () => {} }), isCurrent: () => true, maskedIdentity: () => "•••• 1234", timeoutMs: 100 });
    const failure = expect(silent.present(estimate)).rejects.toThrow("PERSONAL_PAID_ESTIMATE_NOT_PRESENTED");
    await vi.advanceTimersByTimeAsync(100); await failure;
  });
});
