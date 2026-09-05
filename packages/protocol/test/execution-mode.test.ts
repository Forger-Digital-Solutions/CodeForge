import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_MODE,
  ExecutionModeSchema,
  MISSING_EXECUTION_MODE_FALLBACK,
  SendRequestSchema,
  WorkspaceEventSchema,
} from "../src/index.js";

describe("execution-mode protocol", () => {
  it("defines Agent as the product default and Chat as the legacy API fallback", () => {
    expect(DEFAULT_EXECUTION_MODE).toBe("agent");
    expect(MISSING_EXECUTION_MODE_FALLBACK).toBe("chat");
  });

  it("accepts only canonical modes", () => {
    expect(ExecutionModeSchema.parse("chat")).toBe("chat");
    expect(ExecutionModeSchema.parse("agent")).toBe("agent");
    expect(ExecutionModeSchema.safeParse("banana").success).toBe(false);
    expect(ExecutionModeSchema.safeParse(42).success).toBe(false);
  });

  it("types send requests and execution failure events", () => {
    expect(SendRequestSchema.parse({ message: "hello", executionMode: "chat" })).toMatchObject({ executionMode: "chat" });
    expect(WorkspaceEventSchema.safeParse({
      type: "execution.start_failed",
      timestamp: new Date().toISOString(),
      seq: 1,
      sessionId: "session",
      payload: { requestId: "request", executionMode: "agent", code: "WORKFLOW_START_FAILED", message: "Could not start." },
    }).success).toBe(true);
  });
});
