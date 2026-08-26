import { useState, useEffect, useCallback, useRef } from "react";
import type { WorkspaceEvent, SessionStatus } from "@codeforge/protocol";
import { WorkspaceEventSchema, isWorkspaceEvent } from "@codeforge/protocol";
import type { SessionRecord, TurnRecord, WorkItem } from "@codeforge/sessions";

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
};

export function useWorkspaceSSE(url: string) {
  const [state, setState] = useState<WorkspaceState>(initialWorkspaceState);
  const lastSeqRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!url) return;

    let aborted = false;
    let es: EventSource | null = null;

    const connect = () => {
      if (aborted) return;
      clearReconnect();

      const replayUrl = lastSeqRef.current > 0 ? `${url}?lastSeq=${lastSeqRef.current}` : url;
      es = new EventSource(replayUrl);

      es.onopen = () => {
        if (aborted) return;
        es?.close();
        es = null;
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
          if (parsed.seq <= lastSeqRef.current) return;

          lastSeqRef.current = parsed.seq;
          setState((prev: WorkspaceState) => {
            const next = { ...prev, events: [...prev.events, parsed] };
            if (parsed.type === "turn.started") {
              next.isRunning = true;
              next.agentStatus = "running";
            }
            if (parsed.type === "turn.completed" || parsed.type === "turn.cancelled" || parsed.type === "turn.failed") {
              next.isRunning = false;
              next.agentStatus = parsed.type === "turn.failed" ? "failed" : "idle";
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
            }
            return next;
          });
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
  }, [url, clearReconnect]);

  const sendMessage = useCallback(
    async (message: string, steer = false) => {
      const sessionId: string = state.session?.id ?? "default";
      const turnId = crypto.randomUUID();
      const endpoint = "/api/send";

      const body = steer
        ? JSON.stringify({ sessionId, message, steer: true, turnId })
        : JSON.stringify({ sessionId, message, turnId });

      try {
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch {
        // network error; SSE will reconnect and state remains consistent
      }
    },
    [state.session?.id]
  );

  const approve = useCallback(
    (decision: "allow_once" | "allow_session" | "deny") => {
      if (!state.pendingApproval) return;
      fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.pendingApproval.sessionId,
          approvalId: state.pendingApproval.id,
          decision,
        }),
      }).catch(() => {});
      setState((prev: WorkspaceState) => ({ ...prev, pendingApproval: null }));
    },
    [state.pendingApproval]
  );

  const answerQuestion = useCallback(
    (answer: string) => {
      if (!state.pendingQuestion) return;
      fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.pendingQuestion.sessionId,
          questionId: state.pendingQuestion.id,
          answer,
        }),
      }).catch(() => {});
      setState((prev: WorkspaceState) => ({ ...prev, pendingQuestion: null }));
    },
    [state.pendingQuestion]
  );

  return {
    state,
    setState,
    sendMessage,
    approve,
    answerQuestion,
  };
}
