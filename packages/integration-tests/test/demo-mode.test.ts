import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  waitForServerReady,
  sendMessage,
  sendRequest,
} from "../src/server-helpers.js";

describe("Demo Mode Isolation Tests", () => {
  let server: any;
  let port: number;

  beforeAll(async () => {
    const result = await startTestServer();
    server = result.server;
    port = result.port;
    await waitForServerReady(port);
  }, 10000);

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it("should keep turn status as 'running' in demo mode (never fails from provider execution)", async () => {
    const sessionId = "demo-mode-test";
    const message = "Test demo mode isolation";

    // Start a turn in demo mode
    const sendResult = await sendMessage(port, sessionId, message);
    expect(sendResult.ok).toBe(true);
    expect(sendResult.turnId).toBeDefined();
    const turnId = sendResult.turnId!;

    // Wait for any async work
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check the turn status via the sessions endpoint
    const sessionUrl = `http://localhost:${port}/api/sessions/${sessionId}`;
    const sessionResponse = await fetch(sessionUrl);
    const sessionData = await sessionResponse.json();

    const turn = sessionData.turns?.[0];
    expect(turn).toBeDefined();
    
    // In demo mode, turn should be "running" (not "failed")
    // Real provider execution is skipped entirely, so no provider errors
    expect(turn.status).toBe("running");
    expect(turn.error).toBeUndefined();
  }, 15000);

  it("should never transition through 'failed' status during normal demo operation", async () => {
    const sessionId = "demo-no-fail-test";
    const message = "Test no failure path";

    // Start a turn
    const sendResult = await sendMessage(port, sessionId, message);
    expect(sendResult.ok).toBe(true);
    const turnId = sendResult.turnId!;

    // Immediately check status - should never be 'failed'
    await new Promise((resolve) => setTimeout(resolve, 100));

    const sessionUrl = `http://localhost:${port}/api/sessions/${sessionId}`;
    const sessionResponse = await fetch(sessionUrl);
    const sessionData = await sessionResponse.json();

    const turn = sessionData.turns?.[0];
    expect(turn).toBeDefined();
    expect(turn.status).not.toBe("failed");
  }, 15000);

  it("should allow pause/resume/cancel without provider errors in demo mode", async () => {
    const sessionId = "demo-control-test";
    const message = "Test demo control flow";

    // Start a turn
    const sendResult = await sendMessage(port, sessionId, message);
    expect(sendResult.ok).toBe(true);
    const turnId = sendResult.turnId!;

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Pause should work without provider-related errors
    const pauseResult = await sendRequest(port, `/api/sessions/${sessionId}/turns/${turnId}/pause`);
    expect(pauseResult.ok).toBe(true);
    expect(pauseResult.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Resume should work without provider-related errors
    const resumeResult = await sendRequest(port, `/api/sessions/${sessionId}/turns/${turnId}/resume`);
    expect(resumeResult.ok).toBe(true);
    expect(resumeResult.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Cancel should work
    const cancelResult = await sendRequest(port, `/api/sessions/${sessionId}/turns/${turnId}/cancel`);
    expect(cancelResult.ok).toBe(true);
    expect(cancelResult.status).toBe(200);

    // Final check - turn should be cancelled, not failed
    const sessionUrl = `http://localhost:${port}/api/sessions/${sessionId}`;
    const sessionResponse = await fetch(sessionUrl);
    const sessionData = await sessionResponse.json();
    const turn = sessionData.turns?.[0];
    expect(turn.status).toBe("cancelled");
  }, 20000);
});
