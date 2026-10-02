import { describe, expect, it } from "vitest";
import { deploymentIdentity } from "../src/deployment-identity.js";

describe("production deployment provenance", () => {
  it("reports only validated Render revision and service identifiers", () => {
    expect(deploymentIdentity({ RENDER_GIT_COMMIT: "a".repeat(40), RENDER_SERVICE_ID: "srv-example", JWT_SECRET: "hidden" }))
      .toEqual({ commit: "a".repeat(40), serviceId: "srv-example" });
    expect(deploymentIdentity({ RENDER_GIT_COMMIT: "credential material", RENDER_SERVICE_ID: "https://example.com" }))
      .toEqual({ commit: null, serviceId: null });
  });
});
