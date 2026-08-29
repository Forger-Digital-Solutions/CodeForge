import { useState, useEffect, useCallback, useRef } from "react";
import type { WorkspaceEvent, SessionStatus } from "@codeforge/protocol";
import { WorkspaceEventSchema, isWorkspaceEvent } from "@codeforge/protocol";
import type { SessionRecord, TurnRecord, WorkItem } from "@codeforge/sessions";
import { isEventForSession, mergeEvent } from "./session-events.js";

export interface WorkflowTaskSummary {
  taskId: string;
  title: string;
  status: string;
  phase: string;
  progress: number;
  createdAt: string;
}

export interface WorkspaceState {
  session: SessionRecord | null;
  turns: TurnRecord[];
  workItems: WorkItem[];
  events: WorkspaceEvent[];
  displayMode: "compact" | "detailed" | "debug";
  activeTab: string;
  leftNav: string;
  isRunning: boolean;
  isPaused: boolean;
  pendingApproval: Extract<WorkItem, { kind: "approval" }> | null;
  pendingQuestion: Extract<WorkItem, { kind: "question" }> | null;
  agentStatus: SessionStatus;
  commandOutput: string;
  // Stop/Pause/Resume action states
  actionPending: "none" | "stop" | "pause" | "resume";
  actionError: string | null;
  // Production autonomous workflow UX — trusted execution signals
  workflowTasks: WorkflowTaskSummary[];
  activeTaskId: string | null;
  activePhase: string;
  workflowProgress: number;
  workflowError: string | null;
  workflowActionPending: "none" | "run" | "cancel";
  workflowActionError: string | null;
  lastWorkflowResult: string | null;
  lastEvidenceId: string | null;
  lastCheckpointId: string | null;
}

export const initialWorkspaceState: WorkspaceState = {
  session: null,
  turns: [],
  workItems: [],
  events: [],
  displayMode: "compact",
  activeTab: "overview",
  leftNav: "sessions",
  isRunning: false,
  isPaused: false,
  pendingApproval: null,
  pendingQuestion: null,
  agentStatus: "idle",
  commandOutput: "",
  actionPending: "none",
  actionError: null,
  workflowTasks: [],
  activeTaskId: null,
  activePhase: "idle",
  workflowProgress: 0,
  workflowError: null,
  workflowActionPending: "none",
  workflowActionError: null,
  lastWorkflowResult: null,
  lastEvidenceId: null,
  lastCheckpointId: null,
};

function phaseToProgress(phase: string): number {
  const order: Record<string, number> = {
    received: 5,
    reconnaissance: 15,
    understanding: 12,
    inspecting: 18,
    building_context: 22,
    planning: 35,
    user_input_required: 38,
    awaiting_approval: 38,
    implementing: 55,
    testing: 68,
    verifying: 68,
    diagnosing: 72,
    repairing: 78,
    reviewing: 88,
    validating: 94,
    summarizing: 94,
    complete: 100,
    completed: 100,
    failed_safely: 100,
    failed: 100,
    cancelled: 0,
    idle: 0,
  };
  return order[phase] ?? 0;
}

/**
 * Merge authoritative server turns with locally-added optimistic turns.
 * Optimistic turns (id prefixed "local-") are shown immediately on send and
 * dropped once the server reports a turn with the same user message, so the
 * conversation never double-renders the prompt.
 */
function mergeServerTurns(serverTurns: TurnRecord[], prevTurns: TurnRecord[]): TurnRecord[] {
  const serverMessages = new Set(serverTurns.map((t) => t.userMessage));
  const pendingOptimistic = prevTurns.filter(
    (t) => t.id.startsWith("local-") && !serverMessages.has(t.userMessage),
  );
  return [...serverTurns, ...pendingOptimistic];
}

function resolveApiPath(sseUrl: string, apiPath: string): string {
  if (sseUrl.startsWith("http://") || sseUrl.startsWith("https://")) {
    return `${new URL(sseUrl).origin}${apiPath}`;
  }
  return apiPath;
}

export function useWorkspaceSSE(url: string) {
  const [state, setState] = useState<WorkspaceState>(initialWorkspaceState);
  // The session this view is following. The SSE stream is scoped to it so events from other
  // sessions never enter this view (isolation). Switching updates this and re-subscribes.
  const [activeSessionId, setActiveSessionId] = useState<string>("default");
  const activeSessionIdRef = useRef<string>("default");
  activeSessionIdRef.current = activeSessionId;
  const lastSeqRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrateRef = useRef<(sessionId?: string) => void>(() => {});

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // Pull the authoritative conversation snapshot (session + turns + work items)
  // from the server. SSE only carries live *signals*; the durable content the
  // conversation and inspector render is fetched here so both actually populate.
  const hydrate = useCallback(
    async (sessionIdOverride?: string) => {
      const sessionId = sessionIdOverride ?? state.session?.id ?? "default";
      try {
        const res = await fetch(resolveApiPath(url, `/api/sessions/${sessionId}`));
        if (!res.ok) return;
        const data = (await res.json()) as {
          session?: SessionRecord | null;
          turns?: TurnRecord[];
          workItems?: WorkItem[];
        };
        setState((prev) => ({
          ...prev,
          session: data.session ?? prev.session,
          turns: Array.isArray(data.turns) ? mergeServerTurns(data.turns, prev.turns) : prev.turns,
          workItems: Array.isArray(data.workItems) ? data.workItems : prev.workItems,
        }));
      } catch {
        // Server may still be starting; keep current state and retry on next event.
      }
    },
    [state.session?.id, url],
  );

  // Stable ref to the latest hydrate so the SSE handler can trigger it without
  // tearing down the EventSource each time the session id changes.
  hydrateRef.current = hydrate;

  const scheduleHydrate = useCallback(() => {
    if (hydrateTimerRef.current) return;
    hydrateTimerRef.current = setTimeout(() => {
      hydrateTimerRef.current = null;
      hydrateRef.current();
    }, 120);
  }, []);

  // Hydrate once on mount so the conversation is populated before any event.
  useEffect(() => {
    hydrateRef.current();
    return () => {
      if (hydrateTimerRef.current) {
        clearTimeout(hydrateTimerRef.current);
        hydrateTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!url) return;

    let aborted = false;
    let es: EventSource | null = null;

    // Session changed (or first mount): start this view's event list fresh so no stale events
    // from the previously-followed session remain, and replay the new session from seq 0.
    lastSeqRef.current = 0;
    setState((prev) => ({ ...prev, events: [] }));

    const connect = () => {
      if (aborted) return;
      clearReconnect();

      const params = new URLSearchParams();
      params.set("sessionId", activeSessionId);
      if (lastSeqRef.current > 0) params.set("lastSeq", String(lastSeqRef.current));
      const sep = url.includes("?") ? "&" : "?";
      es = new EventSource(`${url}${sep}${params.toString()}`);

      es.onopen = () => {
        if (aborted) return;
        clearReconnect();
      };

      es.onerror = () => {
        if (aborted || !es) return;
        es.close();
        es = null;
        reconnectTimerRef.current = setTimeout(connect, 1000);
      };

      es.onmessage = (event: MessageEvent) => {
        if (aborted) return;
        try {
          const parsed = JSON.parse(event.data);
          if (!isWorkspaceEvent(parsed)) return;
          // Session isolation + dedupe: ignore events for other sessions and any already seen.
          if (!isEventForSession(parsed, activeSessionIdRef.current, lastSeqRef.current)) return;

          lastSeqRef.current = parsed.seq;
          setState((prev: WorkspaceState) => {
            const next = { ...prev, events: mergeEvent(prev.events, parsed) };
            if (parsed.type === "turn.started") {
              next.isRunning = true;
              next.agentStatus = "running";
              next.workflowError = null;
            }
            if (parsed.type === "turn.completed" || parsed.type === "turn.cancelled" || parsed.type === "turn.failed") {
              next.isRunning = false;
              next.agentStatus = parsed.type === "turn.failed" ? "failed" : "idle";
              if (parsed.type === "turn.failed") {
                next.workflowError = (parsed.payload as { error: string }).error ?? "Turn failed";
              }
            }
            if (parsed.type === "turn.paused") {
              next.isPaused = true;
            }
            if (parsed.type === "turn.resumed") {
              next.isPaused = false;
            }
            if (parsed.type === "approval.requested") {
              next.pendingApproval = {
                kind: "approval",
                id: parsed.payload.approvalId,
                sessionId: parsed.sessionId,
                tool: parsed.payload.tool,
                action: parsed.payload.action,
                description: parsed.payload.description,
                risk: parsed.payload.risk,
                scope: parsed.payload.scope,
                createdAt: parsed.timestamp,
              };
            }
            if (parsed.type === "approval.resolved") {
              next.pendingApproval = null;
            }
            if (parsed.type === "question.requested") {
              next.pendingQuestion = {
                kind: "question",
                id: parsed.payload.questionId,
                sessionId: parsed.sessionId,
                prompt: parsed.payload.prompt,
                options: parsed.payload.options,
                createdAt: parsed.timestamp,
              };
            }
            if (parsed.type === "question.resolved") {
              next.pendingQuestion = null;
            }
            if (parsed.type === "status.changed") {
              next.agentStatus = parsed.payload.to as SessionStatus;
              const to = parsed.payload.to as string;
              if (to !== "idle" && to !== "running") {
                const prog = phaseToProgress(to);
                if (prog) {
                  next.activePhase = to;
                  next.workflowProgress = prog;
                }
              }
            }
            // Workflow orchestration events — production-grade trusted execution signals
            if (parsed.type === "task.created") {
              const p = parsed.payload as { taskId: string; title: string; mode: string };
              const summary: WorkflowTaskSummary = {
                taskId: p.taskId,
                title: p.title,
                status: "received",
                phase: "received",
                progress: phaseToProgress("received"),
                createdAt: parsed.timestamp,
              };
              next.workflowTasks = [...prev.workflowTasks.filter((t) => t.taskId !== p.taskId), summary];
              next.activeTaskId = p.taskId;
              next.activePhase = "received";
              next.workflowProgress = phaseToProgress("received");
              next.workflowError = null;
              next.workflowActionError = null;
              next.lastWorkflowResult = null;
              next.isRunning = true;
              next.agentStatus = "running";
            }
            if (parsed.type === "task.started") {
              const p = parsed.payload as { taskId: string };
              next.activeTaskId = p.taskId;
              next.isRunning = true;
              next.agentStatus = "running";
              next.activePhase = "received";
              next.workflowProgress = phaseToProgress("received");
              next.workflowTasks = next.workflowTasks.map((t) =>
                t.taskId === p.taskId ? { ...t, status: "running", phase: "received" } : t,
              );
            }
            if (parsed.type === "task.completed") {
              const p = parsed.payload as { taskId: string; result: string };
              next.isRunning = false;
              next.agentStatus = "idle";
              next.activePhase = "complete";
              next.workflowProgress = 100;
              next.lastWorkflowResult = p.result;
              next.workflowActionPending = "none";
              next.workflowTasks = next.workflowTasks.map((t) =>
                t.taskId === p.taskId ? { ...t, status: "completed", phase: "completed", progress: 100 } : t,
              );
            }
            if (parsed.type === "task.cancelled") {
              const p = parsed.payload as { taskId: string; reason?: string };
              next.isRunning = false;
              next.agentStatus = "cancelled" as SessionStatus;
              next.activePhase = "cancelled";
              next.workflowProgress = 0;
              next.workflowActionPending = "none";
              next.workflowTasks = next.workflowTasks.map((t) =>
                t.taskId === p.taskId ? { ...t, status: "cancelled", phase: "cancelled", progress: 0 } : t,
              );
              if (p.reason) next.workflowError = p.reason;
            }
            if (parsed.type === "task.state_changed") {
              const p = parsed.payload as { taskId: string; from: string; to: string };
              const to = p.to;
              const prog = phaseToProgress(to);
              next.activePhase = to;
              if (prog !== 0 || to === "cancelled") next.workflowProgress = prog;
              // Trustworthy terminal states: surface succinctly
              if (to === "complete" || to === "failed_safely" || to === "cancelled") {
                next.isRunning = false;
                next.agentStatus = to === "complete" ? "idle" : (to as SessionStatus);
                if (to === "failed_safely") next.workflowError = `Workflow reached ${to}`;
                if (to === "cancelled") next.workflowError = "Workflow cancelled";
                next.workflowActionPending = "none";
              } else if (
                to === "implementing" ||
                to === "testing" ||
                to === "planning" ||
                to === "reconnaissance" ||
                to === "user_input_required" ||
                to === "diagnosing" ||
                to === "repairing" ||
                to === "reviewing" ||
                to === "validating"
              ) {
                next.isRunning = true;
                next.agentStatus = "running";
                next.workflowError = null;
              }
              next.activeTaskId = p.taskId;
              next.workflowTasks = next.workflowTasks.map((t) =>
                t.taskId === p.taskId ? { ...t, status: to, phase: to, progress: prog || t.progress } : t,
              );
              if (!next.workflowTasks.some((t) => t.taskId === p.taskId)) {
                next.workflowTasks = [
                  ...next.workflowTasks,
                  { taskId: p.taskId, title: next.workflowTasks[0]?.title ?? p.taskId.slice(0, 8), status: to, phase: to, progress: prog, createdAt: parsed.timestamp },
                ];
              }
            }
            if (parsed.type === "plan.started") {
              next.isRunning = true;
              next.activePhase = "planning";
              next.workflowProgress = Math.max(next.workflowProgress, phaseToProgress("planning"));
            }
            if (parsed.type === "plan.updated" || parsed.type === "plan.status_changed") {
              next.isRunning = true;
            }
            if (parsed.type === "checkpoint.created") {
              next.lastCheckpointId = (parsed.payload as { checkpointId: string }).checkpointId;
            }
            if (parsed.type === "evidence.created") {
              next.lastEvidenceId = (parsed.payload as { evidenceId: string }).evidenceId;
            }
            if (parsed.type === "turn.failed") {
              next.workflowError = (parsed.payload as { error: string }).error;
              next.isRunning = false;
              next.activePhase = "failed";
              next.workflowProgress = 100;
            }
            return next;
          });
          // An event fired: re-pull the authoritative turns/work items so the
          // conversation and inspector reflect what the agent actually did.
          scheduleHydrate();
        } catch {
          // ignore malformed events
        }
      };
    };

    connect();

    return () => {
      aborted = true;
      clearReconnect();
      if (es) {
        es.close();
        es = null;
      }
    };
  }, [url, activeSessionId, clearReconnect, scheduleHydrate]);

  const sendMessage = useCallback(
    async (message: string, steer = false) => {
      const sessionId: string = state.session?.id ?? "default";
      const turnId = crypto.randomUUID();
      const endpoint = resolveApiPath(url, "/api/send");

      const body = steer
        ? JSON.stringify({ sessionId, message, steer: true, turnId })
        : JSON.stringify({ sessionId, message, turnId });

      // Optimistically render the user's message so pressing Enter has an
      // immediate, visible effect; hydration reconciles it with the server turn.
      const optimisticTurn: TurnRecord = {
        id: `local-${turnId}`,
        sessionId,
        seq: 0,
        userMessage: message,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      setState((prev) => ({
        ...prev,
        turns: [...prev.turns, optimisticTurn],
        isRunning: true,
        workflowError: null,
        workflowActionError: null,
      }));

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (!res.ok) {
          let msg = `Send failed: ${res.status}`;
          try {
            const data = (await res.json()) as { error?: string; message?: string };
            msg = data.message || data.error || msg;
          } catch {}
          // Roll back the optimistic turn and surface the failure.
          setState((prev) => ({
            ...prev,
            turns: prev.turns.filter((t) => t.id !== optimisticTurn.id),
            isRunning: false,
            workflowError: msg,
            workflowActionError: msg,
          }));
          return;
        }
        void hydrate(sessionId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Network error — please check your connection";
        setState((prev) => ({
          ...prev,
          turns: prev.turns.filter((t) => t.id !== optimisticTurn.id),
          isRunning: false,
          workflowError: msg,
          workflowActionError: msg,
        }));
      }
    },
    [state.session?.id, url, hydrate]
  );

  const approve = useCallback(
    (decision: "allow_once" | "allow_session" | "deny") => {
      if (!state.pendingApproval) return;
      fetch(resolveApiPath(url, `/api/approvals/${state.pendingApproval.id}/resolve`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.pendingApproval.sessionId,
          decision,
        }),
      }).catch(() => {});
      setState((prev: WorkspaceState) => ({ ...prev, pendingApproval: null }));
    },
    [state.pendingApproval, url]
  );

  const answerQuestion = useCallback(
    (answer: string) => {
      if (!state.pendingQuestion) return;
      fetch(resolveApiPath(url, `/api/questions/${state.pendingQuestion.id}/resolve`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.pendingQuestion.sessionId,
          answer,
        }),
      }).catch(() => {});
      setState((prev: WorkspaceState) => ({ ...prev, pendingQuestion: null }));
    },
    [state.pendingQuestion, url]
  );

  const stopTurn = useCallback(
    async (sessionId: string, turnId: string) => {
      const endpoint = resolveApiPath(url, `/api/sessions/${sessionId}/turns/${turnId}/cancel`);
      try {
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "User stopped" }),
        });
      } catch {
        // network error; SSE will reconnect and state remains consistent
      }
    },
    [url]
  );

  const pauseTurn = useCallback(
    async (sessionId: string, turnId: string) => {
      const endpoint = resolveApiPath(url, `/api/sessions/${sessionId}/turns/${turnId}/pause`);
      try {
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {
        // network error; SSE will reconnect and state remains consistent
      }
    },
    [url]
  );

  const resumeTurn = useCallback(
    async (sessionId: string, turnId: string) => {
      const endpoint = resolveApiPath(url, `/api/sessions/${sessionId}/turns/${turnId}/resume`);
      try {
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch (error) {
        // network error; SSE will reconnect and state remains consistent
        // For UI error display, this should be handled by the caller
        console.error("Resume turn failed:", error);
      }
    },
    [url]
  );

  const runWorkflow = useCallback(
    async (message: string, sessionId?: string) => {
      const sid = sessionId ?? state.session?.id ?? "default";
      const endpoint = resolveApiPath(url, "/api/workflow/run");
      setState((prev) => ({ ...prev, workflowActionPending: "run", workflowActionError: null, workflowError: null }));
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid, message }),
        });
        if (!res.ok) {
          let msg = `Workflow start failed: ${res.status}`;
          try {
            const data = (await res.json()) as { error?: string; message?: string };
            msg = data.error || data.message || msg;
          } catch {}
          setState((prev) => ({ ...prev, workflowActionError: msg, workflowError: msg, workflowActionPending: "none" }));
          return;
        }
        setState((prev) => ({ ...prev, workflowActionPending: "none" }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Network error";
        setState((prev) => ({ ...prev, workflowActionError: msg, workflowError: msg, workflowActionPending: "none" }));
      }
    },
    [state.session?.id, url]
  );

  const cancelWorkflow = useCallback(
    async (taskId?: string) => {
      const tid = taskId ?? state.activeTaskId;
      if (!tid) return;
      setState((prev) => ({ ...prev, workflowActionPending: "cancel", workflowActionError: null }));
      const endpoint = resolveApiPath(url, `/api/workflow/${tid}/cancel`);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          let msg = `Cancel failed: ${res.status}`;
          try {
            const data = (await res.json()) as { error?: string };
            msg = data.error || msg;
          } catch {}
          setState((prev) => ({ ...prev, workflowActionError: msg, workflowActionPending: "none" }));
          return;
        }
        setState((prev) => ({ ...prev, workflowActionPending: "none" }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Network error";
        setState((prev) => ({ ...prev, workflowActionError: msg, workflowActionPending: "none" }));
      }
    },
    [state.activeTaskId, url]
  );

  const dismissWorkflowError = useCallback(() => {
    setState((prev) => ({ ...prev, workflowError: null, workflowActionError: null }));
  }, []);

  // Load a different persisted session into the view (task history navigation). Switching the
  // active session re-subscribes the SSE stream to that session only (isolation) and re-hydrates
  // its durable snapshot. Stale events from the previous session are dropped by the effect reset.
  const selectSession = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId);
      void hydrate(sessionId);
    },
    [hydrate],
  );

  return {
    state,
    setState,
    sendMessage,
    approve,
    answerQuestion,
    stopTurn,
    pauseTurn,
    resumeTurn,
    runWorkflow,
    cancelWorkflow,
    dismissWorkflowError,
    hydrate,
    selectSession,
  };
}
