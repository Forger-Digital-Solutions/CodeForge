import { describe, expect, it } from "vitest";
import { validatePackagedEndpointManifest } from "../scripts/audit-packaged-auth-endpoint.mjs";

const validProduction = {
  channel: "production",
  endpoints: { production: "https://cloud.example.com/" },
};

describe("packaged authentication endpoint gate", () => {
  it("accepts the endpoint embedded for the requested production authority", () => {
    expect(validatePackagedEndpointManifest(validProduction, {
      channel: "production",
      expectedUrl: "https://cloud.example.com",
    })).toMatchObject({ channel: "production", endpoint: "https://cloud.example.com" });
  });

  it("rejects missing, mismatched, and loopback production endpoints", () => {
    expect(() => validatePackagedEndpointManifest({ channel: "production", endpoints: {} }, {
      channel: "production", expectedUrl: "https://cloud.example.com",
    })).toThrow(/missing/);
    expect(() => validatePackagedEndpointManifest({ channel: "production", endpoints: { production: "https://localhost" } }, {
      channel: "production", expectedUrl: "https://localhost",
    })).toThrow(/loopback/);
    expect(() => validatePackagedEndpointManifest({ channel: "production", endpoints: { production: "https://other.example.com" } }, {
      channel: "production", expectedUrl: "https://cloud.example.com",
    })).toThrow(/does not match/);
  });

  it("permits loopback only when the test mode is explicit", () => {
    expect(validatePackagedEndpointManifest({ channel: "development", endpoints: { development: "http://127.0.0.1:3220" } }, {
      channel: "development", expectedUrl: "http://127.0.0.1:3220", mode: "smoke",
    }).loopbackAllowed).toBe(true);
    expect(() => validatePackagedEndpointManifest({ channel: "development", endpoints: { development: "http://127.0.0.1:3220" } }, {
      channel: "development", expectedUrl: "http://127.0.0.1:3220",
    })).toThrow(/loopback/);
  });
});
