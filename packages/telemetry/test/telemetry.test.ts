import { describe, expect, it } from "vitest";
import { Telemetry } from "../src/index.js";

function event(index: number) {
  return {
    schemaVersion: 1 as const,
    type: "worker.observed" as const,
    runId: "run-1",
    sessionId: "session-1",
    agentId: `agent-${index}`,
    occurredAt: "2026-09-14T12:00:00.000Z",
    data: { index },
  };
}

describe("bounded telemetry", () => {
  it("validates events and retains only the configured recent window", () => {
    const telemetry = new Telemetry({ maxEvents: 2 });
    telemetry.record(event(1));
    telemetry.record(event(2));
    telemetry.record(event(3));

    expect(telemetry.size).toBe(2);
    expect(telemetry.snapshot().map((entry) => entry.agentId)).toEqual(["agent-2", "agent-3"]);
  });

  it("supports disabled collection and destructive draining of only buffered data", () => {
    const telemetry = new Telemetry({ enabled: false });
    telemetry.record(event(1));

    expect(telemetry.drain()).toEqual([]);
    expect(telemetry.size).toBe(0);
  });
});
