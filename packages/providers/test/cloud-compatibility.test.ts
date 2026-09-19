import { describe, expect, it } from "vitest";
import { checkCloudCompatibility, evaluateCloudCompatibility } from "../src/cloud-compatibility.js";

describe("CodeForge Cloud compatibility", () => {
  it("accepts the API generation and native hosted-tool features required by the desktop", () => {
    expect(evaluateCloudCompatibility({
      apiVersion: "1.2.3",
      serverVersion: "0.4.0",
      features: ["HOSTED_FREE", "DYNAMIC_MODELS", "HOSTED_TOOLS"],
    }).compatible).toBe(true);
  });

  it("rejects a cloud that lacks native hosted tools even when its API major matches", () => {
    const result = evaluateCloudCompatibility({
      apiVersion: "1.0.0",
      serverVersion: "0.2.0",
      features: ["HOSTED_FREE", "DYNAMIC_MODELS"],
    });
    expect(result.compatible).toBe(false);
    expect(result.message).toContain("HOSTED_TOOLS");
  });

  it("fails closed when metadata is unavailable or malformed", async () => {
    const unavailable = await checkCloudCompatibility("https://cloud.example", (async () => new Response("no", { status: 503 })) as typeof fetch);
    const malformed = await checkCloudCompatibility("https://cloud.example", (async () => new Response("not json")) as typeof fetch);

    expect(unavailable.compatible).toBe(false);
    expect(malformed.compatible).toBe(false);
  });
});
