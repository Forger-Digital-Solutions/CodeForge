import { describe, expect, it } from "vitest";

const gate = await import("../../../scripts/check-production-cloud.mjs");

const healthy = {
  url: "https://codeforge-cloud-va.onrender.com",
  live: { ok: true, status: 200, body: { status: "ok", version: "0.4.0" } },
  ready: {
    ok: true,
    status: 200,
    body: {
      status: "ready",
      database: "connected",
      hostedInferenceReady: true,
      availableFreeCount: 2,
      killSwitches: { hostedInferenceEnabled: true },
    },
  },
  meta: {
    ok: true,
    status: 200,
    body: {
      apiVersion: "1.0.0",
      serverVersion: "0.4.0",
      features: ["HOSTED_FREE", "DYNAMIC_MODELS", "HOSTED_TOOLS"],
    },
  },
  models: { ok: true, status: 200, body: [{ isEligibleFree: true, accessClass: "free" }] },
};

describe("production Cloud release gate", () => {
  it("passes only a ready v0.4+ Cloud with native hosted tools and an eligible-free catalog", () => {
    expect(gate.evaluateProductionCloud(healthy).passed).toBe(true);
  });

  it("blocks a stale v0.2 deployment that lacks native hosted tools", () => {
    const result = gate.evaluateProductionCloud({
      ...healthy,
      meta: {
        ...healthy.meta,
        body: { ...healthy.meta.body, serverVersion: "0.2.0", features: ["HOSTED_FREE", "DYNAMIC_MODELS"] },
      },
    });
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toMatch(/0\.4\.0|HOSTED_TOOLS/);
  });

  it("refuses local, staging, and development authorities before probing", () => {
    expect(() => gate.assertProductionCloudUrl("http://127.0.0.1:3220")).toThrow(/loopback/i);
    expect(() => gate.assertProductionCloudUrl("https://codeforge-cloud-staging.onrender.com")).toThrow(/staging/i);
    expect(() => gate.assertProductionCloudUrl("https://dev.codeforge.example")).toThrow(/development/i);
  });
});
