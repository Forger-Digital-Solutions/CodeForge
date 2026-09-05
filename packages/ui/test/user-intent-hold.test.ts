import { describe, expect, it } from "vitest";
import { createUserIntentHoldRequest } from "../src/workspace-sse.js";

describe("CF-17 composer privacy", () => {
  it("sends only a bounded state transition and never draft contents", () => {
    const request = createUserIntentHoldRequest("session-a", true, "run-a", "turn-a");
    expect(request).toEqual({ sessionId: "session-a", action: "request", runId: "run-a", turnId: "turn-a" });
    expect(JSON.stringify(request)).not.toContain("PASSWORD");
    expect(JSON.stringify(request)).not.toContain("sk-");
    expect(JSON.stringify(request)).not.toContain("ghp_");
    expect(request).not.toHaveProperty("message");
  });

  it("can release without carrying the cleared draft", () => {
    expect(createUserIntentHoldRequest("session-a", false, "run-a", "turn-a", 2)).toEqual({
      sessionId: "session-a",
      action: "release",
      runId: "run-a",
      turnId: "turn-a",
      generation: 2,
    });
  });
});
