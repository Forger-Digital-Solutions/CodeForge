import type { WorkspaceEvent } from "@codeforge/protocol";

/**
 * A single rendered item in the conversation timeline, reconstructed from the event stream.
 * Ordering is chronological (by the seq at which the item first appeared), so assistant prose
 * and tool activity interleave correctly: user → assistant → tool → tool → assistant → …
 */
export type TimelineItem =
  | { kind: "user"; id: string; seq: number; turnId: string; text: string }
  | { kind: "assistant"; id: string; seq: number; turnId: string; messageId: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      seq: number;
      turnId: string;
      toolCallId: string;
      toolName: string;
      status: "running" | "completed" | "failed" | "blocked";
      argsJson?: string;
      result?: string;
      error?: string;
    }
  | { kind: "file"; id: string; seq: number; turnId?: string; path: string; action: "read" | "written"; detail?: string }
  | { kind: "command"; id: string; seq: number; turnId?: string; command: string; exitCode: number; output?: string };

/**
 * Reconstruct the ordered conversation timeline from a session's workspace events.
 * Assistant messages are grouped by messageId (falling back to a per-turn synthetic id when a
 * provider streams deltas without explicit boundaries), and `assistant.message.completed` text
 * is authoritative so the prose reloads verbatim from persisted events.
 */
export function buildTimeline(events: WorkspaceEvent[]): TimelineItem[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const items: TimelineItem[] = [];
  const assistantByMsg = new Map<string, Extract<TimelineItem, { kind: "assistant" }>>();
  const toolByCall = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  const seenUserTurns = new Set<string>();
  // Track the last open assistant message per turn for delta fallback (no messageId case).
  const lastOpenMsgByTurn = new Map<string, string>();

  const ensureAssistant = (turnId: string, messageId: string, seq: number): Extract<TimelineItem, { kind: "assistant" }> => {
    let item = assistantByMsg.get(messageId);
    if (!item) {
      item = { kind: "assistant", id: `assistant-${messageId}`, seq, turnId, messageId, text: "", streaming: true };
      assistantByMsg.set(messageId, item);
      lastOpenMsgByTurn.set(turnId, messageId);
      items.push(item);
    }
    return item;
  };

  for (const e of ordered) {
    switch (e.type) {
      case "turn.started": {
        const p = e.payload;
        if (!seenUserTurns.has(p.turnId)) {
          seenUserTurns.add(p.turnId);
          items.push({ kind: "user", id: `user-${p.turnId}`, seq: e.seq, turnId: p.turnId, text: p.userMessage });
        }
        break;
      }
      case "assistant.message.started": {
        const p = e.payload;
        ensureAssistant(p.turnId, p.messageId, e.seq);
        break;
      }
      case "text.delta": {
        const p = e.payload as { turnId: string; delta: string; messageId?: string };
        const messageId = p.messageId ?? lastOpenMsgByTurn.get(p.turnId) ?? `auto-${p.turnId}`;
        const item = ensureAssistant(p.turnId, messageId, e.seq);
        item.text += p.delta;
        break;
      }
      case "assistant.message.completed": {
        const p = e.payload;
        const item = ensureAssistant(p.turnId, p.messageId, e.seq);
        item.text = p.text; // authoritative final text (survives reload without deltas)
        item.streaming = false;
        lastOpenMsgByTurn.delete(p.turnId);
        break;
      }
      case "tool.execution_started":
      case "tool.call_started": {
        const p = e.payload as { turnId: string; toolCallId: string; toolName: string; argsJson?: string };
        if (!toolByCall.has(p.toolCallId)) {
          const item: Extract<TimelineItem, { kind: "tool" }> = {
            kind: "tool",
            id: `tool-${p.toolCallId}`,
            seq: e.seq,
            turnId: p.turnId,
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            status: "running",
            argsJson: p.argsJson,
          };
          toolByCall.set(p.toolCallId, item);
          items.push(item);
        }
        break;
      }
      case "tool.execution_completed": {
        const p = e.payload as { toolCallId: string; result: string };
        const item = toolByCall.get(p.toolCallId);
        if (item) {
          item.status = "completed";
          item.result = p.result;
        }
        break;
      }
      case "tool.execution_failed": {
        const p = e.payload as { toolCallId: string; error: string };
        const item = toolByCall.get(p.toolCallId);
        if (item) {
          item.status = "failed";
          item.error = p.error;
        }
        break;
      }
      case "tool.execution_blocked": {
        const p = e.payload as { toolCallId: string; reason: string };
        const item = toolByCall.get(p.toolCallId);
        if (item) {
          item.status = "blocked";
          item.error = p.reason;
        }
        break;
      }
      case "file.read": {
        const p = e.payload as { fileCallId: string; path: string; lines?: number };
        items.push({ kind: "file", id: `file-${p.fileCallId}`, seq: e.seq, path: p.path, action: "read", detail: p.lines ? `${p.lines} lines` : undefined });
        break;
      }
      case "file.written": {
        const p = e.payload as { fileCallId: string; path: string; bytesOrChars?: number };
        items.push({ kind: "file", id: `file-${p.fileCallId}`, seq: e.seq, path: p.path, action: "written" });
        break;
      }
      case "command.executed": {
        const p = e.payload as { commandId: string; command: string; output: string; exitCode: number };
        items.push({ kind: "command", id: `cmd-${p.commandId}`, seq: e.seq, command: p.command, exitCode: p.exitCode, output: p.output });
        break;
      }
      default:
        break;
    }
  }

  return items;
}

/** True when at least one assistant message with visible text exists in the timeline. */
export function hasAssistantProse(items: TimelineItem[]): boolean {
  return items.some((i) => i.kind === "assistant" && i.text.trim().length > 0);
}
