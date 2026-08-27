import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { startTestServer, waitForServerReady, sendMessage, pauseTurn, resumeTurn, cancelTurn, waitForEvent, } from "../src/server-helpers.js";
describe("Stop/Pause/Resume Integration Tests", () => {
    let server;
    let port;
    beforeAll(async () => {
        const result = await startTestServer();
        server = result.server;
        port = result.port;
        await waitForServerReady(port);
    });
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
        const turnId = sendResult.turnId;
        // Wait for the turn to start
        const turnStarted = await waitForEvent(port, "turn.started");
        expect(turnStarted).toBeDefined();
        expect(turnStarted.payload.turnId).toBe(turnId);
        // Wait for status to change to running
        const statusRunning = await waitForEvent(port, "status.changed");
        expect(statusRunning).toBeDefined();
        expect(statusRunning.payload.to).toBe("running");
        // Pause the turn
        const pauseResult = await pauseTurn(port, sessionId, turnId);
        expect(pauseResult.ok).toBe(true);
        // Wait for turn.paused event
        const turnPaused = await waitForEvent(port, "turn.paused");
        expect(turnPaused).toBeDefined();
        // Verify the status is now paused
        const statusPaused = await waitForEvent(port, "status.changed");
        expect(statusPaused).toBeDefined();
        expect(statusPaused.payload.to).toBe("paused");
    }, 20000);
    it("should successfully resume a paused turn", async () => {
        const sessionId = "resume-sess";
        const message = "Test resume functionality";
        // Start a turn
        const sendResult = await sendMessage(port, sessionId, message);
        expect(sendResult.ok).toBe(true);
        const turnId = sendResult.turnId;
        // Wait for turn to start and go to running
        await waitForEvent(port, "turn.started");
        await waitForEvent(port, "status.changed");
        // Pause the turn
        await pauseTurn(port, sessionId, turnId);
        await waitForEvent(port, "turn.paused");
        // Resume the turn
        const resumeResult = await resumeTurn(port, sessionId, turnId);
        expect(resumeResult.ok).toBe(true);
        // Wait for turn.resumed event
        const turnResumed = await waitForEvent(port, "turn.resumed");
        expect(turnResumed).toBeDefined();
        // Verify status changes back to running
        const statusRunning = await waitForEvent(port, "status.changed");
        expect(statusRunning).toBeDefined();
        expect(statusRunning.payload.to).toBe("running");
    }, 20000);
    it("should successfully cancel a running turn", async () => {
        const sessionId = "cancel-sess";
        const message = "Test cancel functionality";
        // Start a turn
        const sendResult = await sendMessage(port, sessionId, message);
        expect(sendResult.ok).toBe(true);
        const turnId = sendResult.turnId;
        // Wait for turn to start and go to running
        await waitForEvent(port, "turn.started");
        await waitForEvent(port, "status.changed");
        // Cancel the turn
        const cancelResult = await cancelTurn(port, sessionId, turnId);
        expect(cancelResult.ok).toBe(true);
        // Wait for turn.cancelled event
        const turnCancelled = await waitForEvent(port, "turn.cancelled");
        expect(turnCancelled).toBeDefined();
        // Verify status is now cancelled
        const statusCancelled = await waitForEvent(port, "status.changed");
        expect(statusCancelled).toBeDefined();
        expect(statusCancelled.payload.to).toBe("cancelled");
    }, 20000);
    it("should fail when calling resume while turn is running (not paused)", async () => {
        const sessionId = "resume-fail-sess";
        const message = "Test resume failure case";
        // Start a turn
        const sendResult = await sendMessage(port, sessionId, message);
        expect(sendResult.ok).toBe(true);
        const turnId = sendResult.turnId;
        // Wait for turn to start and go to running
        await waitForEvent(port, "turn.started");
        await waitForEvent(port, "status.changed");
        // Try to resume while already running - this should fail
        const resumeResult = await resumeTurn(port, sessionId, turnId);
        expect(resumeResult.ok).toBe(false);
        expect(resumeResult.status).toBe(400);
        expect(resumeResult.body).toBeDefined();
        expect(resumeResult.body.error).toBeDefined();
    });
    it("should complete a full run-pause-resume-cancel cycle", async () => {
        const sessionId = "full-cycle-sess";
        const message = "Test complete cycle";
        // Start a turn
        const sendResult = await sendMessage(port, sessionId, message);
        expect(sendResult.ok).toBe(true);
        const turnId = sendResult.turnId;
        // Wait for turn to start and go to running
        await waitForEvent(port, "turn.started");
        await waitForEvent(port, "status.changed");
        // Pause
        await pauseTurn(port, sessionId, turnId);
        await waitForEvent(port, "turn.paused");
        await waitForEvent(port, "status.changed");
        // Resume
        await resumeTurn(port, sessionId, turnId);
        await waitForEvent(port, "turn.resumed");
        await waitForEvent(port, "status.changed");
        // Pause again
        await pauseTurn(port, sessionId, turnId);
        await waitForEvent(port, "turn.paused");
        // Cancel
        const cancelResult = await cancelTurn(port, sessionId, turnId);
        expect(cancelResult.ok).toBe(true);
        await waitForEvent(port, "turn.cancelled");
        await waitForEvent(port, "status.changed");
    }, 30000);
});
//# sourceMappingURL=pause-resume-cancel.test.js.map