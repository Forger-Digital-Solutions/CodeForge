import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEvent } from "@codeforge/protocol";
import { createServer, type CodeForgeServer } from "../../server/src/index.js";
import {
  applyExecutionLifecycleEvent,
  createSendRequest,
  initialWorkspaceState,
} from "../src/workspace-sse.js";

async function send(port: number, request: ReturnType<typeof createSendRequest>) {
  const response = await fetch(`http://localhost:${port}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

describe("CF-12 Desktop renderer to server execution-mode path", () => {
  let server: CodeForgeServer;
  let port: number;
  let chatStart: ReturnType<typeof vi.fn>;
  let workflowStart: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    chatStart = vi.fn(async () => "chat-turn");
    workflowStart = vi.fn(async () => ({ taskId: "workflow-task", turnId: "workflow-turn" }));
    server = createServer({ port: 0, dbPath: ":memory:" });
    (server as unknown as { activeWorkspacePath: string }).activeWorkspacePath = process.cwd();
    (server as unknown as { useRealRuntime: boolean }).useRealRuntime = true;
    (server as unknown as { getOrCreateRuntime: () => unknown }).getOrCreateRuntime = () => ({
      getActiveTurns: () => [],
      startTurn: chatStart,
    });
    (server as unknown as { workflowService: { startWorkflow: typeof workflowStart } }).workflowService.startWorkflow = workflowStart;
    await server.start();
    port = server.httpPort;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("keeps an action-verb submission in Chat when the renderer selected Chat", async () => {
    const { response, body } = await send(port, createSendRequest("desktop-chat", "fix the login crash", "request-chat", "chat"));

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ executionMode: "chat", runtime: "chat" });
    expect(chatStart).toHaveBeenCalledTimes(1);
    expect(workflowStart).not.toHaveBeenCalled();
  });

  it("keeps passive wording in Agent when the renderer selected Agent", async () => {
    const { response, body } = await send(port, createSendRequest("desktop-agent", "the login crashes when the password is blank", "request-agent", "agent"));

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ executionMode: "agent", runtime: "workflow" });
    expect(workflowStart).toHaveBeenCalledTimes(1);
    expect(chatStart).not.toHaveBeenCalled();
  });

  it("renders an Agent startup failure from the persisted server event without a Chat fallback", async () => {
    workflowStart.mockRejectedValueOnce(new Error("synthetic startup failure"));
    const { response, body } = await send(port, createSendRequest("desktop-failure", "passive failure wording", "request-failure", "agent"));

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ error: "WORKFLOW_START_FAILED", executionMode: "agent" });
    expect(workflowStart).toHaveBeenCalledTimes(1);
    expect(chatStart).not.toHaveBeenCalled();

    const sessionResponse = await fetch(`http://localhost:${port}/api/sessions/desktop-failure`);
    const session = await sessionResponse.json() as { events: WorkspaceEvent[] };
    const state = session.events.reduce(applyExecutionLifecycleEvent, initialWorkspaceState);
    expect(state).toMatchObject({
      activeExecutionMode: null,
      activePhase: "failed_to_start",
      agentStatus: "failed",
      workflowError: "Agent could not start\nThe autonomous workflow could not start.",
    });
  });

  it("snapshots a mode change so it affects only the next renderer submission", async () => {
    let selectedMode: "agent" | "chat" = "agent";
    const runA = createSendRequest("desktop-run-a", "first request", "request-a", selectedMode);
    selectedMode = "chat";
    const runB = createSendRequest("desktop-run-b", "second request", "request-b", selectedMode);

    expect(runA.executionMode).toBe("agent");
    expect(runB.executionMode).toBe("chat");
    await send(port, runA);
    await send(port, runB);
    expect(workflowStart).toHaveBeenCalledTimes(1);
    expect(chatStart).toHaveBeenCalledTimes(1);
  });
});
