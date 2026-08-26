import { describe, expect, it } from "vitest";
import {
  WorkspaceEventSchema,
  SessionStatusSchema,
  PlanStepStatusSchema,
  PlanStatusSchema,
  ApprovalDecisionSchema,
  DisplayModeSchema,
  ChangeTypeSchema,
  AgentStatusSchema,
  ArtifactTypeSchema,
  RestoreTypeSchema,
  CommandStreamSchema,
  RiskLevelSchema,
  PermissionPolicySchema,
  EvidenceReferenceKindSchema,
  ContextReferenceTypeSchema,
  isWorkspaceEvent,
} from "@codeforge/protocol";
import { SessionRecordSchema, TurnRecordSchema, WorkItemSchema, isWorkItem, isWorkItemKind } from "@codeforge/sessions";

describe("Protocol — schema validation", () => {
  it("accepts valid session status values", () => {
    for (const value of ["idle", "running", "paused", "waiting_for_approval", "waiting_for_question", "completed", "failed", "cancelled"]) {
      expect(SessionStatusSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rejects invalid session status", () => {
    expect(SessionStatusSchema.safeParse("unknown").success).toBe(false);
  });

  it("accepts valid plan step status values", () => {
    for (const value of ["queued", "active", "completed", "blocked", "failed", "skipped"]) {
      expect(PlanStepStatusSchema.safeParse(value).success).toBe(true);
    }
  });

  it("accepts valid change types", () => {
    for (const value of ["created", "modified", "deleted"]) {
      expect(ChangeTypeSchema.safeParse(value).success).toBe(true);
    }
  });

  it("accepts valid approval decisions", () => {
    for (const value of ["allow_once", "allow_session", "deny"]) {
      expect(ApprovalDecisionSchema.safeParse(value).success).toBe(true);
    }
  });

  it("accepts valid risk levels", () => {
    for (const value of ["safe", "moderate", "high", "critical"]) {
      expect(RiskLevelSchema.safeParse(value).success).toBe(true);
    }
  });

  it("accepts valid context reference types", () => {
    for (const value of ["file", "folder", "symbol", "project", "branch", "session", "artifact", "test"]) {
      expect(ContextReferenceTypeSchema.safeParse(value).success).toBe(true);
    }
  });

  it("accepts representative valid workspace events", () => {
    const base = (type: string, payload: Record<string, unknown>) => ({
      type,
      timestamp: new Date().toISOString(),
      seq: 1,
      sessionId: "sess-1",
      payload,
    });
    expect(WorkspaceEventSchema.safeParse(base("turn.started", { turnId: "t1", userMessage: "Hello" })).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse(base("plan.updated", { planId: "p1", steps: [] })).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse(base("file.change_proposed", { changeId: "c1", path: "a.cs", changeType: "modified", additions: 1, deletions: 0 })).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse(base("approval.requested", { approvalId: "a1", tool: "deploy", action: "Deploy", description: "Deploy app", risk: "high" })).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse(base("question.requested", { questionId: "q1", prompt: "Continue?" })).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse(base("artifact.created", { artifactId: "ar1", type: "plan", title: "Plan" })).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse(base("checkpoint.created", { checkpointId: "ck1", label: "CP", fileCount: 1 })).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse(base("subagent.started", { agentId: "sub1", role: "Builder", task: "Build" })).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse(base("validation.completed", { validationId: "v1", passed: 1, failed: 0, skipped: 0 })).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse(base("evidence.created", { evidenceId: "e1", conclusion: "Done", references: [] })).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse(base("status.changed", { from: "idle", to: "running" })).success).toBe(true);
  });

  it("rejects workspace event with invalid type", () => {
    const event = {
      type: "invalid.type",
      timestamp: new Date().toISOString(),
      seq: 1,
      sessionId: "sess-1",
      payload: {},
    };
    expect(WorkspaceEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects workspace event missing required fields", () => {
    expect(WorkspaceEventSchema.safeParse({}).success).toBe(false);
    expect(WorkspaceEventSchema.safeParse({ type: "turn.started" }).success).toBe(false);
    expect(WorkspaceEventSchema.safeParse({ type: "turn.started", timestamp: new Date().toISOString() }).success).toBe(false);
  });

  it("accepts valid SessionRecord", () => {
    const record = {
      id: "sess-1",
      title: "Test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
    };
    expect(SessionRecordSchema.safeParse(record).success).toBe(true);
  });

  it("rejects SessionRecord with invalid status", () => {
    const record = {
      id: "sess-1",
      title: "Test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "invalid",
    };
    expect(SessionRecordSchema.safeParse(record).success).toBe(false);
  });

  it("accepts valid TurnRecord", () => {
    const record = {
      id: "turn-1",
      sessionId: "sess-1",
      seq: 0,
      userMessage: "Hello",
      status: "running",
    };
    expect(TurnRecordSchema.safeParse(record).success).toBe(true);
  });

  it("accepts valid work item kinds", () => {
    const kinds = ["activity", "plan", "command", "file_change", "approval", "question", "artifact", "test_run", "agent", "checkpoint", "evidence", "context_ref"] as const;
    for (const kind of kinds) {
      expect(isWorkItemKind({ kind, id: "1", sessionId: "s1" } as never, kind)).toBe(true);
    }
  });

  it("rejects work item with unknown kind", () => {
    expect(isWorkItem({ kind: "unknown", id: "1", sessionId: "s1" } as never)).toBe(false);
  });

  it("accepts valid artifact work item", () => {
    const item = {
      kind: "artifact",
      id: "art-1",
      sessionId: "sess-1",
      type: "plan",
      title: "Test Artifact",
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(WorkItemSchema.safeParse(item).success).toBe(true);
  });

  it("rejects artifact with invalid type enum", () => {
    const item = {
      kind: "artifact",
      id: "art-1",
      sessionId: "sess-1",
      type: "invalid_type",
      title: "Test",
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(WorkItemSchema.safeParse(item).success).toBe(false);
  });
});
