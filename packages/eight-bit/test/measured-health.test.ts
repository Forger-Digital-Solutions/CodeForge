import { describe, expect, it } from "vitest";
import { EightBitMeasuredHealthTracker, type EightBitRouteMeasurement } from "../src/measured-health.js";

const measurement = (overrides: Partial<EightBitRouteMeasurement> = {}): EightBitRouteMeasurement => ({
  providerId: "provider",
  modelId: "model",
  observedAt: "2026-09-19T00:00:00.000Z",
  sampleSize: 20,
  successes: 20,
  failures: 0,
  rateLimits: 0,
  timeouts: 0,
  latencyP50Ms: 500,
  latencyP95Ms: 1_000,
  capacityUtilization: 0.25,
  availableCapacity: 3,
  qualityScore: 0.9,
  toolCallScore: 0.95,
  policyCertainty: "verified",
  costCertainty: "verified_free",
  ...overrides,
});

describe("EightBitMeasuredHealthTracker", () => {
  it("keeps health, capacity, quality, policy and cost as separate signals", () => {
    const record = new EightBitMeasuredHealthTracker().ingest(measurement());
    expect(record.state).toBe("HEALTHY");
    expect(record.availabilityScore).toBe(1);
    expect(record.capacityScore).toBe(0.75);
    expect(record.qualityScore).toBe(0.9);
    expect(record.toolCallScore).toBe(0.95);
  });

  it("demotes sustained rate limits without calling full utilization unhealthy", () => {
    const tracker = new EightBitMeasuredHealthTracker();
    expect(tracker.ingest(measurement({ successes: 16, failures: 4, rateLimits: 4, capacityUtilization: 0.2 })).state).toBe("DEGRADED");
    const utilized = tracker.ingest(measurement({ capacityUtilization: 1, availableCapacity: 0 }));
    expect(utilized.state).toBe("HEALTHY");
    expect(utilized.capacityScore).toBe(0);
  });

  it("marks severe failure and rate-limit rates unavailable", () => {
    const tracker = new EightBitMeasuredHealthTracker();
    expect(tracker.ingest(measurement({ successes: 8, failures: 12, rateLimits: 0 })).state).toBe("UNAVAILABLE");
    expect(tracker.ingest(measurement({ successes: 10, failures: 10, rateLimits: 9 })).state).toBe("UNAVAILABLE");
  });

  it("quarantines unknown cost and policy before health scoring", () => {
    const tracker = new EightBitMeasuredHealthTracker();
    expect(tracker.ingest(measurement({ costCertainty: "unknown" })).state).toBe("QUARANTINED");
    expect(tracker.ingest(measurement({ policyCertainty: "unknown" })).state).toBe("QUARANTINED");
    expect(tracker.ingest(measurement({ costCertainty: "paid" })).reasonCodes).toContain("KNOWN_PAID");
  });

  it("quarantines routes below the coding quality floor", () => {
    const record = new EightBitMeasuredHealthTracker().ingest(measurement({ qualityScore: 0.4 }));
    expect(record.state).toBe("QUARANTINED");
    expect(record.reasonCodes).toContain("QUALITY_BELOW_FLOOR");
  });

  it("requires staged recovery evidence after an unavailable state", () => {
    const tracker = new EightBitMeasuredHealthTracker();
    expect(tracker.ingest(measurement({ successes: 0, failures: 20 })).state).toBe("UNAVAILABLE");
    expect(tracker.ingest(measurement()).state).toBe("PROBING");
    expect(tracker.ingest(measurement()).state).toBe("RECOVERED");
  });
});
