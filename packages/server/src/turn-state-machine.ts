/**
 * R35 Mission B — the canonical turn/task transition graph.
 *
 * Three vocabularies coexist deliberately and are reconciled here, nowhere else:
 * - TurnStatus (runtime): what a single agent turn is doing or waiting for.
 * - WorkflowPhase (engine): which phase an autonomous workflow is in.
 * - TaskStatus (protocol): the status vocabulary surfaced on `task.state_changed`.
 *
 * The session-level SessionStatus mirrors the turn vocabulary plus terminal rest
 * states; the UI's RunLifecycle derives from events, so a state that never appears
 * in an event or persisted record does not exist for users.
 */

import type { TaskStatus, SessionStatus } from "@codeforge/protocol";

export type CanonicalTurnStatus =
  | "idle"
  | "running"
  | "paused"
  | "waiting_for_approval"
  | "waiting_for_question"
  | "waiting_for_free_capacity"
  | "waiting_for_worker"
  | "blocked"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_TURN_STATUSES: ReadonlySet<CanonicalTurnStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const WAITING_TURN_STATUSES: ReadonlySet<CanonicalTurnStatus> = new Set([
  "waiting_for_approval",
  "waiting_for_question",
  "waiting_for_free_capacity",
  "waiting_for_worker",
  "paused",
]);

/** States a persisted turn can be restored from. A turn in `running`/`recovering`
 * without a live process is interrupted, never silently continued. */
export const RESTORABLE_TURN_STATUSES: ReadonlySet<CanonicalTurnStatus> = new Set([
  "running",
  "paused",
  "waiting_for_approval",
  "waiting_for_question",
  "waiting_for_free_capacity",
  "waiting_for_worker",
  "recovering",
]);

/**
 * Legal turn transitions. `idle` only ever leaves via `running`; every active or
 * waiting state may reach a terminal or `cancelled`; waits return to `running`;
 * `recovering` is entered only from a persisted in-flight state on restart.
 */
export const TURN_TRANSITIONS: Readonly<Record<CanonicalTurnStatus, readonly CanonicalTurnStatus[]>> = {
  idle: ["running"],
  running: [
    "paused",
    "waiting_for_approval",
    "waiting_for_question",
    "waiting_for_free_capacity",
    "waiting_for_worker",
    "blocked",
    "recovering",
    "completed",
    "failed",
    "cancelled",
  ],
  paused: ["running", "recovering", "cancelled", "failed"],
  waiting_for_approval: ["running", "cancelled", "failed", "blocked"],
  waiting_for_question: ["running", "cancelled", "failed"],
  waiting_for_free_capacity: ["running", "cancelled", "failed"],
  waiting_for_worker: ["running", "cancelled", "failed", "blocked"],
  blocked: ["cancelled"],
  recovering: ["running", "cancelled", "failed", "blocked"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isLegalTurnTransition(from: CanonicalTurnStatus, to: CanonicalTurnStatus): boolean {
  return TURN_TRANSITIONS[from].includes(to);
}

/**
 * WorkflowPhase → TaskStatus. Total over every phase the engine can emit; a phase
 * absent from this map is a contract defect, not a fallback opportunity.
 */
export const WORKFLOW_PHASE_TO_TASK_STATUS: Readonly<Record<string, TaskStatus>> = {
  received: "received",
  understanding: "reconnaissance",
  inspecting: "reconnaissance",
  building_context: "reconnaissance",
  planning: "planning",
  awaiting_approval: "user_input_required",
  implementing: "implementing",
  verifying: "testing",
  diagnosing: "diagnosing",
  repairing: "repairing",
  reviewing: "reviewing",
  summarizing: "validating",
  completed: "complete",
  blocked: "blocked",
  failed: "failed_safely",
  cancelled: "cancelled",
};

/** TaskStatus values the schema admits but no engine phase emits today. They are
 * reserved API vocabulary, not dead states to remove. */
export const RESERVED_TASK_STATUSES: readonly TaskStatus[] = [
  "decomposition",
  "routing",
  "waiting_for_free_model",
  "quota_exhausted",
];

export function taskStatusForPhase(phase: string): TaskStatus {
  const status = WORKFLOW_PHASE_TO_TASK_STATUS[phase];
  if (!status) throw new Error(`Workflow phase '${phase}' has no canonical task status`);
  return status;
}

/**
 * WorkflowPhase → SessionStatus. Session records may only carry SessionStatus;
 * `blocked` folds into `failed` because the session vocabulary has no blocked
 * terminal (the task-level event keeps the precise outcome).
 */
export const WORKFLOW_PHASE_TO_SESSION_STATUS: Readonly<Record<string, SessionStatus>> = {
  received: "running",
  understanding: "running",
  inspecting: "running",
  building_context: "running",
  planning: "running",
  awaiting_approval: "waiting_for_approval",
  implementing: "running",
  verifying: "running",
  diagnosing: "running",
  repairing: "running",
  reviewing: "running",
  summarizing: "running",
  completed: "completed",
  blocked: "failed",
  failed: "failed",
  cancelled: "cancelled",
};

export function sessionStatusForPhase(phase: string): SessionStatus {
  const status = WORKFLOW_PHASE_TO_SESSION_STATUS[phase];
  if (!status) throw new Error(`Workflow phase '${phase}' has no canonical session status`);
  return status;
}

/** Session records are the durable projection of the active turn. */
export const SESSION_STATUSES: readonly SessionStatus[] = [
  "idle",
  "running",
  "paused",
  "waiting_for_approval",
  "waiting_for_question",
  "waiting_for_free_capacity",
  "recovering",
  "completed",
  "failed",
  "cancelled",
];
