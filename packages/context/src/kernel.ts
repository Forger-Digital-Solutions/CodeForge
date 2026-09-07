import type { ISessionPersistence } from "@codeforge/sessions";

/**
 * FG-3A authoritative Context Kernel.
 *
 * The kernel is the small, structured, always-present L0 projection of runtime truth: the
 * minimum a model (or a replacement model after 8-Bit failover) needs to continue a turn
 * safely without replaying a side effect or forgetting a pending hold. It is built ENTIRELY
 * from persisted `WorkItem`s — never guessed from conversation text, never itself the source
 * of truth. CodeForge runtime persistence (sessions, approvals, steer receipts, verification
 * records) remains authoritative; the kernel is a read-only, reconstructable projection of it
 * (the same MODEL CONTEXT vs RUNTIME STATE distinction 8-Bit's `HandoffContext` already
 * established — see `docs/eight-bit.md`).
 *
 * A context budget may compact, defer, or omit optional repository content, but it may NEVER
 * drop a field of the kernel itself: a pending approval, a pending question, an unconsumed
 * steer, or an already-executed side effect must always be representable. Callers that cannot
 * fit even the kernel into a model's budget must surface that explicitly (see
 * `CONTEXT_CAPACITY_UNKNOWN` in `budget.ts`) rather than silently truncating it.
 */

export type ContextKernelSchemaVersion = "fg3-kernel-1";

export interface KernelCompletedAction {
  kind: "tool_call" | "file_change" | "command";
  summary: string;
  at?: string;
}

export interface KernelApprovalState {
  pending: boolean;
  summary?: string;
}

export interface KernelQuestionState {
  pending: boolean;
  summary?: string;
}

export interface KernelSteerState {
  /** Steers currently queued for this session (durable `user_intent_hold.queuedSteers` plus any
   * `steer_receipt` not yet marked consumed — the union, deduplicated by id). */
  queuedCount: number;
  unconsumedSteerIds: string[];
  /** Most recently consumed steer id, if any — present so a replacement model can be told "this
   * was already applied", never so it can be replayed. */
  lastConsumedSteerId?: string;
}

export interface KernelVerificationState {
  /** CodeForge always requires verification before completion; this is never false today. */
  required: boolean;
  planId?: string;
  latestStatus?: string;
  hasEvidence: boolean;
}

export interface ContextKernel {
  schemaVersion: ContextKernelSchemaVersion;
  sessionId: string;
  turnId?: string;
  runId?: string;
  agentId?: string;
  workstreamId?: string;
  /** Plan/execution revision this kernel reflects, when the caller tracks one (e.g. a
   * ForgeVerify-bound `WorkflowPlan.revision`). Absent, not fabricated, when unknown. */
  executionRevision?: string;
  objective: string;
  constraints: string[];
  changedFiles: string[];
  completedActions: KernelCompletedAction[];
  approval: KernelApprovalState;
  question: KernelQuestionState;
  steer: KernelSteerState;
  verification: KernelVerificationState;
  repositoryIntelligenceCompleteness?: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  generatedAt: string;
}

const MAX_ACTIONS = 25;
const MAX_SUMMARY_LEN = 160;
const MAX_CONSTRAINTS = 20;

function truncate(value: string, max = MAX_SUMMARY_LEN): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface BuildContextKernelParams {
  sessionId: string;
  /** Scope actions/holds to one turn. Omit to summarize the whole session (e.g. session-level
   * steer/hold state that is not turn-scoped). */
  turnId?: string;
  runId?: string;
  agentId?: string;
  workstreamId?: string;
  executionRevision?: string;
  objective: string;
  constraints?: string[];
  repositoryIntelligenceCompleteness?: "COMPLETE" | "PARTIAL" | "UNKNOWN";
}

/**
 * Builds the kernel purely by reading persisted `WorkItem`s — the same durable records
 * `EightBitHandoffBuilder`, `UserIntentHoldController`, and ForgeVerify already treat as
 * authoritative. Bounded and deterministic: identical persisted state always yields an
 * identical kernel (aside from `generatedAt`).
 */
export async function buildContextKernel(
  persistence: ISessionPersistence,
  params: BuildContextKernelParams,
): Promise<ContextKernel> {
  const items = await persistence.getWorkItems(params.sessionId);
  const forTurn = params.turnId
    ? items.filter((item) => "turnId" in item && (item as { turnId?: string }).turnId === params.turnId)
    : items;

  const completedActions: KernelCompletedAction[] = [];
  const changedFiles: string[] = [];
  let approvalPending = false;
  let approvalSummary: string | undefined;
  let questionPending = false;
  let questionSummary: string | undefined;
  const unconsumedSteerIds: string[] = [];
  let lastConsumedSteerId: string | undefined;
  let lastConsumedAt = "";
  let verificationPlanId: string | undefined;
  let verificationStatus: string | undefined;
  let hasEvidence = false;

  for (const item of forTurn) {
    switch (item.kind) {
      case "command":
        if (item.status !== "running") {
          completedActions.push({
            kind: "command",
            summary: truncate(`${item.command}${item.exitCode !== undefined ? ` (exit ${item.exitCode})` : ""}`),
            at: item.completedAt ?? item.startedAt,
          });
        }
        break;
      case "file_change":
        changedFiles.push(item.path);
        completedActions.push({
          kind: "file_change",
          summary: truncate(`${item.changeType} ${item.path} (+${item.additions}/-${item.deletions})`),
          at: item.appliedAt,
        });
        break;
      case "activity":
        if (item.status === "completed") {
          completedActions.push({ kind: "tool_call", summary: truncate(item.title), at: item.completedAt ?? item.startedAt });
        }
        break;
      case "approval":
        if (!item.decision) {
          approvalPending = true;
          approvalSummary = truncate(`${item.tool}: ${item.action}`);
        }
        break;
      case "question":
        if (!item.answer) {
          questionPending = true;
          questionSummary = truncate(item.prompt);
        }
        break;
      case "steer_receipt":
        if (item.consumedAt) {
          if (item.consumedAt > lastConsumedAt) {
            lastConsumedAt = item.consumedAt;
            lastConsumedSteerId = item.steerId;
          }
        } else {
          unconsumedSteerIds.push(item.steerId);
        }
        break;
      default:
        break;
    }
  }

  // `verification` WorkItems carry no `turnId` (they are scoped by `runId`, not by turn), so
  // they are read from the unfiltered `items` list — filtering them through `forTurn` would
  // silently exclude every verification record whenever a `turnId` is given, which is the
  // common case. Scoped by `runId` when the caller supplies one; otherwise session-wide (a
  // session's most recent verification state remains visible rather than disappearing).
  const verificationItems = params.runId ? items.filter((item) => item.kind === "verification" && item.runId === params.runId) : items;
  for (const item of verificationItems) {
    if (item.kind !== "verification") continue;
    if (item.recordType === "plan") verificationPlanId = item.planId;
    if (item.recordType === "attempt" && typeof item.status === "string") verificationStatus = item.status;
    if (item.recordType === "evidence") hasEvidence = true;
  }

  // Belt-and-braces: `steer_receipt` is the durable exactly-once source of truth, but the
  // session-scoped `user_intent_hold` record mirrors the current queue and may reference a
  // steer whose receipt row predates a schema/migration boundary — folding it in never
  // duplicates (Set-deduplicated) and never replaces the receipt-derived state above.
  const holdItem = items.find((item): item is Extract<typeof item, { kind: "user_intent_hold" }> => item.kind === "user_intent_hold");
  let queuedCount = unconsumedSteerIds.length;
  if (holdItem) {
    queuedCount = Math.max(queuedCount, holdItem.queuedSteers.length);
    for (const steer of holdItem.queuedSteers) {
      if (!unconsumedSteerIds.includes(steer.steerId)) unconsumedSteerIds.push(steer.steerId);
    }
  }

  completedActions.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  return {
    schemaVersion: "fg3-kernel-1",
    sessionId: params.sessionId,
    turnId: params.turnId,
    runId: params.runId,
    agentId: params.agentId,
    workstreamId: params.workstreamId,
    executionRevision: params.executionRevision,
    objective: truncate(params.objective, 400),
    constraints: (params.constraints ?? []).slice(0, MAX_CONSTRAINTS).map((constraint) => truncate(constraint, 200)),
    changedFiles: [...new Set(changedFiles)],
    completedActions: completedActions.slice(-MAX_ACTIONS),
    approval: { pending: approvalPending, ...(approvalSummary ? { summary: approvalSummary } : {}) },
    question: { pending: questionPending, ...(questionSummary ? { summary: questionSummary } : {}) },
    steer: {
      queuedCount,
      unconsumedSteerIds: [...new Set(unconsumedSteerIds)],
      ...(lastConsumedSteerId ? { lastConsumedSteerId } : {}),
    },
    verification: {
      required: true,
      ...(verificationPlanId ? { planId: verificationPlanId } : {}),
      ...(verificationStatus ? { latestStatus: verificationStatus } : {}),
      hasEvidence,
    },
    ...(params.repositoryIntelligenceCompleteness ? { repositoryIntelligenceCompleteness: params.repositoryIntelligenceCompleteness } : {}),
    generatedAt: new Date().toISOString(),
  };
}

export interface MinimalContextKernelParams {
  sessionId: string;
  objective: string;
  constraints?: string[];
  repositoryIntelligenceCompleteness?: "COMPLETE" | "PARTIAL" | "UNKNOWN";
}

/**
 * A synchronous, no-persistence-required kernel for callers that have no `ISessionPersistence`
 * to read from (e.g. a standalone context-assembly call with only a workspace path). Every
 * runtime-state field is honestly empty/false rather than fabricated — this is what "no
 * authoritative runtime state is available" looks like, never a guess at what it might be.
 */
export function createMinimalContextKernel(params: MinimalContextKernelParams): ContextKernel {
  return {
    schemaVersion: "fg3-kernel-1",
    sessionId: params.sessionId,
    objective: truncate(params.objective, 400),
    constraints: (params.constraints ?? []).slice(0, MAX_CONSTRAINTS).map((constraint) => truncate(constraint, 200)),
    changedFiles: [],
    completedActions: [],
    approval: { pending: false },
    question: { pending: false },
    steer: { queuedCount: 0, unconsumedSteerIds: [] },
    verification: { required: true, hasEvidence: false },
    ...(params.repositoryIntelligenceCompleteness ? { repositoryIntelligenceCompleteness: params.repositoryIntelligenceCompleteness } : {}),
    generatedAt: new Date().toISOString(),
  };
}

/** Deterministic, bounded text rendering of a kernel for injection into model-visible context
 * (a handoff system message, or the leading L0 section of an assembled context prompt). Never
 * wrapped as untrusted data — this is runtime-generated, not repository/user prose. */
export function renderContextKernel(kernel: ContextKernel): string {
  const lines: string[] = [`Objective: ${kernel.objective}`];
  if (kernel.constraints.length > 0) lines.push(`Constraints: ${kernel.constraints.join("; ")}`);
  if (kernel.completedActions.length > 0) {
    lines.push("Already completed this turn (do not repeat):");
    for (const action of kernel.completedActions) lines.push(`- [${action.kind}] ${action.summary}`);
  }
  if (kernel.changedFiles.length > 0) {
    lines.push(`Files already changed this turn: ${kernel.changedFiles.join(", ")}`);
  }
  if (kernel.approval.pending) {
    lines.push(`An approval is pending${kernel.approval.summary ? ` (${kernel.approval.summary})` : ""} — do not assume it was granted.`);
  }
  if (kernel.question.pending) {
    lines.push(`A question to the user is pending${kernel.question.summary ? ` (${kernel.question.summary})` : ""} — do not assume it was answered.`);
  }
  if (kernel.steer.unconsumedSteerIds.length > 0) {
    lines.push(`${kernel.steer.unconsumedSteerIds.length} user steering instruction(s) are queued and not yet applied.`);
  }
  if (kernel.steer.lastConsumedSteerId) {
    lines.push(`Most recently applied steering instruction: ${kernel.steer.lastConsumedSteerId} (do not re-apply it).`);
  }
  if (kernel.verification.required) {
    lines.push(
      `Verification is still required before this task may be reported complete${
        kernel.verification.latestStatus ? ` (latest recorded status: ${kernel.verification.latestStatus})` : ""
      }.`,
    );
  }
  if (kernel.repositoryIntelligenceCompleteness) {
    lines.push(`Repository intelligence completeness: ${kernel.repositoryIntelligenceCompleteness} (do not treat as more complete than reported).`);
  }
  return lines.join("\n");
}
