import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  waitForServerReady,
  sendMessage,
  pauseTurn,
  resumeTurn,
  cancelTurn,
  sendRequest,
} from "../src/server-helpers.js";

describe("Stop/Pause/Resume Integration Tests", () => {
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

  it("should successfully pause a running turn", async () => {
    const sessionId = "pause-sess";
    const message = "Test pause functionality";

    // Start a turn
    const sendResult = await sendMessage(port, sessionId, message);
    expect(sendResult.ok).toBe(true);
    expect(sendResult.turnId).toBeDefined();
    const turnId = sendResult.turnId!;

    // Wait a bit for the turn to start AND for any async work to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Debug: Check what the runtime state is
    const sessionUrl = `http://localhost:${port}/api/sessions/${sessionId}`;
    const sessionResponse = await fetch(sessionUrl);
    const sessionData = await sessionResponse.json();
    
    const turn = sessionData.turns?.[0];
    if (turn) {
      console.log(`Turn status: ${turn.status}`);
    }

    // Debug: Check the pause URL
    const pauseUrl = `/api/sessions/${sessionId}/turns/${turnId}/pause`;
    console.log(`Pause URL: ${pauseUrl}`);

    // Pause the turn
    const pauseResult = await pauseTurn(port, sessionId, turnId);
    console.log("Pause response:", pauseResult);
    console.log("Pause error message:", pauseResult.body?.error);
    
    // Check if body contains an error
    if (pauseResult.body && typeof pauseResult.body === "object") {
      console.log("Pause error:", pauseResult.body.error);
    }
    
    expect(pauseResult.ok).toBe(true);
  }, 15000);

  it("should successfully resume a paused turn", async () => {
    const sessionId = "resume-sess";
    const message = "Test resume functionality";

    // Start a turn
    const sendResult = await sendMessage(port, sessionId, message);
    expect(sendResult.ok).toBe(true);
    const turnId = sendResult.turnId!;

    // Wait a bit for the turn to start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Debug: Check current state
    const sessionUrl = `http://localhost:${port}/api/sessions/${sessionId}`;
    const sessionResponse = await fetch(sessionUrl);
    const sessionData = await sessionResponse.json();
    
    const turn = sessionData.turns?.[0];
    if (turn) {
      console.log(`Turn status before pause: ${turn.status}`);
    }

    // Pause the turn
    const pauseResult = await pauseTurn(port, sessionId, turnId);
    console.log("Pause result:", pauseResult);
    if (pauseResult.body && typeof pauseResult.body === "object") {
      console.log("Pause error:", pauseResult.body.error);
    }
    expect(pauseResult.ok).toBe(true);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Resume the turn
    const resumeResult = await resumeTurn(port, sessionId, turnId);
    console.log("Resume result:", resumeResult);
    if (resumeResult.body && typeof resumeResult.body === "object") {
      console.log("Resume error:", resumeResult.body.error);
    }
    expect(resumeResult.ok).toBe(true);
  }, 15000);

  it("should successfully cancel a running turn", async () => {
    const sessionId = "cancel-sess";
    const message = "Test cancel functionality";

    // Start a turn
    const sendResult = await sendMessage(port, sessionId, message);
    expect(sendResult.ok).toBe(true);
    const turnId = sendResult.turnId!;

    // Wait a bit for the turn to start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Debug: Check current state
    const sessionUrl = `http://localhost:${port}/api/sessions/${sessionId}`;
    const sessionResponse = await fetch(sessionUrl);
    const sessionData = await sessionResponse.json();
    const turn = sessionData.turns?.[0];
    if (turn) {
      console.log(`Turn status before cancel: ${turn.status}`);
    }

    // Cancel the turn
    const cancelResult = await cancelTurn(port, sessionId, turnId);
    console.log("Cancel result:", cancelResult);
    if (cancelResult.body && typeof cancelResult.body === "object") {
      console.log("Cancel error:", cancelResult.body.error);
    }
    expect(cancelResult.ok).toBe(true);
  }, 10000);

  it("should fail when calling resume while turn is running (not paused)", async () => {
    const sessionId = "resume-fail-sess";
    const message = "Test resume failure case";

    // Start a turn
    const sendResult = await sendMessage(port, sessionId, message);
    expect(sendResult.ok).toBe(true);
    const turnId = sendResult.turnId!;

    // Wait a bit for the turn to start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Debug: Check current state
    const sessionUrl = `http://localhost:${port}/api/sessions/${sessionId}`;
    const sessionResponse = await fetch(sessionUrl);
    const sessionData = await sessionResponse.json();
    const turn = sessionData.turns?.[0];
    if (turn) {
      console.log(`Turn status: ${turn.status}`);
    }

    // Try to resume while already running - this should fail
    const resumeResult = await resumeTurn(port, sessionId, turnId);
    console.log("Resume-Fail result:", resumeResult);
    if (resumeResult.body && typeof resumeResult.body === "object") {
      console.log("Resume-Fail error:", resumeResult.body.error);
    }
    expect(resumeResult.ok).toBe(false);
    expect(resumeResult.status).toBe(400);
    expect(resumeResult.body).toBeDefined();
    expect(resumeResult.body?.error).toBeDefined();
  }, 10000);

  it("should complete a full run-pause-resume-cancel cycle", async () => {
    const sessionId = "full-cycle-sess";
    const message = "Test complete cycle";

    // Start a turn
    const sendResult = await sendMessage(port, sessionId, message);
    expect(sendResult.ok).toBe(true);
    const turnId = sendResult.turnId!;

    // Wait for turn to start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Debug: Check current state
    const sessionUrl = `http://localhost:${port}/api/sessions/${sessionId}`;
    const sessionResponse = await fetch(sessionUrl);
    const sessionData = await sessionResponse.json();
    const turn = sessionData.turns?.[0];
    if (turn) {
      console.log(`Full-Cycle Turn status: ${turn.status}`);
    }

    // Pause
    const pauseResult1 = await pauseTurn(port, sessionId, turnId);
    console.log("Pause-1 result:", pauseResult1);
    if (pauseResult1.body && typeof pauseResult1.body === "object") {
      console.log("Pause-1 error:", pauseResult1.body.error);
    }
    expect(pauseResult1.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Resume
    const resumeResult = await resumeTurn(port, sessionId, turnId);
    console.log("Resume result:", resumeResult);
    if (resumeResult.body && typeof resumeResult.body === "object") {
      console.log("Resume error:", resumeResult.body.error);
    }
    expect(resumeResult.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Pause again
    const pauseResult2 = await pauseTurn(port, sessionId, turnId);
    console.log("Pause-2 result:", pauseResult2);
    if (pauseResult2.body && typeof pauseResult2.body === "object") {
      console.log("Pause-2 error:", pauseResult2.body.error);
    }
    expect(pauseResult2.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Cancel
    const cancelResult = await cancelTurn(port, sessionId, turnId);
    console.log("Cancel result:", cancelResult);
    if (cancelResult.body && typeof cancelResult.body === "object") {
      console.log("Cancel error:", cancelResult.body.error);
    }
    expect(cancelResult.ok).toBe(true);
  }, 20000);
});
