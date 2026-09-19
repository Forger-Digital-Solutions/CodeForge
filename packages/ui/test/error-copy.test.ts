import { describe, it, expect } from "vitest";
import { humanizeError, describeTurnStop, humanizeBlockReason } from "../src/error-copy.js";

describe("humanizeError", () => {
  it("strips a leading bracketed error code before humanizing", () => {
    expect(humanizeError("[PROVIDER_UNAVAILABLE] Provider stream failed")).toBe(
      "The model provider is temporarily unavailable — the run stopped safely. Try again in a moment.",
    );
  });

  it("dedupes a code prefixed twice by nested layers", () => {
    expect(
      humanizeError("[PROVIDER_UNAVAILABLE] [PROVIDER_UNAVAILABLE] OpenRouter stream error (503): Upstream error from Nvidia: Service temporarily overloaded"),
    ).toBe("The model provider is temporarily unavailable — the run stopped safely. Try again in a moment.");
  });

  it("maps an outage phrase even when the code is unknown", () => {
    expect(humanizeError("[UPSTREAM_503_X] upstream gateway exploded")).toBe(
      "The model provider is temporarily unavailable — the run stopped safely. Try again in a moment.",
    );
  });

  it("does not treat a lowercase bracketed prefix as an error code", () => {
    const msg = "[note] keep this prefix";
    expect(humanizeError(msg)).toBe(msg);
  });

  it("degrades a bare unknown code to a readable label", () => {
    expect(humanizeError("[SOME_INTERNAL_CODE]")).toBe("Some internal code");
  });

  it("keeps existing phrase mappings on stripped text", () => {
    expect(humanizeError("[PROVIDER_ERROR] request failed with 401")).toBe(
      "Provider authentication failed — the credentials on this route were rejected. If you connected this provider yourself, update its key in Settings → Providers.",
    );
  });

  it("strips a colon-style code prefix persisted by older runs", () => {
    expect(humanizeError("AGENT_INVALID_STRUCTURED_OUTPUT: engineering plan requires id, goal, and non-empty workstreams")).toBe(
      "engineering plan requires id, goal, and non-empty workstreams",
    );
  });
});

describe("describeTurnStop", () => {
  it("still treats a user stop as a decision", () => {
    expect(describeTurnStop("user stopped the task")).toBe("Stopped by you");
  });
});

describe("humanizeBlockReason", () => {
  it("keeps approval copy", () => {
    expect(humanizeBlockReason("approval_rejected")).toBe("You denied this action — the agent continued without it");
  });
});
