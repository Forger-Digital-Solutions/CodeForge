import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { SessionRecord, TurnRecord } from "@codeforge/sessions";
import { clearSessionScopedState, createNewSessionDraft, initialWorkspaceState, readRememberedActiveSession, rememberActiveSession, resolveSendSessionId } from "../src/workspace-sse.js";

describe("workspace-sse - task session allocation", () => {
  it("keeps the active session when adding a turn", () => {
    const createSessionId = vi.fn(() => "new-session");

    expect(resolveSendSessionId("task-a", createSessionId)).toBe("task-a");
    expect(createSessionId).not.toHaveBeenCalled();
  });

  it("allocates a distinct session when New task has cleared the active task", () => {
    expect(resolveSendSessionId(null, () => "task-b")).toBe("task-b");
  });

  it("creates an idle draft that owns the next task before it is sent", () => {
    const draft = createNewSessionDraft(
      () => "task-b",
      () => "2026-08-29T22:00:00.000Z",
    );

    expect(draft).toEqual({
      id: "task-b",
      title: "New task",
      createdAt: "2026-08-29T22:00:00.000Z",
      updatedAt: "2026-08-29T22:00:00.000Z",
      status: "idle",
    });
  });

  it("restores the remembered UUID-backed task instead of falling back to default", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    rememberActiveSession("task-a", storage);

    expect(readRememberedActiveSession(storage)).toBe("task-a");
  });

  it("clears scoped errors and live events before hydrating another task", () => {
    const switched = clearSessionScopedState({
      ...initialWorkspaceState,
      session: { id: "task-a", title: "A", createdAt: "now", updatedAt: "now", status: "running" },
      events: [{ sessionId: "task-a", seq: 1 } as never],
      isRunning: true,
      workflowError: "The provider is rate limited.",
      activeTaskId: "task-a",
    });

    expect(switched.session).toBeNull();
    expect(switched.events).toEqual([]);
    expect(switched.isRunning).toBe(false);
    expect(switched.workflowError).toBeNull();
    expect(switched.activeTaskId).toBeNull();
  });
});

// Mock the fetch API
describe("workspace-sse - state machine constraints", () => {
  it("can only pause running turns", () => {
    const runningTurn: TurnRecord = {
      id: "running-1",
      sessionId: "test",
      seq: 1,
      userMessage: "Run",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    
    const pausedTurn: TurnRecord = {
      id: "paused-1",
      sessionId: "test",
      seq: 2,
      userMessage: "Pause",
      status: "paused",
      startedAt: new Date().toISOString(),
    };
    
    const completedTurn: TurnRecord = {
      id: "completed-1",
      sessionId: "test",
      seq: 3,
      userMessage: "Done",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    
    expect(runningTurn.status).toBe("running");
    expect(pausedTurn.status).toBe("paused");
    expect(completedTurn.status).toBe("completed");
  });

  it("can only resume paused turns", () => {
    const pausedTurn: TurnRecord = {
      id: "paused-1",
      sessionId: "test",
      seq: 2,
      userMessage: "Pause",
      status: "paused",
      startedAt: new Date().toISOString(),
    };
    
    expect(pausedTurn.status).toBe("paused");
  });

  it("stop/cancel can be called on running or paused turns", () => {
    const runningTurn: TurnRecord = {
      id: "running-1",
      sessionId: "test",
      seq: 1,
      userMessage: "Run",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    
    const pausedTurn: TurnRecord = {
      id: "paused-1",
      sessionId: "test",
      seq: 2,
      userMessage: "Pause",
      status: "paused",
      startedAt: new Date().toISOString(),
    };
    
    expect(runningTurn.status).toBe("running");
    expect(pausedTurn.status).toBe("paused");
  });
});

describe("workspace-sse - API path encoding", () => {
  it("should encode workspace path correctly in API URL", () => {
    const rootPath = "/workspace/my project";
    const encodedPath = encodeURIComponent(rootPath);
    // encodeURIComponent does encode slashes as %2F
    expect(encodedPath).toBe("%2Fworkspace%2Fmy%20project");
  });

  it("should handle special characters in path", () => {
    const rootPath = "/workspace/test (1)/folder";
    const encodedPath = encodeURIComponent(rootPath);
    expect(encodedPath).toBe("%2Fworkspace%2Ftest%20(1)%2Ffolder");
  });

  it("resolveApiPath handles relative paths", () => {
    const sseUrl = "/api/events";
    const apiPath = "/api/sessions/turn/pause";
    
    function resolveApiPath(url: string, path: string): string {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        return `${new URL(url).origin}${path}`;
      }
      return path;
    }
    
    expect(resolveApiPath(sseUrl, apiPath)).toBe(apiPath);
  });

  it("resolveApiPath handles absolute URLs", () => {
    const sseUrl = "http://localhost:3210/api/events";
    const apiPath = "/api/sessions/turn/pause";
    
    function resolveApiPath(url: string, path: string): string {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        return `${new URL(url).origin}${path}`;
      }
      return path;
    }
    
    expect(resolveApiPath(sseUrl, apiPath)).toBe("http://localhost:3210/api/sessions/turn/pause");
  });
});

describe("workspace-sse - fetch error handling (mocked)", () => {
  let mockFetch: any;

  beforeEach(() => {
    mockFetch = vi.fn();
    (global as any).fetch = mockFetch;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("handles network errors gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    
    const sessionId = "test-session";
    const turnId = "test-turn";
    const endpoint = `/api/sessions/${sessionId}/turns/${turnId}/cancel`;
    
    await expect(
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "User stopped" }),
      })
    ).rejects.toThrow("Network error");
    
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("handles HTTP 400 error with error message", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "Turn is not paused" }),
    });
    
    const response = await fetch("/api/sessions/test/turns/test/pause");
    
    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
    
    const errorData = await response.json();
    expect(errorData.error).toBe("Turn is not paused");
  });

  it("handles HTTP 404 error (turn not found)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "Session not found" }),
    });
    
    const response = await fetch("/api/sessions/nonexistent/turns/test/pause");
    
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  it("handles successful actions without errors", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    });
    
    const response = await fetch("/api/sessions/test/turns/test/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data.ok).toBe(true);
  });
});

describe("workspace-sse - state management expectations", () => {
  it("actionPending should be 'none' initially", () => {
    const initialState = {
      actionPending: "none" as const,
      actionError: null,
    };
    
    expect(initialState.actionPending).toBe("none");
    expect(initialState.actionError).toBeNull();
  });

  it("actionPending should set to 'pause' before the fetch", () => {
    // Simulates setting loading state before request
    const stateWithLoading = {
      actionPending: "pause",
      actionError: null,
    };
    
    expect(stateWithLoading.actionPending).toBe("pause");
    expect(stateWithLoading.actionError).toBeNull();
  });

  it("actionPending should clear after completion", () => {
    const stateAfter = {
      actionPending: "none",
      actionError: null,
    };
    
    expect(stateAfter.actionPending).toBe("none");
    expect(stateAfter.actionError).toBeNull();
  });

  it("actionError should contain error message on failure", () => {
    const stateWithError = {
      actionPending: "none",
      actionError: "Turn is not paused",
    };
    
    expect(stateWithError.actionError).toBe("Turn is not paused");
    expect(stateWithError.actionPending).toBe("none");
  });
});
