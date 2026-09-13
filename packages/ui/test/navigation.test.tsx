import { describe, expect, it } from "vitest";
import { dedupeSessionSummaries, displaySessionTitle, formatRelativeSessionTime, humanizeSessionStatus, overlayActiveSessionStatus } from "../src/Navigation.js";

describe("formatRelativeSessionTime", () => {
  const now = Date.UTC(2026, 8, 9, 18, 0, 0);

  it("renders compact, stable recency labels for task history", () => {
    expect(formatRelativeSessionTime(undefined, now)).toBeNull();
    expect(formatRelativeSessionTime("invalid", now)).toBeNull();
    expect(formatRelativeSessionTime(new Date(now - 30_000).toISOString(), now)).toBe("now");
    expect(formatRelativeSessionTime(new Date(now - 18 * 60_000).toISOString(), now)).toBe("18m");
    expect(formatRelativeSessionTime(new Date(now - 3 * 60 * 60_000).toISOString(), now)).toBe("3h");
    expect(formatRelativeSessionTime(new Date(now - 2 * 24 * 60 * 60_000).toISOString(), now)).toBe("2d");
  });
});

describe("humanizeSessionStatus (R9 truthful status labels)", () => {
  it("maps internal phase names to user vocabulary", () => {
    expect(humanizeSessionStatus("testing")).toBe("Verifying");
    expect(humanizeSessionStatus("failed_safely")).toBe("Stopped safely");
    expect(humanizeSessionStatus("user_input_required")).toBe("Needs your input");
    expect(humanizeSessionStatus("cancelled")).toBe("Stopped");
    expect(humanizeSessionStatus(undefined)).toBe("Idle");
    expect(humanizeSessionStatus("completed")).toBe("Completed");
  });
});

describe("task-history identity", () => {
  it("shows the selected task's terminal outcome before a stale session refresh catches up", () => {
    const summaries = overlayActiveSessionStatus([
      { id: "task-1", title: "Run", status: "verifying" },
      { id: "task-2", title: "Other", status: "idle" },
    ], "task-1", "completed");
    expect(summaries.map((session) => session.status)).toEqual(["completed", "idle"]);
  });

  it("keeps one row for a session even if the server repeats it during recovery", () => {
    const sessions = dedupeSessionSummaries([
      { id: "task-1", title: "Earlier", updatedAt: "2026-09-09T10:00:00Z" },
      { id: "task-1", title: "Latest", updatedAt: "2026-09-09T11:00:00Z" },
      { id: "task-2", title: "Other", updatedAt: "2026-09-09T10:00:00Z" },
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((session) => session.id === "task-1")?.title).toBe("Latest");
  });

  it("does not render an internal CodeForge bootstrap prompt as a task title", () => {
    expect(displaySessionTitle({ id: "task-1", title: "You are CodeForge, an autonomous coding agent..." })).toBe("CodeForge task");
    expect(displaySessionTitle({ id: "task-2", taskTitle: "Repair the pricing test" })).toBe("Repair the pricing test");
  });
});
