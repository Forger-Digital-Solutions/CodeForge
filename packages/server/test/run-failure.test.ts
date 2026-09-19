import { describe, expect, it } from "vitest";
import { describeRunFailure } from "../src/run-failure.js";

/**
 * The failure attribution contract: a managed free route must never tell the user to fix "your API
 * key" (there is none), and CodeForge-authored denials must keep their machine-readable reason.
 */
describe("describeRunFailure", () => {
  it("managed free auth failure never blames a user credential", () => {
    const failure = describeRunFailure(new Error("OpenRouter error (401): invalid key"), {
      providerId: "codeforge-cloud",
      modelId: "openrouter::deepseek/deepseek-v4-flash:free",
    });
    expect(failure.ownership).toBe("managed_free");
    expect(failure.code).toBe("provider_auth_failed");
    expect(failure.message).not.toMatch(/your (api )?key|your credential|settings/i);
    expect(failure.message).toMatch(/CodeForge's side|managed free/i);
  });

  it("BYOK auth failure identifies the configured credential", () => {
    const failure = describeRunFailure(new Error("OpenRouter error (401): invalid key"), {
      providerId: "openrouter",
      modelId: "openrouter/qwen-3:free",
    });
    expect(failure.ownership).toBe("byok");
    expect(failure.code).toBe("provider_auth_failed");
    expect(failure.message).toMatch(/configured API credential/i);
  });

  it("entitlement denial keeps its machine code and is not a provider failure", () => {
    const failure = describeRunFailure(
      new Error("[REQUIRES_SUBSCRIPTION] User free-user not entitled to topaz. Status: locked"),
      { providerId: "codeforge", modelId: "topaz" },
    );
    expect(failure.code).toBe("paid_plan_required");
    expect(failure.ownership).toBe("paid");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("REQUIRES_SUBSCRIPTION");
    expect(failure.message).not.toMatch(/could not classify/i);
  });

  it("entitlement service outage fails closed with the real code", () => {
    const failure = describeRunFailure(
      new Error("[PROVIDER_UNAVAILABLE] Entitlement service unavailable - access denied for GEMS model"),
      { providerId: "codeforge", modelId: "topaz" },
    );
    expect(failure.code).toBe("provider_outage");
    expect(failure.message).toContain("PROVIDER_UNAVAILABLE");
  });

  it("a route-exhausted managed run stops safely with route_exhausted", () => {
    const failure = describeRunFailure(new Error("whatever"), {
      providerId: "codeforge-cloud",
      routeExhausted: true,
    });
    expect(failure.code).toBe("route_exhausted");
    expect(failure.ownership).toBe("managed_free");
    expect(failure.message).toMatch(/without (using|switching to) a paid or unknown-cost route/i);
  });

  it("8-Bit's no-eligible-route error classifies as route_exhausted even without the flag", () => {
    const failure = describeRunFailure(
      new Error("[PROVIDER_UNAVAILABLE] No eligible free route for role CODER: 8-Bit admission found no healthy route"),
    );
    expect(failure.code).toBe("route_exhausted");
    expect(failure.ownership).toBe("managed_free");
  });

  it("capability mismatch passes through the curated message (tool calling)", () => {
    const failure = describeRunFailure(
      new Error("Selected model codeforge::music/no-tools:free does not support tool calling and cannot run agent tasks."),
    );
    expect(failure.code).toBe("model_unavailable");
    expect(failure.message).toContain("does not support tool calling");
  });

  it("exact-pin rejection keeps the pin identity in the message", () => {
    const failure = describeRunFailure(
      new Error("Exact model codex-account::default is no longer registered or available. Exact model execution failed closed."),
    );
    expect(failure.code).toBe("model_unavailable");
    expect(failure.message).toContain("codex-account::default");
  });

  it("exact-pin temporary ineligibility is not misread as a provider rate limit", () => {
    const failure = describeRunFailure(
      new Error("Exact model codeforge::x is temporarily ineligible: provider health check failed (health=rate_limited). Exact model execution failed closed."),
    );
    expect(failure.code).toBe("model_unavailable");
    expect(failure.message).toContain("temporarily ineligible");
  });

  it("working-budget exhaustion classifies as budget_exhausted", () => {
    const failure = describeRunFailure(new Error("Agent working budget of 10 minutes exhausted"));
    expect(failure.code).toBe("budget_exhausted");
  });

  it("provider raw bodies never become the headline; they live in detail", () => {
    const failure = describeRunFailure(new Error("upstream returned 502 with body <html>…"), {
      providerId: "openrouter",
      modelId: "qwen-3:free",
    });
    expect(failure.message).not.toContain("<html>");
    expect(failure.detail).toContain("upstream returned 502");
  });

  it("a no-progress loop stop is a CodeForge runtime guard, not an unknown route error", () => {
    const failure = describeRunFailure(
      new Error('[AGENT_NO_PROGRESS_DETECTED] No-progress loop: read-only action "read_file" was executed and then suppressed once against unchanged workspace state and is being requested again.'),
      { providerId: "openrouter", modelId: "deepseek/deepseek-v4-flash-0731:free" },
    );
    expect(failure.ownership).toBe("runtime");
    expect(failure.code).toBe("invalid_model_output");
    expect(failure.message).not.toMatch(/could not classify/i);
    expect(failure.message).toContain("AGENT_NO_PROGRESS_DETECTED");
  });

  it("a deterministic tool loop stop is a CodeForge runtime guard", () => {
    const failure = describeRunFailure(
      new Error('[AGENT_TOOL_LOOP_DETECTED] Deterministic loop detected: tool "read_file" called 3 consecutive times with identical arguments.'),
    );
    expect(failure.ownership).toBe("runtime");
    expect(failure.message).not.toMatch(/could not classify/i);
  });

  it("a bracketed provider rate limit keeps managed ownership", () => {
    const failure = describeRunFailure(
      new Error("[PROVIDER_RATE_LIMITED] Provider 'codeforge-cloud' is in cooldown (42s remaining)"),
      { providerId: "codeforge-cloud" },
    );
    expect(failure.code).toBe("provider_rate_limited");
    expect(failure.ownership).toBe("managed_free");
  });

  it("a bracketed provider rate limit keeps byok ownership", () => {
    const failure = describeRunFailure(
      new Error("[PROVIDER_RATE_LIMITED] Provider 'openrouter' is in cooldown (42s remaining)"),
      { providerId: "openrouter" },
    );
    expect(failure.code).toBe("provider_rate_limited");
    expect(failure.ownership).toBe("byok");
    expect(failure.message).not.toMatch(/your (api )?key/i);
  });

  it("a workspace-escape tool refusal is not a route error", () => {
    const failure = describeRunFailure(new Error("[TOOL_WORKSPACE_ESCAPE] path outside workspace"));
    expect(failure.ownership).toBe("runtime");
    expect(failure.code).toBe("workspace_error");
  });
});
