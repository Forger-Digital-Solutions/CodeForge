import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/health.js";
import { FAILURE_POLICY } from "../src/types.js";

/**
 * R23 — classifier fixtures taken from the live events of the 2026-09-21 supply campaign.
 * Every fixture is a message/status/code shape that actually reached CodeForge; the expected class
 * is the one 8-Bit must assign for its cooldown / rotation / removal semantics to be right.
 */
describe("classifyFailure — R23 live campaign fixtures (2026-09-21)", () => {
  it("[PASS] Nvidia worker saturation inside OpenRouter's 502 envelope is TEMPORARY_CAPACITY, not an outage", () => {
    // Bare and production-shaped probes at 10:32Z: HTTP 200 + in-band error, code 502.
    const live = Object.assign(new Error("OpenRouter stream error (502): Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (1527/16)"), { code: "502", status: 502 });
    expect(classifyFailure(live)).toBe("TEMPORARY_CAPACITY");
    expect(classifyFailure(new Error("Provider error: 502 - Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (16/16)"))).toBe("TEMPORARY_CAPACITY");
    expect(FAILURE_POLICY.TEMPORARY_CAPACITY).toBe("cooldown_and_rotate");
  });

  it("[PASS] a provider restricting the route to a client class is ACCESS_RESTRICTED (permanent), not AUTH_FAILURE", () => {
    // thinkingmachines/inkling + inkling-small: 403 "only available on agentic harnesses" (verified twice).
    const inkling = Object.assign(new Error("OpenRouter error (403): This model is only available on agentic harnesses"), { code: "AUTH_ERROR", status: 403 });
    expect(classifyFailure(inkling)).toBe("ACCESS_RESTRICTED");
    expect(FAILURE_POLICY.ACCESS_RESTRICTED).toBe("remove_and_refresh");
    // A bare 403 with no restriction text is still a credential/permission fault on OUR side.
    expect(classifyFailure(Object.assign(new Error("OpenRouter error (403): forbidden"), { code: "AUTH_ERROR", status: 403 }))).toBe("AUTH_FAILURE");
    // A 403 moderation flag is a safety rejection, never an auth fault.
    expect(classifyFailure(Object.assign(new Error("Your input was flagged by the content_filter"), { status: 403 }))).toBe("SAFETY_REJECTION");
  });

  it("[PASS] HTTP 410 (GitHub Models API retirement brownout) is MODEL_RETIRED", () => {
    expect(classifyFailure(Object.assign(new Error("github-models error (410): Gone"), { status: 410 }))).toBe("MODEL_RETIRED");
  });

  it("[PASS] Cerebras 402 credit exhaustion and Mistral 0-rpm 429 keep their R1 classes", () => {
    expect(classifyFailure(Object.assign(new Error("cerebras error (402): payment required"), { code: "PAYMENT_REQUIRED", status: 402 }))).toBe("PAID_PLAN_REQUIRED");
    expect(classifyFailure(Object.assign(new Error("mistral error (429): Requests rate limit exceeded"), { code: "RATE_LIMITED", status: 429 }))).toBe("RATE_LIMITED");
  });

  it("[PASS] Groq server-side tool validation is INVALID_TOOL_OUTPUT (bounded retry), even behind the runtime's \"Provider error:\" prefix", () => {
    // R23 round 3 (10:42–10:55Z): 4 of 23 calls — json/repo_tree hallucinated tool names, run_command missing 'command'.
    const runtimeShaped = new Error("Provider error: INVALID_TOOL_OUTPUT - groq stream error (tool_use_failed) after HTTP 200: Tool call validation failed: tool call validation failed: attempted to call tool 'json' which was not in request.tools");
    expect(classifyFailure(runtimeShaped)).toBe("INVALID_TOOL_OUTPUT");
    expect(classifyFailure(new Error("Provider error: PROVIDER_ERROR - groq stream error (tool_use_failed) after HTTP 200: Tool call validation failed: parameters for tool run_command did not match schema: errors: [missing properties: 'command']"))).toBe("INVALID_TOOL_OUTPUT");
    expect(FAILURE_POLICY.INVALID_TOOL_OUTPUT).toBe("bounded_retry");
    // Round 4 (gpt-oss-20b): Groq output_parse_failed — "The model generated output that could not be parsed".
    expect(classifyFailure(new Error("Provider error: PROVIDER_ERROR - groq stream error (output_parse_failed) after HTTP 200: Parsing failed. The model generated output that could not be parsed. Please adjust your prompt."))).toBe("INVALID_TOOL_OUTPUT");
    // The prefix alone must not turn a real outage classification off.
    expect(classifyFailure(new Error("Provider error: 502 - Provider returned error"))).toBe("PROVIDER_OUTAGE");
  });

  it("[PASS] Groq in-band frames surfaced by the adapter classify by their own message, no longer as generic interruptions", () => {
    expect(classifyFailure(new Error("Provider error: RATE_LIMITED - groq stream error (rate_limit_exceeded) after HTTP 200: Rate limit reached for model openai/gpt-oss-120b on tokens per minute (TPM): Limit 8000, Used 7900, Requested 3300. Please try again in 24.75s."))).toBe("RATE_LIMITED");
    expect(classifyFailure(new Error("Provider error: PROVIDER_ERROR - groq stream error (internal_server_error) after HTTP 200: over capacity"))).toBe("TEMPORARY_CAPACITY");
    expect(classifyFailure(Object.assign(new Error("groq stream ended before the provider sent [DONE] (HTTP 200, 0 byte(s), 0 frame(s), no terminal finish_reason)"), { code: "STREAM_INTERRUPTED", status: 200 }))).toBe("PROVIDER_OUTAGE");
  });
});
