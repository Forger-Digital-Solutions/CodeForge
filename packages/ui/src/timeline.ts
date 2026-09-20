import type { WorkspaceEvent } from "@codeforge/protocol";
import { describeTurnStop, humanizeBlockReason, humanizeError } from "./error-copy.js";
import { describeReasonCode } from "./run-lifecycle.js";

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
  | { kind: "phase"; id: string; seq: number; turnId?: string; phase: "testing" | "repairing" | "reviewing" | "outcome"; text: string; detail?: string }
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
  const subagentRoles = new Map<string, string>();
  // A workflow's own outcome row supersedes the raw turn terminal event that follows it, and the
  // internal implement/repair turns a workflow dispatches report through that outcome, not per turn.
  let outcomeShown = false;
  const workflowTurns = new Set<string>();

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
          // Workflow-dispatched turns (implement/repair) are internal mechanics —
          // the phase strip and grouped activity carry that meaning; a transcript
          // row per dispatch is event spam, not conversation.
          if (p.origin !== "workflow") {
            items.push({ kind: "user", id: `user-${p.turnId}`, seq: e.seq, turnId: p.turnId, text: p.userMessage });
          } else {
            workflowTurns.add(p.turnId);
          }
        }
        break;
      }
      case "workflow.verification_completed": {
        const p = e.payload as { attempt: number; passed: number; failed: number; skipped: number };
        const detail = `${p.passed} passed${p.failed > 0 ? ` · ${p.failed} failed` : ""}${p.skipped > 0 ? ` · ${p.skipped} skipped` : ""}`;
        items.push({ kind: "phase", id: `verify-${e.seq}`, seq: e.seq, phase: "testing", text: `Verification · attempt ${p.attempt}`, detail });
        break;
      }
      case "workflow.repair_attempted": {
        const p = e.payload as { attempt: number; summary?: string };
        items.push({ kind: "phase", id: `repair-${e.seq}`, seq: e.seq, phase: "repairing", text: `Repairing verification failure · attempt ${p.attempt}`, detail: p.summary });
        break;
      }
      case "workflow.review_completed": {
        const p = e.payload as { approved: boolean; findings?: unknown[]; diffCount?: number };
        items.push({ kind: "phase", id: `review-${e.seq}`, seq: e.seq, phase: "reviewing", text: "Review", detail: `${p.approved ? "approved" : "findings"}${p.findings?.length ? ` · ${p.findings.length} findings` : ""}` });
        break;
      }
      case "workflow.completion_decided": {
        const p = e.payload as { outcome: string; rationale?: string };
        items.push({ kind: "phase", id: `outcome-${e.seq}`, seq: e.seq, phase: "outcome", text: p.outcome === "completed" ? "Done" : p.outcome === "blocked" ? "Blocked" : "Failed", detail: humanizeOutcomeRationale(p.outcome, p.rationale) });
        outcomeShown = true;
        break;
      }
      // A turn that ends without an answer must still leave a visible trace: after a relaunch the
      // live failure banner is gone, and "Completed" with an empty conversation is a false story.
      case "turn.failed": {
        const p = e.payload as { turnId: string; error: string; failure?: { message: string } };
        if (workflowTurns.has(p.turnId)) break;
        if (outcomeShown) { outcomeShown = false; break; }
        // The classified sentence is already owner-aware; humanizeError would re-map "rate limited"
        // inside a managed-free message to generic BYOK wording.
        const detail = p.failure?.message ?? humanizeError(p.error ?? "The task could not be completed.");
        items.push({ kind: "phase", id: `turn-failed-${p.turnId}-${e.seq}`, seq: e.seq, turnId: p.turnId, phase: "outcome", text: "Failed", detail });
        break;
      }
      case "turn.cancelled": {
        const p = e.payload as { turnId: string; reason?: string };
        if (workflowTurns.has(p.turnId)) break;
        if (outcomeShown) { outcomeShown = false; break; }
        items.push({ kind: "phase", id: `turn-cancelled-${p.turnId}-${e.seq}`, seq: e.seq, turnId: p.turnId, phase: "outcome", text: "Stopped", detail: describeTurnStop(p.reason) });
        break;
      }
      case "turn.completed": {
        // A workflow outcome row already told the story; a plain chat turn needs nothing extra.
        outcomeShown = false;
        break;
      }
      case "execution.start_failed": {
        const p = e.payload as { requestId: string; code: string; message: string };
        items.push({ kind: "phase", id: `start-failed-${p.requestId}-${e.seq}`, seq: e.seq, phase: "outcome", text: "Failed", detail: humanizeError(p.message ?? p.code) });
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
        // The run_command tool call this execution belongs to already has a row; showing the same
        // command again as a second row reads as two commands. The command card is the richer
        // presentation, so the tool row is replaced in place — its seq keeps the slot in order.
        const owner = runningToolForCommand(toolByCall, p.command);
        if (owner) {
          const commandItem: Extract<TimelineItem, { kind: "command" }> = {
            kind: "command",
            id: `cmd-${p.commandId}`,
            seq: owner.seq,
            turnId: owner.turnId,
            command: p.command,
            exitCode: p.exitCode,
            output: p.output,
          };
          items.splice(items.indexOf(owner), 1, commandItem);
          toolByCall.delete(owner.toolCallId);
          break;
        }
        items.push({ kind: "command", id: `cmd-${p.commandId}`, seq: e.seq, command: p.command, exitCode: p.exitCode, output: p.output });
        break;
      }
      // Subagents do real work inside a run — the RUN inspector has the full tree, but the
      // conversation should at least say one was spawned and how it ended.
      case "subagent.started": {
        const p = e.payload as { agentId: string; role: string; task: string };
        subagentRoles.set(p.agentId, p.role);
        items.push({ kind: "system", id: `subagent-${p.agentId}`, seq: e.seq, turnId: p.agentId, text: `Spawned subagent · ${p.role} — ${p.task}` });
        break;
      }
      case "subagent.completed": {
        const p = e.payload as { agentId: string; result?: string };
        const role = subagentRoles.get(p.agentId) ?? "subagent";
        items.push({ kind: "system", id: `subagent-done-${p.agentId}`, seq: e.seq, turnId: p.agentId, text: `${role} finished` });
        break;
      }
      case "subagent.failed": {
        const p = e.payload as { agentId: string; error: string };
        const role = subagentRoles.get(p.agentId) ?? "subagent";
        items.push({ kind: "system", id: `subagent-failed-${p.agentId}`, seq: e.seq, turnId: p.agentId, text: `${role} failed — ${humanizeBlockReason(p.error) ?? humanizeError(p.error)}` });
        break;
      }
      default: {
        // Parallel-run orchestration emits durable workstream.*/synthesis.*/parallel.* records
        // outside the typed union — surface the lifecycle so delegated work is not invisible.
        const type = e.type as string;
        const workstreamId = (e as unknown as { workstreamId?: string }).workstreamId;
        const payload = e.payload as Record<string, unknown>;
        const system = (text: string, detail?: string) =>
          items.push({ kind: "system", id: `${type}-${workstreamId ?? "run"}-${e.seq}`, seq: e.seq, turnId: workstreamId ?? "parallel", text: detail ? `${text} — ${detail}` : text });
        switch (type) {
          case "parallel.plan.validated": {
            const order = Array.isArray(payload.order) ? payload.order.length : undefined;
            system(`Parallel plan ready${order ? ` — ${order} workstream${order === 1 ? "" : "s"}` : ""}`);
            break;
          }
          case "workstream.dispatched":
            system(`Workstream ${workstreamId} started in an isolated worktree`);
            break;
          case "workstream.reviewing":
            system(`Workstream ${workstreamId} under review`);
            break;
          case "workstream.revising":
            system(`Workstream ${workstreamId} revising after review feedback`);
            break;
          case "workstream.replanned":
            system(`Workstream ${workstreamId} replanned with your steering`);
            break;
          case "workstream.completed":
            system(`Workstream ${workstreamId} completed`);
            break;
          case "workstream.blocked":
            system(`Workstream ${workstreamId} blocked`, humanizeError(String(payload.error ?? "could not finish")));
            break;
          case "workstream.cancelled":
            system(`Workstream ${workstreamId} cancelled`);
            break;
          case "synthesis.blocked":
          case "synthesis.conflict":
            system("Synthesis could not merge the workstreams", humanizeError(String(payload.reason ?? payload.code ?? "")));
            break;
          case "promotion.blocked":
            system("Integration blocked", humanizeError(String(payload.code ?? "")));
            break;
          case "parallel.run.failed":
            system("Parallel run failed", humanizeError(String(payload.error ?? "")));
            break;
          case "parallel.run.cancelled":
            system("Parallel run cancelled");
            break;
          default:
            break;
        }
        break;
      }
    }
  }

  return items;
}

const READ_TOOLS = new Set(["read_file"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * Gate rationales arrive as `code: detail` ("plan_steps_unfinished: 6 plan step(s)…"). The row
 * shows the human reason with the detail kept; an unrecognized rationale passes through verbatim.
 */
function humanizeOutcomeRationale(outcome: string, rationale: string | undefined): string | undefined {
  if (!rationale) return undefined;
  const match = /^([a-z][a-z0-9_]*):\s*(.+)$/s.exec(rationale.trim());
  if (!match) return rationale;
  const state = outcome === "blocked" ? "BLOCKED" : outcome === "completed" ? "COMPLETED" : "FAILED";
  const human = describeReasonCode(match[1], state);
  return human ? `${human} — ${match[2]}` : rationale;
}

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

/**
 * The still-running `run_command` call that produced a `command.executed` event. Matched on the
 * exact command string from the call's args; two in-flight run_command calls with identical
 * commands cannot be told apart, so the match requires an unambiguous owner.
 */
function runningToolForCommand(
  toolByCall: Map<string, Extract<TimelineItem, { kind: "tool" }>>,
  command: string,
): Extract<TimelineItem, { kind: "tool" }> | undefined {
  let match: Extract<TimelineItem, { kind: "tool" }> | undefined;
  let unowned: Extract<TimelineItem, { kind: "tool" }> | undefined;
  let unownedCount = 0;
  for (const item of toolByCall.values()) {
    if (item.status !== "running" || item.toolName !== "run_command") continue;
    let args: { command?: unknown } | undefined;
    try {
      args = item.argsJson ? (JSON.parse(item.argsJson) as { command?: unknown }) : undefined;
    } catch {
      continue;
    }
    if (typeof args?.command === "string") {
      if (args.command !== command) continue;
      if (match) return undefined; // ambiguous: identical commands in flight — keep both rows
      match = item;
    } else {
      unowned = item;
      unownedCount++;
    }
  }
  // A single in-flight run_command that never reported its args still owns the execution.
  return match ?? (unownedCount === 1 ? unowned : undefined);
}

/** True when at least one assistant message with visible text exists in the timeline. */
export function hasAssistantProse(items: TimelineItem[]): boolean {
  return items.some((i) => i.kind === "assistant" && i.text.trim().length > 0);
}
