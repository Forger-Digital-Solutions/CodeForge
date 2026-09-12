import { describe, it, expect } from "vitest";
import { buildActivityOverview } from "../src/activity-overview.js";
import type { SessionRecord, TurnRecord, WorkItem } from "@codeforge/sessions";

const NOW = new Date("2026-09-11T12:00:00.000Z");

function iso(daysAgo: number, hour = 10): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function session(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    title: "Task",
    createdAt: iso(0),
    updatedAt: iso(0),
    status: "idle",
    ...overrides,
  } as SessionRecord;
}

function turn(sessionId: string, seq: number, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return { id: `${sessionId}-t${seq}`, sessionId, seq, userMessage: "hi", status: "completed", ...overrides };
}

function runInspection(overrides: Partial<Extract<WorkItem, { kind: "run_inspection" }>> & { id: string; sessionId: string }): WorkItem {
  return {
    kind: "run_inspection",
    runId: `${overrides.id}-run`,
    turnId: `${overrides.id}-turn`,
    executionMode: "agent",
    taskTitle: "Task",
    status: "completed",
    phase: "done",
    workspace: { id: "ws-1", kind: "local" },
    diffs: [],
    verificationAttempts: [],
    repairs: [],
    startedAt: iso(0),
    createdAt: iso(0),
    updatedAt: iso(0),
    ...overrides,
  } as WorkItem;
}

describe("buildActivityOverview", () => {
  it("reports a truthful empty state with zero sessions", () => {
    const result = buildActivityOverview([], new Map(), [], "all", NOW);
    expect(result.hasAnyHistory).toBe(false);
    expect(result.tasks).toBe(0);
    expect(result.messages).toBe(0);
    expect(result.tokens).toBe(0);
    expect(result.currentStreak).toBe(0);
    expect(result.mostUsedModel).toBeNull();
    expect(result.heatmap.every((d) => d.count === 0 && d.level === 0)).toBe(true);
  });

  it("counts tasks as sessions and messages as total turns within the period", () => {
    const sessions = [session({ id: "s1", updatedAt: iso(1) }), session({ id: "s2", updatedAt: iso(40) })];
    const turns = new Map([
      ["s1", [turn("s1", 0, { startedAt: iso(1) }), turn("s1", 1, { startedAt: iso(1) })]],
      ["s2", [turn("s2", 0, { startedAt: iso(40) })]],
    ]);
    const result = buildActivityOverview(sessions, turns, [], "30d", NOW);
    // s2 was last updated 40 days ago -> excluded from the 30d window entirely.
    expect(result.tasks).toBe(1);
    expect(result.messages).toBe(2);
  });

  it("sums tokens only from run_inspection work items, never inventing a total across all turns", () => {
    const sessions = [session({ id: "s1", updatedAt: iso(0) })];
    const turns = new Map([["s1", [turn("s1", 0, { startedAt: iso(0) })]]]);
    const workItems = [
      runInspection({ id: "r1", sessionId: "s1", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, provider: { providerId: "openrouter", modelId: "nemotron" } }),
      runInspection({ id: "r2", sessionId: "s1", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, provider: { providerId: "openrouter", modelId: "nemotron" } }),
    ];
    const result = buildActivityOverview(sessions, turns, workItems, "all", NOW);
    expect(result.tokens).toBe(165);
  });

  it("excludes a run_inspection item whose session falls outside the period, even though the item itself has no separate date filter applied", () => {
    const sessions = [session({ id: "s-old", updatedAt: iso(90) })];
    const turns = new Map([["s-old", [turn("s-old", 0, { startedAt: iso(90) })]]]);
    const workItems = [runInspection({ id: "r1", sessionId: "s-old", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })];
    const result = buildActivityOverview(sessions, turns, workItems, "7d", NOW);
    expect(result.tokens).toBe(0);
    expect(result.tasks).toBe(0);
  });

  it("prefers the agent-run model mode over the session-selection fallback when both exist", () => {
    const sessions = [session({ id: "s1", updatedAt: iso(0), currentModelId: "auto" })];
    const turns = new Map([["s1", [turn("s1", 0, { startedAt: iso(0) })]]]);
    const workItems = [
      runInspection({ id: "r1", sessionId: "s1", provider: { providerId: "openrouter", modelId: "nemotron" } }),
      runInspection({ id: "r2", sessionId: "s1", provider: { providerId: "openrouter", modelId: "nemotron" } }),
    ];
    const result = buildActivityOverview(sessions, turns, workItems, "all", NOW);
    expect(result.mostUsedModel).toEqual({ modelId: "nemotron", count: 2, source: "agent-run" });
  });

  it("falls back to session.currentModelId when no agent-run data exists", () => {
    const sessions = [
      session({ id: "s1", updatedAt: iso(0), currentModelId: "auto" }),
      session({ id: "s2", updatedAt: iso(1), currentModelId: "auto" }),
      session({ id: "s3", updatedAt: iso(2), currentModelId: "topaz" }),
    ];
    const turns = new Map([
      ["s1", [turn("s1", 0, { startedAt: iso(0) })]],
      ["s2", [turn("s2", 0, { startedAt: iso(1) })]],
      ["s3", [turn("s3", 0, { startedAt: iso(2) })]],
    ]);
    const result = buildActivityOverview(sessions, turns, [], "all", NOW);
    expect(result.mostUsedModel).toEqual({ modelId: "auto", count: 2, source: "session-selection" });
  });

  it("computes current streak from consecutive lifetime-active days ending today", () => {
    const sessions = [session({ id: "s1", updatedAt: iso(0) })];
    const turns = new Map([
      ["s1", [turn("s1", 0, { startedAt: iso(0) }), turn("s1", 1, { startedAt: iso(1) }), turn("s1", 2, { startedAt: iso(2) }), turn("s1", 3, { startedAt: iso(5) })]],
    ]);
    const result = buildActivityOverview(sessions, turns, [], "all", NOW);
    // active on day 0,1,2 (consecutive) then a gap before day 5 -> streak is 3, not 4.
    expect(result.currentStreak).toBe(3);
  });

  it("keeps the streak and heatmap identical across every period filter (lifetime, not windowed)", () => {
    const sessions = [session({ id: "s1", updatedAt: iso(0) })];
    const turns = new Map([["s1", [turn("s1", 0, { startedAt: iso(0) }), turn("s1", 1, { startedAt: iso(1) })]]]);
    const all = buildActivityOverview(sessions, turns, [], "all", NOW);
    const sevenDay = buildActivityOverview(sessions, turns, [], "7d", NOW);
    expect(sevenDay.currentStreak).toBe(all.currentStreak);
    expect(sevenDay.heatmap).toEqual(all.heatmap);
  });

  it("produces a 365-day heatmap with correctly bucketed intensity levels", () => {
    const sessions = [session({ id: "s1", updatedAt: iso(0) })];
    const manyTurns = Array.from({ length: 7 }, (_, i) => turn("s1", i, { startedAt: iso(0) }));
    const turns = new Map([["s1", manyTurns]]);
    const result = buildActivityOverview(sessions, turns, [], "all", NOW);
    expect(result.heatmap).toHaveLength(365);
    const today = result.heatmap[result.heatmap.length - 1];
    expect(today.count).toBe(7);
    expect(today.level).toBe(3);
  });

  it("never fabricates a most-used model when nothing has ever been recorded", () => {
    const sessions = [session({ id: "s1", updatedAt: iso(0) })];
    const turns = new Map([["s1", [turn("s1", 0, { startedAt: iso(0) })]]]);
    const result = buildActivityOverview(sessions, turns, [], "all", NOW);
    expect(result.mostUsedModel).toBeNull();
  });
});
