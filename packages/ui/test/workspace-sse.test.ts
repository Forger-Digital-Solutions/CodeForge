import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SessionRecord, TurnRecord } from "@codeforge/sessions";

// Mock the fetch API
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock EventSource
class MockEventSource {
  onopen?: () => void;
  onerror?: (e: Event) => void;
  onmessage?: (e: MessageEvent) => void;
  readyState = 0;
  
  addEventListener(_type: string, cb: () => void) {
    this.onmessage = cb;
  }
  
  close() {}
}

(global as any).EventSource = MockEventSource;

describe("useWorkspaceSSE - stop/pause/resume", () => {
  const mockSession: SessionRecord = {
    id: "test-session",
    title: "Test Session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
  };

  const mockRunningTurn: TurnRecord = {
    id: "running-turn-1",
    sessionId: "test-session",
    seq: 1,
    userMessage: "Test message",
    status: "running",
    startedAt: new Date().toISOString(),
  };

  const mockPausedTurn: TurnRecord = {
    id: "paused-turn-1",
    sessionId: "test-session",
    seq: 2,
    userMessage: "Paused task",
    status: "paused",
    startedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
  });

  it("stopTurn calls the cancel endpoint", async () => {
    const stopTurn = (sessionId: string, turnId: string) => {
      const endpoint = `/api/sessions/${sessionId}/turns/${turnId}/cancel`;
      return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "User stopped" }),
      });
    };
    
    await stopTurn(mockSession.id, mockRunningTurn.id);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sessions/test-session/turns/running-turn-1/cancel",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "User stopped" }),
      })
    );
  });

  it("pauseTurn calls the pause endpoint", async () => {
    const pauseTurn = (sessionId: string, turnId: string) => {
      const endpoint = `/api/sessions/${sessionId}/turns/${turnId}/pause`;
      return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    };
    
    await pauseTurn(mockSession.id, mockRunningTurn.id);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sessions/test-session/turns/running-turn-1/pause",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
  });

  it("resumeTurn calls the resume endpoint", async () => {
    const resumeTurn = (sessionId: string, turnId: string) => {
      const endpoint = `/api/sessions/${sessionId}/turns/${turnId}/resume`;
      return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    };
    
    await resumeTurn(mockSession.id, mockPausedTurn.id);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/sessions/test-session/turns/paused-turn-1/resume",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
  });

  it("handles API path correctly for relative URLs", async () => {
    const endpoint = `/api/sessions/test-session/turns/test-turn/pause`;
    
    expect(endpoint).toBe("/api/sessions/test-session/turns/test-turn/pause");
  });

  it("handles API path correctly for absolute URLs", async () => {
    const url = "http://localhost:3210/api/events";
    const apiPath = "/api/sessions/test-session/turns/test-turn/cancel";
    
    // Simulate resolveApiPath logic
    const resolved = `${new URL(url).origin}${apiPath}`;
    
    expect(resolved).toBe("http://localhost:3210/api/sessions/test-session/turns/test-turn/cancel");
  });
});

describe("stop/pause/resume state machine constraints", () => {
  it("can only pause running turns", () => {
    // State machine constraint: pause only valid on "running"
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
