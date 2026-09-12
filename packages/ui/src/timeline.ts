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
      /** What the file operation this call performed reported ("28 lines", "written"). */
      fileDetail?: string;
    }
  | { kind: "system"; id: string; seq: number; turnId: string; text: string }
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
        const p = e.payload as { turnId: string; userMessage: string; origin?: "user" | "workflow"; label?: string };
        if (!seenUserTurns.has(p.turnId)) {
          seenUserTurns.add(p.turnId);
          if (p.origin === "workflow") {
            // An internal turn the workflow dispatched (builder/repair prompt). Its text is the
            // workflow's instruction to the agent, not something the user wrote.
            items.push({ kind: "system", id: `system-${p.turnId}`, seq: e.seq, turnId: p.turnId, text: p.label ?? "Agent turn started" });
          } else {
            items.push({ kind: "user", id: `user-${p.turnId}`, seq: e.seq, turnId: p.turnId, text: p.userMessage });
          }
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
      case "tool.call_completed":
      case "tool.call_started": {
        // A call announces itself before its arguments are known; the arguments arrive with the
        // completed call / execution start. The row must pick them up then, or it would forever
        // read "Read" with no file — which is exactly what shipped.
        const p = e.payload as { turnId: string; toolCallId: string; toolName: string; argsJson?: string };
        const existing = toolByCall.get(p.toolCallId);
        if (existing) {
          if (!existing.argsJson && p.argsJson) existing.argsJson = p.argsJson;
          break;
        }
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
        const detail = p.lines ? `${p.lines} lines` : undefined;
        // The agent's read_file tool reports the same read through this event; fold it into the
        // running tool row instead of showing the one action twice.
        const owner = runningToolForPath(toolByCall, p.path, "read");
        if (owner) {
          if (detail) owner.fileDetail = detail;
          break;
        }
        items.push({ kind: "file", id: `file-${p.fileCallId}`, seq: e.seq, path: p.path, action: "read", detail });
        break;
      }
      case "file.written": {
        const p = e.payload as { fileCallId: string; path: string; bytesOrChars?: number };
        const owner = runningToolForPath(toolByCall, p.path, "written");
        if (owner) {
          owner.fileDetail = "written";
          break;
        }
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

const READ_TOOLS = new Set(["read_file"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/** The still-running tool call that is acting on `path` — the owner of a file event. */
function runningToolForPath(
  toolByCall: Map<string, Extract<TimelineItem, { kind: "tool" }>>,
  filePath: string,
  action: "read" | "written",
): Extract<TimelineItem, { kind: "tool" }> | undefined {
  const wanted = normalizePath(filePath);
  const tools = action === "read" ? READ_TOOLS : WRITE_TOOLS;
  let match: Extract<TimelineItem, { kind: "tool" }> | undefined;
  for (const item of toolByCall.values()) {
    if (item.status !== "running" || !tools.has(item.toolName) || !item.argsJson) continue;
    let args: { path?: unknown } | undefined;
    try {
      args = JSON.parse(item.argsJson) as { path?: unknown };
    } catch {
      continue;
    }
    if (typeof args?.path === "string" && normalizePath(args.path) === wanted) match = item;
  }
  return match;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** True when at least one assistant message with visible text exists in the timeline. */
export function hasAssistantProse(items: TimelineItem[]): boolean {
  return items.some((i) => i.kind === "assistant" && i.text.trim().length > 0);
}
