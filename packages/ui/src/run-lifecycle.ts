import type { RunFailure, RunOutcome, WorkspaceEvent } from "@codeforge/protocol";
import type { SessionRecord, TurnRecord } from "@codeforge/sessions";

/**
 * The canonical state of a task run.
 *
 * Every visible surface — sidebar row, task header, composer, status line, controls, thread —
 * reads ONE `RunLifecycle` derived here from the session's durable events (plus the persisted
 * session/turn records as a fallback for history that predates the events). Nothing else may
 * interpret run state; that is what made "Failed" and "Agent working" show at the same time.
 *
 * Non-terminal states describe what CodeForge is doing or waiting for. Terminal states are
 * final for the run: once reached, no later bookkeeping event for the same run can revive it —
 * only a NEW run (a new request, a "fix and continue", a resume) starts a new lifecycle.
 */
export type RunState =
  | "IDLE"
  | "QUEUED"
  | "ROUTING"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "WAITING_FOR_INPUT"
  | "WAITING_FOR_CAPACITY"
  | "VERIFYING"
  | "REPAIRING"
  | "REVIEWING"
  | "REROUTING"
  | "PAUSED"
  | "INTERRUPTED"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  | "ROUTE_EXHAUSTED";

export type RunPhase =
  | "exploring"
  | "planning"
  | "implementing"
  | "verifying"
  | "diagnosing"
  | "repairing"
  | "reviewing"
  | "summarizing"
  | "answering";

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "ROUTE_EXHAUSTED"]);
export const WAITING_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(["WAITING_FOR_APPROVAL", "WAITING_FOR_INPUT", "WAITING_FOR_CAPACITY", "PAUSED", "INTERRUPTED"]);

export type RunOutcomePayload = RunOutcome["payload"];

export interface RunLifecycle {
  state: RunState;
  phase?: RunPhase;
  /** No later event for this run may change the state. */
  terminal: boolean;
  /** CodeForge is actively doing work right now (spinner / elapsed timer are truthful). */
  active: boolean;
  /** Progress depends on the user (approval, answer, resume). */
  waitingOnUser: boolean;
  executionMode?: "agent" | "chat";
  /** The workflow task id (agent) or the root turn id (chat). */
  runId?: string;
  rootTurnId?: string;
  /** The runtime turn currently executing under this run; the target for pause/resume. */
  activeTurnId?: string;
  /** A runtime turn left interrupted by a restart; the target for resume/discard. */
  interruptedTurnId?: string;
  startedAt?: string;
  endedAt?: string;
  /** The single terminal record, when the run emitted one. */
  outcome?: RunOutcomePayload;
  /** Why the run stopped, when it stopped for a failure. */
  failure?: RunFailure;
  /** Reason code for terminal states without a structured failure (e.g. "user_stopped"). */
  reasonCode?: string;
  /** Implementation attempts including repairs (1 = first attempt). */
  attempt: number;
  /** How many times 8-Bit switched routes during the run. */
  reroutes: number;
  route?: { providerId: string; modelId: string };
  /** A bounded same-route wait 8-Bit is sitting out right now. */
  cooldown?: string;
  /** Route exhaustion was announced during the run (terminal record may still be pending). */
  routeExhaustedAnnounced?: boolean;
  /** The lifecycle came from persisted records, not from a live event stream. */
  restored?: boolean;
}

export const IDLE_LIFECYCLE: RunLifecycle = Object.freeze({
  state: "IDLE",
  terminal: false,
  active: false,
  waitingOnUser: false,
  attempt: 0,
  reroutes: 0,
}) as RunLifecycle;

export interface RunLifecycleContext {
  session?: SessionRecord | null;
  turns?: TurnRecord[];
  /** Approvals the server reports as still awaiting a decision (authoritative on hydrate). */
  pendingApprovals?: number;
  pendingQuestion?: boolean;
}

function finalize(base: RunLifecycle, patch: Partial<RunLifecycle>): RunLifecycle {
  const next = { ...base, ...patch };
  next.terminal = TERMINAL_RUN_STATES.has(next.state);
  next.waitingOnUser = WAITING_RUN_STATES.has(next.state);
  next.active = !next.terminal && !next.waitingOnUser && next.state !== "IDLE";
  return next;
}

const TASK_PHASE_TRANSITIONS: Record<string, { state: RunState; phase?: RunPhase }> = {
  received: { state: "QUEUED" },
  reconnaissance: { state: "RUNNING", phase: "exploring" },
  understanding: { state: "RUNNING", phase: "exploring" },
  inspecting: { state: "RUNNING", phase: "exploring" },
  building_context: { state: "RUNNING", phase: "exploring" },
  planning: { state: "RUNNING", phase: "planning" },
  user_input_required: { state: "WAITING_FOR_APPROVAL", phase: "planning" },
  awaiting_approval: { state: "WAITING_FOR_APPROVAL", phase: "planning" },
  implementing: { state: "RUNNING", phase: "implementing" },
  testing: { state: "VERIFYING", phase: "verifying" },
  verifying: { state: "VERIFYING", phase: "verifying" },
  diagnosing: { state: "VERIFYING", phase: "diagnosing" },
  repairing: { state: "REPAIRING", phase: "repairing" },
  reviewing: { state: "REVIEWING", phase: "reviewing" },
  validating: { state: "RUNNING", phase: "summarizing" },
  summarizing: { state: "RUNNING", phase: "summarizing" },
};

const TASK_TERMINAL_TRANSITIONS: Record<string, RunState> = {
  complete: "COMPLETED",
  completed: "COMPLETED",
  blocked: "BLOCKED",
  failed_safely: "FAILED",
  failed: "FAILED",
  cancelled: "CANCELLED",
};

function outcomeToState(outcome: RunOutcomePayload["outcome"]): RunState {
  switch (outcome) {
    case "completed": return "COMPLETED";
    case "blocked": return "BLOCKED";
    case "cancelled": return "CANCELLED";
    case "route_exhausted": return "ROUTE_EXHAUSTED";
    default: return "FAILED";
  }
}

/**
 * Terminal state for a session record whose run emitted no `run.outcome` (history written by
 * earlier versions, or a run that ended by the persisted records only).
 */
export function lifecycleFromSessionRecord(session: SessionRecord | null | undefined, turns: TurnRecord[] = []): RunLifecycle | null {
  if (!session) return null;
  const inFlightTurn = turns.find((turn) => ["running", "paused", "recovering", "waiting_for_approval", "waiting_for_question", "waiting_for_free_capacity"].includes(String(turn.status)));
  const status = String(session.status);
  const outcome = session.outcome;
  const lastTurn = [...turns].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "")).at(-1);
  const base: RunLifecycle = { ...IDLE_LIFECYCLE, restored: true, rootTurnId: lastTurn?.id, ...(lastTurn?.startedAt ? { startedAt: lastTurn.startedAt } : {}) };
  if (status === "recovering" || inFlightTurn?.status === "recovering") {
    return finalize(base, { state: "INTERRUPTED", reasonCode: "interrupted", interruptedTurnId: inFlightTurn?.status === "recovering" ? inFlightTurn.id : undefined });
  }
  if (inFlightTurn?.status === "paused") return finalize(base, { state: "PAUSED", activeTurnId: inFlightTurn.id });
  if (inFlightTurn?.status === "waiting_for_approval") return finalize(base, { state: "WAITING_FOR_APPROVAL", activeTurnId: inFlightTurn.id });
  if (inFlightTurn?.status === "waiting_for_question") return finalize(base, { state: "WAITING_FOR_INPUT", activeTurnId: inFlightTurn.id });
  // A durable capacity wait survives restart — the record IS the parked turn, not a dead run.
  if (inFlightTurn?.status === "waiting_for_free_capacity" || status === "waiting_for_free_capacity") {
    return finalize(base, { state: "WAITING_FOR_CAPACITY", activeTurnId: inFlightTurn?.id });
  }
  if (inFlightTurn?.status === "running") return finalize(base, { state: "RUNNING", activeTurnId: inFlightTurn.id });
  const endedAt = lastTurn?.completedAt ? { endedAt: lastTurn.completedAt } : {};
  switch (status) {
    case "completed":
    case "complete":
      return finalize(base, { state: "COMPLETED", reasonCode: outcome ?? "completed", ...endedAt });
    case "cancelled":
      return finalize(base, { state: "CANCELLED", reasonCode: outcome ?? "user_stopped", ...endedAt });
    case "blocked":
      return finalize(base, { state: "BLOCKED", reasonCode: outcome ?? "blocked", ...endedAt });
    case "failed":
    case "failed_safely": {
      const state: RunState = outcome === "route_exhausted" ? "ROUTE_EXHAUSTED" : outcome === "interrupted" ? "FAILED" : "FAILED";
      const error = lastTurn?.status === "failed" && lastTurn.error ? lastTurn.error : undefined;
      return finalize(base, {
        state,
        reasonCode: outcome ?? "failed",
        ...(error ? { failure: { code: outcome === "route_exhausted" ? "route_exhausted" : "unknown", ownership: outcome === "route_exhausted" ? "managed_free" : "runtime", message: error } } : {}),
        ...endedAt,
      });
    }
    case "running":
      // The record says running but no turn is in flight: the process that ran it is gone.
      return finalize(base, { state: "INTERRUPTED", reasonCode: "interrupted" });
    case "idle":
    case "":
      return finalize(base, { state: "IDLE" });
    default:
      // Persisted workflow phases ("testing", "reviewing", …) with no live process behind them.
      return finalize(base, { state: "INTERRUPTED", reasonCode: "interrupted" });
  }
}

/**
 * Derive the run lifecycle from a session's ordered events. Pure and replay-safe: the same
 * events always give the same lifecycle, so a reload, an SSE reconnect and a live stream agree.
 */
export function deriveRunLifecycle(events: readonly WorkspaceEvent[], context: RunLifecycleContext = {}): RunLifecycle {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let run: RunLifecycle = { ...IDLE_LIFECYCLE };
  let sawRunEvents = false;
  const internalTurns = new Set<string>();
  let stateBeforeReroute: { state: RunState; phase?: RunPhase } | null = null;
  let pendingApprovals = 0;
  let pendingQuestion = false;

  const startRun = (patch: Partial<RunLifecycle>, timestamp: string): void => {
    run = finalize({ ...IDLE_LIFECYCLE, startedAt: timestamp, attempt: 0, reroutes: 0 }, { state: "QUEUED", ...patch });
    internalTurns.clear();
    stateBeforeReroute = null;
    pendingApprovals = 0;
    pendingQuestion = false;
    sawRunEvents = true;
  };
  const setState = (state: RunState, patch: Partial<RunLifecycle> = {}): void => {
    if (run.terminal) return;
    run = finalize(run, { state, ...patch });
  };
  const endRun = (state: RunState, patch: Partial<RunLifecycle>, timestamp: string): void => {
    if (run.terminal) return;
    run = finalize(run, { state, endedAt: timestamp, activeTurnId: undefined, cooldown: undefined, ...patch });
  };
  const resumeAfterWait = (): void => {
    if (run.terminal) return;
    const phase = run.phase;
    const state: RunState = phase === "verifying" || phase === "diagnosing" ? "VERIFYING" : phase === "repairing" ? "REPAIRING" : phase === "reviewing" ? "REVIEWING" : "RUNNING";
    setState(state);
  };

  for (const event of ordered) {
    switch (event.type) {
      case "execution.requested": {
        // A new request always starts a new run, whatever the previous one was doing.
        startRun({ executionMode: event.payload.executionMode }, event.timestamp);
        break;
      }
      case "task.created": {
        if (run.terminal || run.state === "IDLE" || (run.runId && run.runId !== event.payload.taskId)) startRun({ executionMode: "agent" }, event.timestamp);
        setState("QUEUED", { runId: event.payload.taskId, executionMode: "agent" });
        break;
      }
      case "task.started": {
        if (run.terminal || run.state === "IDLE") startRun({ executionMode: "agent" }, event.timestamp);
        setState("ROUTING", { runId: event.payload.taskId, executionMode: "agent" });
        break;
      }
      case "turn.started": {
        const { turnId, origin } = event.payload;
        if (origin === "workflow") {
          internalTurns.add(turnId);
          if (!run.terminal && run.state !== "IDLE") {
            run = finalize(run, { activeTurnId: turnId, attempt: run.attempt + 1, interruptedTurnId: undefined });
            if (run.state === "QUEUED" || run.state === "ROUTING") setState("RUNNING", { phase: run.phase ?? "implementing" });
          }
          break;
        }
        // A user-authored turn: the root of a chat run, or the root of a workflow run (which
        // `task.created` already opened). Either way it never interrupts a live run of its own.
        if (run.terminal || run.state === "IDLE") startRun({ executionMode: run.executionMode ?? "chat" }, event.timestamp);
        const isWorkflowRoot = run.executionMode === "agent" && run.runId !== undefined;
        run = finalize(run, {
          rootTurnId: turnId,
          ...(isWorkflowRoot ? {} : { runId: run.runId ?? turnId, executionMode: "chat", activeTurnId: turnId, attempt: Math.max(1, run.attempt) }),
        });
        if (!isWorkflowRoot) setState("ROUTING", { phase: "answering" });
        break;
      }
      case "router.selection": {
        if (run.terminal) break;
        run = finalize(run, { route: { providerId: event.payload.providerId, modelId: event.payload.modelId } });
        if (run.state === "ROUTING") setState("RUNNING");
        break;
      }
      case "task.state_changed": {
        if (run.terminal) break;
        if (run.state === "IDLE") startRun({ executionMode: "agent", runId: event.payload.taskId }, event.timestamp);
        const to = event.payload.to;
        const terminal = TASK_TERMINAL_TRANSITIONS[to];
        if (terminal) {
          endRun(terminal, { reasonCode: run.reasonCode ?? (terminal === "CANCELLED" ? "user_stopped" : terminal.toLowerCase()) }, event.timestamp);
          break;
        }
        const transition = TASK_PHASE_TRANSITIONS[to];
        if (!transition) break;
        // A pending approval/question keeps its wait state; the phase still advances.
        if (pendingApprovals > 0 && transition.state !== "WAITING_FOR_APPROVAL") {
          run = finalize(run, { phase: transition.phase ?? run.phase });
          break;
        }
        stateBeforeReroute = null;
        setState(transition.state, { phase: transition.phase ?? run.phase });
        break;
      }
      case "approval.requested": {
        if (run.terminal) break;
        pendingApprovals += 1;
        stateBeforeReroute = null;
        setState("WAITING_FOR_APPROVAL");
        break;
      }
      case "approval.resolved": {
        if (run.terminal) break;
        pendingApprovals = Math.max(0, pendingApprovals - 1);
        if (pendingApprovals === 0 && run.state === "WAITING_FOR_APPROVAL") resumeAfterWait();
        break;
      }
      case "question.requested": {
        if (run.terminal) break;
        pendingQuestion = true;
        setState("WAITING_FOR_INPUT");
        break;
      }
      case "question.resolved": {
        if (run.terminal) break;
        pendingQuestion = false;
        if (run.state === "WAITING_FOR_INPUT") resumeAfterWait();
        break;
      }
      case "turn.paused": {
        if (run.terminal) break;
        stateBeforeReroute = null;
        setState("PAUSED", { activeTurnId: event.payload.turnId });
        break;
      }
      case "turn.resumed": {
        if (run.terminal) break;
        if (run.state === "PAUSED" || run.state === "INTERRUPTED" || run.state === "WAITING_FOR_CAPACITY") resumeAfterWait();
        break;
      }
      case "turn.recovery": {
        if (run.terminal) break;
        const { phase, turnId } = event.payload;
        if (phase === "hydrated" || phase === "replan_required" || phase === "blocked") {
          setState("INTERRUPTED", { reasonCode: "interrupted", interruptedTurnId: turnId, activeTurnId: undefined });
        } else if (phase === "resumed" || phase === "replan_started") {
          run = finalize(run, { interruptedTurnId: undefined, activeTurnId: turnId });
          setState("RUNNING");
        }
        break;
      }
      case "eightbit.status": {
        if (run.terminal) break;
        const p = event.payload;
        if (p.event === "ROUTE_ROTATION_STARTED") {
          if (run.state !== "REROUTING") stateBeforeReroute = { state: run.state, phase: run.phase };
          setState("REROUTING", { cooldown: undefined });
        } else if (p.event === "ROUTE_READY" || p.event === "ROUTE_ROTATED") {
          const route = p.selected ? { route: { providerId: p.selected.providerId, modelId: p.selected.modelId } } : {};
          const back = stateBeforeReroute ?? { state: "RUNNING" as RunState, phase: run.phase };
          stateBeforeReroute = null;
          setState(back.state === "REROUTING" ? "RUNNING" : back.state, { phase: back.phase, reroutes: run.reroutes + (p.event === "ROUTE_READY" ? 1 : 0), cooldown: undefined, ...route });
        } else if (p.event === "ROUTE_COOLDOWN") {
          run = finalize(run, { cooldown: p.accessibleText });
        } else if (p.event === "FREE_CAPACITY_WAIT") {
          // The runtime parked the turn durably — nonterminal, resumable, never a failure.
          setState("WAITING_FOR_CAPACITY", { cooldown: p.accessibleText });
        } else if (p.event === "NO_ELIGIBLE_FREE_MODEL") {
          run = finalize(run, { routeExhaustedAnnounced: true, cooldown: undefined });
        }
        break;
      }
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled": {
        const turnId = event.payload.turnId;
        if (run.terminal) break;
        if (internalTurns.has(turnId)) {
          // An internal implement/repair turn ended; the workflow decides what happens next and
          // will say so with its own events. Only the pause/stop target changes.
          run = finalize(run, { activeTurnId: run.activeTurnId === turnId ? undefined : run.activeTurnId, cooldown: undefined });
          if (run.state === "REROUTING") { stateBeforeReroute = null; setState("RUNNING"); }
          break;
        }
        if (run.executionMode === "agent" && run.rootTurnId && turnId !== run.rootTurnId) break;
        if (event.type === "turn.completed") {
          endRun("COMPLETED", { reasonCode: "completed" }, event.timestamp);
        } else if (event.type === "turn.cancelled") {
          endRun("CANCELLED", { reasonCode: "user_stopped" }, event.timestamp);
        } else {
          const failure = event.payload.failure;
          const routeExhausted = failure?.code === "route_exhausted" || run.routeExhaustedAnnounced === true;
          endRun(routeExhausted ? "ROUTE_EXHAUSTED" : "FAILED", {
            reasonCode: failure?.code ?? (routeExhausted ? "route_exhausted" : "failed"),
            ...(failure ? { failure } : { failure: { code: routeExhausted ? "route_exhausted" : "unknown", ownership: routeExhausted ? "managed_free" : "runtime", message: event.payload.error } }),
          }, event.timestamp);
        }
        break;
      }
      case "task.completed": {
        endRun("COMPLETED", { reasonCode: "completed" }, event.timestamp);
        break;
      }
      case "task.cancelled": {
        endRun("CANCELLED", { reasonCode: /timed out/i.test(event.payload.reason ?? "") ? "timed_out" : "user_stopped" }, event.timestamp);
        break;
      }
      case "run.outcome": {
        // The authoritative terminal record: it may confirm a state reached through the phase
        // events, or refine it (a "failed" phase whose real reason is route exhaustion).
        const payload = event.payload;
        run = finalize(run, {
          state: outcomeToState(payload.outcome),
          endedAt: run.endedAt ?? event.timestamp,
          outcome: payload,
          reasonCode: payload.reasonCode,
          ...(payload.failure ? { failure: payload.failure } : {}),
          activeTurnId: undefined,
          cooldown: undefined,
        });
        break;
      }
      case "execution.start_failed": {
        if (run.state === "IDLE") startRun({ executionMode: event.payload.executionMode }, event.timestamp);
        endRun("FAILED", {
          reasonCode: "start_failed",
          failure: { code: "start_failed", ownership: "runtime", message: event.payload.message },
        }, event.timestamp);
        break;
      }
      default:
        break;
    }
  }

  // Server-authoritative waits (a reload adopts the server's pending list, not replayed events).
  if (!run.terminal && run.state !== "IDLE") {
    if ((context.pendingApprovals ?? pendingApprovals) > 0) run = finalize(run, { state: "WAITING_FOR_APPROVAL" });
    else if (context.pendingQuestion ?? pendingQuestion) run = finalize(run, { state: "WAITING_FOR_INPUT" });
  }

  // Persisted records decide when the events cannot: history without events, a run whose
  // process is gone, or a record the server has already reconciled after a restart.
  const recorded = lifecycleFromSessionRecord(context.session, context.turns);
  if (!sawRunEvents) {
    if (recorded) return recorded;
    // No durable record at all yet (a brand-new draft session): an optimistic "running" turn is
    // the only evidence a run was just sent — present it as such until the first event lands.
    const optimistic = context.turns?.find((turn) => turn.status === "running");
    if (optimistic) {
      return finalize(
        { ...IDLE_LIFECYCLE, restored: true, rootTurnId: optimistic.id, ...(optimistic.startedAt ? { startedAt: optimistic.startedAt } : {}), attempt: 1 },
        { state: "RUNNING", activeTurnId: optimistic.id },
      );
    }
    return run;
  }
  if (recorded && !run.terminal) {
    const sessionStatus = String(context.session?.status ?? "");
    if (sessionStatus === "recovering" || recorded.state === "INTERRUPTED") {
      return finalize(run, { state: "INTERRUPTED", reasonCode: "interrupted", interruptedTurnId: recorded.interruptedTurnId, activeTurnId: undefined, cooldown: undefined });
    }
    if (recorded.terminal) return finalize(run, { state: recorded.state, reasonCode: recorded.reasonCode, ...(recorded.failure ? { failure: recorded.failure } : {}), endedAt: recorded.endedAt, activeTurnId: undefined, cooldown: undefined });
  }
  return run;
}

// ---------------------------------------------------------------------------
// Presentation: the one projection every surface renders from.
// ---------------------------------------------------------------------------

export type RunTone = "idle" | "active" | "waiting" | "paused" | "success" | "danger" | "warning" | "muted";

export interface RunPresentation {
  state: RunState;
  /** Short status word for the header / status line ("Working", "Verifying", "Failed"). */
  label: string;
  /** Slightly longer qualifier, e.g. the phase ("Implementing") or the reason ("Route exhausted"). */
  detail?: string;
  tone: RunTone;
  /** Animated working indicator is truthful. */
  spinner: boolean;
  /** Elapsed timer may run. */
  timer: boolean;
  controls: { stop: boolean; pause: boolean; resume: boolean; discard: boolean; retry: boolean };
  /** What the composer does with a submission right now. */
  composer: "send" | "steer" | "answer" | "approve" | "resume";
  /** Vocabulary for the sidebar row. */
  sidebarStatus: string;
  /** True while the run is in progress in any way (working or waiting). */
  inProgress: boolean;
}

const PHASE_LABELS: Record<RunPhase, string> = {
  exploring: "Exploring the repository",
  planning: "Planning",
  implementing: "Implementing",
  verifying: "Verifying",
  diagnosing: "Diagnosing a failure",
  repairing: "Repairing",
  reviewing: "Reviewing changes",
  summarizing: "Wrapping up",
  answering: "Thinking",
};

/** Human wording for a terminal reason code. Never a raw enum. */
export function describeReasonCode(code: string | undefined, state: RunState): string | undefined {
  switch (code) {
    case undefined: return undefined;
    case "completed": return undefined;
    case "user_stopped": return "Stopped by you";
    case "timed_out": return "Ran out of time";
    case "route_exhausted": return "No verified-free route available";
    case "verification_failed": return "Required verification failed";
    case "verification_not_run": return "Verification did not run";
    case "verification_not_current": return "Verification is not current";
    case "plan_steps_unfinished": return "Implementation did not finish";
    case "implementation_failed": return "Implementation failed";
    case "no_effective_change": return "No effective change";
    case "review_rejected": return "Review found blocking issues";
    case "plan_rejected": return "Plan declined";
    case "budget_exhausted": return "Working budget used up";
    case "provider_auth_failed": return "Provider authentication failed";
    case "provider_rate_limited": return "Provider rate limited";
    case "provider_quota_exhausted": return "Provider quota used up";
    case "provider_capacity": return "Provider at capacity";
    case "provider_outage": return "Provider outage";
    case "provider_timeout": return "Provider timed out";
    case "provider_network": return "Provider unreachable";
    case "model_unavailable": return "Model unavailable";
    case "paid_plan_required": return "Route requires a paid plan";
    case "context_limit": return "Context limit reached";
    case "start_failed": return "Could not start";
    case "interrupted": return "Interrupted by a restart";
    case "workspace_error": return "Workspace problem";
    case "workflow_error": return "Runtime error";
    case "cancelled": return "Stopped";
    default:
      return state === "FAILED" || state === "BLOCKED" ? code.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : undefined;
  }
}

/**
 * The seq of the event that settled the current run, or -1 when no terminal event exists (a
 * restored session, or a run still in flight). Used to scope a dismissal to one terminal outcome
 * so dismissing a failure banner never mutes the NEXT run's outcome.
 */
export function lastTerminalEventSeq(events: readonly WorkspaceEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const type = events[i]!.type;
    if (type === "run.outcome" || type === "execution.start_failed" || type === "task.completed" || type === "task.cancelled") return events[i]!.seq;
    if (type === "turn.completed" || type === "turn.failed" || type === "turn.cancelled") return events[i]!.seq;
  }
  return -1;
}

export function presentRun(lifecycle: RunLifecycle): RunPresentation {
  const off = { stop: false, pause: false, resume: false, discard: false, retry: false };
  const base = { state: lifecycle.state, spinner: false, timer: false, controls: off, composer: "send" as const, inProgress: false };
  const phaseDetail = lifecycle.phase ? PHASE_LABELS[lifecycle.phase] : undefined;
  const canPause = Boolean(lifecycle.activeTurnId);
  switch (lifecycle.state) {
    case "IDLE":
      return { ...base, label: "Idle", tone: "idle", sidebarStatus: "Idle" };
    case "QUEUED":
      return { ...base, label: "Starting", tone: "active", spinner: true, timer: true, inProgress: true, controls: { ...off, stop: true }, composer: "steer", sidebarStatus: "Working" };
    case "ROUTING":
      return { ...base, label: "Choosing a route", tone: "active", spinner: true, timer: true, inProgress: true, controls: { ...off, stop: true }, composer: "steer", sidebarStatus: "Working" };
    case "RUNNING":
      return { ...base, label: lifecycle.cooldown ? "Waiting for free capacity" : "Working", detail: lifecycle.cooldown ? undefined : phaseDetail, tone: "active", spinner: true, timer: true, inProgress: true, controls: { ...off, stop: true, pause: canPause }, composer: "steer", sidebarStatus: "Working" };
    case "VERIFYING":
      return { ...base, label: "Verifying", detail: lifecycle.phase === "diagnosing" ? PHASE_LABELS.diagnosing : undefined, tone: "active", spinner: true, timer: true, inProgress: true, controls: { ...off, stop: true }, composer: "steer", sidebarStatus: "Verifying" };
    case "REPAIRING":
      return { ...base, label: "Repairing", detail: lifecycle.attempt > 1 ? `Attempt ${lifecycle.attempt}` : undefined, tone: "active", spinner: true, timer: true, inProgress: true, controls: { ...off, stop: true, pause: canPause }, composer: "steer", sidebarStatus: "Repairing" };
    case "REVIEWING":
      return { ...base, label: "Reviewing", tone: "active", spinner: true, timer: true, inProgress: true, controls: { ...off, stop: true }, composer: "steer", sidebarStatus: "Reviewing" };
    case "REROUTING":
      return { ...base, label: "Switching route", detail: "Trying another verified-free route", tone: "active", spinner: true, timer: true, inProgress: true, controls: { ...off, stop: true }, composer: "steer", sidebarStatus: "Switching route" };
    case "WAITING_FOR_APPROVAL":
      return { ...base, label: "Needs your approval", tone: "waiting", inProgress: true, controls: { ...off, stop: true }, composer: "approve", sidebarStatus: "Needs your approval" };
    case "WAITING_FOR_INPUT":
      return { ...base, label: "Needs your answer", tone: "waiting", inProgress: true, controls: { ...off, stop: true }, composer: "answer", sidebarStatus: "Needs your answer" };
    case "WAITING_FOR_CAPACITY":
      // Parked on the free-capacity broker, not on the user — resumes itself when supply
      // returns; the only user action that makes sense is cancel.
      return { ...base, label: "Waiting for free capacity", detail: lifecycle.cooldown ?? "Resumes automatically when a verified-free route is available", tone: "waiting", inProgress: true, controls: { ...off, stop: true }, composer: "steer", sidebarStatus: "Waiting for free capacity" };
    case "PAUSED":
      return { ...base, label: "Paused", tone: "paused", inProgress: true, controls: { ...off, stop: true, resume: true }, composer: "resume", sidebarStatus: "Paused" };
    case "INTERRUPTED":
      return { ...base, label: "Interrupted", detail: "CodeForge was closed while this task was running", tone: "warning", inProgress: false, controls: { ...off, resume: Boolean(lifecycle.interruptedTurnId), discard: Boolean(lifecycle.interruptedTurnId), retry: !lifecycle.interruptedTurnId }, composer: "send", sidebarStatus: "Interrupted" };
    case "COMPLETED":
      return { ...base, label: "Completed", tone: "success", sidebarStatus: "Completed" };
    case "CANCELLED":
      return { ...base, label: "Stopped", detail: describeReasonCode(lifecycle.reasonCode, "CANCELLED"), tone: "muted", controls: { ...off, retry: true }, sidebarStatus: "Stopped" };
    case "BLOCKED":
      return { ...base, label: "Blocked", detail: describeReasonCode(lifecycle.reasonCode, "BLOCKED"), tone: "warning", controls: { ...off, retry: true }, sidebarStatus: "Blocked" };
    case "ROUTE_EXHAUSTED":
      return { ...base, label: "No free route available", detail: "Stopped safely — no paid or unknown-cost route was used", tone: "warning", controls: { ...off, retry: true }, sidebarStatus: "No free route" };
    case "FAILED":
    default:
      return { ...base, label: lifecycle.reasonCode === "interrupted" ? "Interrupted" : "Failed", detail: describeReasonCode(lifecycle.reasonCode, "FAILED"), tone: lifecycle.reasonCode === "interrupted" ? "warning" : "danger", controls: { ...off, retry: true }, sidebarStatus: lifecycle.reasonCode === "interrupted" ? "Interrupted" : "Failed" };
  }
}

/**
 * Sidebar vocabulary for a persisted session summary (list rows have records, not events).
 * Shares the terminal wording with `presentRun` so a row and its header can never disagree.
 */
export function presentSessionSummary(summary: { status?: string; outcome?: string }): { label: string; tone: RunTone } {
  const status = summary.status ?? "";
  const outcome = summary.outcome;
  switch (status) {
    case "":
    case "idle":
      return { label: "Idle", tone: "idle" };
    case "running":
    case "received":
    case "reconnaissance":
    case "planning":
    case "implementing":
    case "validating":
      return { label: "Working", tone: "active" };
    case "testing":
    case "verifying":
    case "diagnosing":
      return { label: "Verifying", tone: "active" };
    case "repairing":
      return { label: "Repairing", tone: "active" };
    case "reviewing":
      return { label: "Reviewing", tone: "active" };
    case "user_input_required":
    case "waiting_for_approval":
      return { label: "Needs your approval", tone: "waiting" };
    case "waiting_for_question":
      return { label: "Needs your answer", tone: "waiting" };
    case "waiting_for_free_capacity":
      return { label: "Waiting for free capacity", tone: "waiting" };
    case "paused":
      return { label: "Paused", tone: "paused" };
    case "recovering":
      return { label: "Interrupted", tone: "warning" };
    case "completed":
    case "complete":
      return { label: "Completed", tone: "success" };
    case "cancelled":
      return { label: outcome === "timed_out" ? "Ran out of time" : "Stopped", tone: "muted" };
    case "blocked":
      return { label: "Blocked", tone: "warning" };
    case "failed":
    case "failed_safely":
      if (outcome === "route_exhausted") return { label: "No free route", tone: "warning" };
      if (outcome === "interrupted") return { label: "Interrupted", tone: "warning" };
      if (outcome === "plan_steps_unfinished" || outcome === "blocked" || outcome === "verification_not_run" || outcome === "verification_not_current" || outcome === "no_effective_change" || outcome === "review_rejected") return { label: "Blocked", tone: "warning" };
      if (outcome === "user_stopped") return { label: "Stopped", tone: "muted" };
      return { label: "Failed", tone: "danger" };
    default:
      return { label: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " "), tone: "muted" };
  }
}
