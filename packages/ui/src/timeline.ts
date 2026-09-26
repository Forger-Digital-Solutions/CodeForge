import type { WorkspaceEvent } from "@codeforge/protocol";
import { describeTurnStop, humanizeBlockReason, humanizeError } from "./error-copy.js";
import { describeReasonCode } from "./run-lifecycle.js";

/**
 * A single rendered item in the conversation timeline, reconstructed from the event stream.
 * Ordering is chronological (by the seq at which the item first appeared), so assistant prose
 * and tool activity interleave correctly: user → assistant → tool → tool → assistant → …
 *
 * `ts` on every item is the source event's timestamp — grouping and elapsed-time surfaces use
 * it; it is never the ordering key (seq is).
 */
export type TimelineItem =
  | { kind: "user"; id: string; seq: number; turnId: string; text: string; ts: string }
  | { kind: "assistant"; id: string; seq: number; turnId: string; messageId: string; text: string; streaming: boolean; ts: string }
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
      ts: string;
    }
  | { kind: "system"; id: string; seq: number; turnId: string; text: string; ts: string }
  | { kind: "phase"; id: string; seq: number; turnId?: string; phase: "testing" | "repairing" | "reviewing" | "outcome"; text: string; detail?: string; ts: string }
  | {
      kind: "file";
      id: string;
      seq: number;
      turnId?: string;
      path: string;
      action: "read" | "written" | "created" | "modified" | "deleted" | "reverted";
      detail?: string;
      additions?: number;
      deletions?: number;
      diff?: string;
      ts: string;
    }
  | {
      kind: "command";
      id: string;
      seq: number;
      turnId?: string;
      command: string;
      /** Absent while the command is still streaming. */
      exitCode?: number;
      output?: string;
      status: "running" | "completed" | "failed";
      workingDirectory?: string;
      durationMs?: number;
      ts: string;
    }
  | {
      kind: "steer";
      id: string;
      seq: number;
      turnId: string;
      text: string;
      ts: string;
    }
  | {
      kind: "subagent";
      id: string;
      seq: number;
      turnId?: string;
      agentId: string;
      role: string;
      task: string;
      status: "queued" | "running" | "waiting" | "blocked" | "completed" | "failed" | "cancelled";
      /** Latest progress line the worker reported; full history lives in progressLog. */
      progress?: string;
      percent?: number;
      progressLog: string[];
      result?: string;
      error?: string;
      artifacts: string[];
      ts: string;
    }
  | {
      kind: "notice";
      id: string;
      seq: number;
      turnId?: string;
      notice: "capacity_wait" | "route_switch" | "checkpoint";
      text: string;
      detail?: string;
      ts: string;
    };

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
  /** Live command rows by commandId — command.started/output/completed join onto one row. */
  const commandById = new Map<string, Extract<TimelineItem, { kind: "command" }>>();
  /** One row per delegated worker — started/progress/lifecycle/terminal all update it. */
  const subagentById = new Map<string, Extract<TimelineItem, { kind: "subagent" }>>();
  /** file.change_* records by changeId so apply/revert updates the proposal row. */
  const fileChangeById = new Map<string, Extract<TimelineItem, { kind: "file" }>>();
  const seenUserTurns = new Set<string>();
  // Track the last open assistant message per turn for delta fallback (no messageId case).
  const lastOpenMsgByTurn = new Map<string, string>();
  const subagentRoles = new Map<string, string>();
  // A workflow's own outcome row supersedes the raw turn terminal event that follows it, and the
  // internal implement/repair turns a workflow dispatches report through that outcome, not per turn.
  let outcomeShown = false;
  const workflowTurns = new Set<string>();

  const ensureAssistant = (turnId: string, messageId: string, seq: number, ts: string): Extract<TimelineItem, { kind: "assistant" }> => {
    let item = assistantByMsg.get(messageId);
    if (!item) {
      item = { kind: "assistant", id: `assistant-${messageId}`, seq, turnId, messageId, text: "", streaming: true, ts };
      assistantByMsg.set(messageId, item);
      lastOpenMsgByTurn.set(turnId, messageId);
      items.push(item);
    }
    return item;
  };

  /**
   * The command row for `commandId`, creating it when an output/completed record is the first
   * thing seen (older producers emitted results without a start record).
   */
  const ensureCommand = (commandId: string, seq: number, ts: string): Extract<TimelineItem, { kind: "command" }> => {
    let item = commandById.get(commandId);
    if (!item) {
      item = { kind: "command", id: `cmd-${commandId}`, seq, command: "", status: "running", ts };
      commandById.set(commandId, item);
      items.push(item);
    }
    return item;
  };

  /** The live worker row for `agentId` — created on the first event that names it. */
  const ensureSubagent = (agentId: string, seq: number, ts: string): Extract<TimelineItem, { kind: "subagent" }> => {
    let item = subagentById.get(agentId);
    if (!item) {
      item = {
        kind: "subagent", id: `subagent-${agentId}`, seq, agentId,
        role: subagentRoles.get(agentId) ?? "subagent", task: "", status: "running",
        progressLog: [], artifacts: [], ts,
      };
      subagentById.set(agentId, item);
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
            items.push({ kind: "user", id: `user-${p.turnId}`, seq: e.seq, turnId: p.turnId, text: p.userMessage, ts: e.timestamp });
          } else {
            workflowTurns.add(p.turnId);
          }
        }
        break;
      }
      case "turn.steered": {
        const p = e.payload as { turnId: string; steering: string };
        items.push({ kind: "steer", id: `steer-${e.seq}`, seq: e.seq, turnId: p.turnId, text: p.steering, ts: e.timestamp });
        break;
      }
      case "workflow.verification_completed": {
        const p = e.payload as { attempt: number; passed: number; failed: number; skipped: number };
        const detail = `${p.passed} passed${p.failed > 0 ? ` · ${p.failed} failed` : ""}${p.skipped > 0 ? ` · ${p.skipped} skipped` : ""}`;
        items.push({ kind: "phase", id: `verify-${e.seq}`, seq: e.seq, phase: "testing", text: `Verification · attempt ${p.attempt}`, detail, ts: e.timestamp });
        break;
      }
      case "workflow.repair_attempted": {
        const p = e.payload as { attempt: number; summary?: string };
        items.push({ kind: "phase", id: `repair-${e.seq}`, seq: e.seq, phase: "repairing", text: `Repairing verification failure · attempt ${p.attempt}`, detail: p.summary, ts: e.timestamp });
        break;
      }
      case "workflow.review_completed": {
        const p = e.payload as { approved: boolean; findings?: unknown[]; diffCount?: number };
        items.push({ kind: "phase", id: `review-${e.seq}`, seq: e.seq, phase: "reviewing", text: "Review", detail: `${p.approved ? "approved" : "findings"}${p.findings?.length ? ` · ${p.findings.length} findings` : ""}`, ts: e.timestamp });
        break;
      }
      case "workflow.completion_decided": {
        const p = e.payload as { outcome: string; rationale?: string };
        items.push({ kind: "phase", id: `outcome-${e.seq}`, seq: e.seq, phase: "outcome", text: p.outcome === "completed" ? "Done" : p.outcome === "blocked" ? "Blocked" : "Failed", detail: humanizeOutcomeRationale(p.outcome, p.rationale), ts: e.timestamp });
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
        items.push({ kind: "phase", id: `turn-failed-${p.turnId}-${e.seq}`, seq: e.seq, turnId: p.turnId, phase: "outcome", text: "Failed", detail, ts: e.timestamp });
        break;
      }
      case "turn.cancelled": {
        const p = e.payload as { turnId: string; reason?: string };
        if (workflowTurns.has(p.turnId)) break;
        if (outcomeShown) { outcomeShown = false; break; }
        items.push({ kind: "phase", id: `turn-cancelled-${p.turnId}-${e.seq}`, seq: e.seq, turnId: p.turnId, phase: "outcome", text: "Stopped", detail: describeTurnStop(p.reason), ts: e.timestamp });
        break;
      }
      case "turn.completed": {
        // A workflow outcome row already told the story; a plain chat turn needs nothing extra.
        outcomeShown = false;
        break;
      }
      case "execution.start_failed": {
        const p = e.payload as { requestId: string; code: string; message: string };
        items.push({ kind: "phase", id: `start-failed-${p.requestId}-${e.seq}`, seq: e.seq, phase: "outcome", text: "Failed", detail: humanizeError(p.message ?? p.code), ts: e.timestamp });
        break;
      }
      case "assistant.message.started": {
        const p = e.payload;
        ensureAssistant(p.turnId, p.messageId, e.seq, e.timestamp);
        break;
      }
      case "text.delta": {
        const p = e.payload as { turnId: string; delta: string; messageId?: string };
        const messageId = p.messageId ?? lastOpenMsgByTurn.get(p.turnId) ?? `auto-${p.turnId}`;
        const item = ensureAssistant(p.turnId, messageId, e.seq, e.timestamp);
        item.text += p.delta;
        break;
      }
      case "assistant.message.completed": {
        const p = e.payload;
        const item = ensureAssistant(p.turnId, p.messageId, e.seq, e.timestamp);
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
          ts: e.timestamp,
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
        items.push({ kind: "file", id: `file-${p.fileCallId}`, seq: e.seq, path: p.path, action: "read", detail, ts: e.timestamp });
        break;
      }
      case "file.written": {
        const p = e.payload as { fileCallId: string; path: string; bytesOrChars?: number };
        const owner = runningToolForPath(toolByCall, p.path, "written");
        if (owner) {
          owner.fileDetail = "written";
          break;
        }
        items.push({ kind: "file", id: `file-${p.fileCallId}`, seq: e.seq, path: p.path, action: "written", ts: e.timestamp });
        break;
      }
      case "file.change_proposed": {
        const p = e.payload as { changeId: string; path: string; changeType: "created" | "modified" | "deleted"; additions: number; deletions: number; description?: string; diff?: string };
        const owner = runningToolForPath(toolByCall, p.path, "written");
        if (owner) {
          // The write tool row owns this change; carry the diff onto it so Changes stays the source of truth.
          owner.fileDetail = p.changeType;
          break;
        }
        const item: Extract<TimelineItem, { kind: "file" }> = {
          kind: "file", id: `change-${p.changeId}`, seq: e.seq, path: p.path, action: p.changeType,
          detail: p.description, additions: p.additions, deletions: p.deletions, diff: p.diff, ts: e.timestamp,
        };
        fileChangeById.set(p.changeId, item);
        items.push(item);
        break;
      }
      case "file.change_applied": {
        const p = e.payload as { changeId: string; path: string };
        const item = fileChangeById.get(p.changeId);
        if (item && item.action !== "reverted") item.detail = "applied";
        else if (!item) items.push({ kind: "file", id: `change-${p.changeId}`, seq: e.seq, path: p.path, action: "written", ts: e.timestamp });
        break;
      }
      case "file.change_reverted": {
        const p = e.payload as { changeId: string; path: string };
        const item = fileChangeById.get(p.changeId);
        if (item) {
          item.action = "reverted";
          item.detail = "reverted";
        } else {
          items.push({ kind: "file", id: `change-${p.changeId}`, seq: e.seq, path: p.path, action: "reverted", detail: "reverted", ts: e.timestamp });
        }
        break;
      }
      case "command.started": {
        const p = e.payload as { commandId: string; command: string; workingDirectory?: string };
        // The run_command tool row for this command is redundant — the live command card is the
        // richer presentation, so it adopts the tool row's position in the feed.
        const owner = runningToolForCommand(toolByCall, p.command);
        if (owner) {
          const item: Extract<TimelineItem, { kind: "command" }> = {
            kind: "command", id: `cmd-${p.commandId}`, seq: owner.seq, turnId: owner.turnId,
            command: p.command, status: "running", workingDirectory: p.workingDirectory, ts: e.timestamp,
          };
          items.splice(items.indexOf(owner), 1, item);
          toolByCall.delete(owner.toolCallId);
          commandById.set(p.commandId, item);
          break;
        }
        const item = ensureCommand(p.commandId, e.seq, e.timestamp);
        item.command = p.command;
        item.workingDirectory = p.workingDirectory;
        break;
      }
      case "command.output": {
        const p = e.payload as { commandId: string; output: string; stream?: "stdout" | "stderr" };
        const item = ensureCommand(p.commandId, e.seq, e.timestamp);
        item.output = (item.output ?? "") + p.output;
        break;
      }
      case "command.completed": {
        const p = e.payload as { commandId: string; exitCode: number; durationMs: number };
        const item = ensureCommand(p.commandId, e.seq, e.timestamp);
        item.exitCode = p.exitCode;
        item.durationMs = p.durationMs;
        item.status = p.exitCode === 0 ? "completed" : "failed";
        break;
      }
      case "command.executed": {
        const p = e.payload as { commandId: string; command: string; output: string; exitCode: number };
        // The run_command tool call this execution belongs to already has a row; showing the same
        // command again as a second row reads as two commands. The command card is the richer
        // presentation, so the tool row is replaced in place — its seq keeps the slot in order.
        const owner = runningToolForCommand(toolByCall, p.command);
        const commandItem: Extract<TimelineItem, { kind: "command" }> = {
          kind: "command",
          id: `cmd-${p.commandId}`,
          seq: owner?.seq ?? e.seq,
          turnId: owner?.turnId,
          command: p.command,
          exitCode: p.exitCode,
          output: p.output,
          status: p.exitCode === 0 ? "completed" : "failed",
          ts: e.timestamp,
        };
        if (owner) {
          items.splice(items.indexOf(owner), 1, commandItem);
          toolByCall.delete(owner.toolCallId);
        } else {
          items.push(commandItem);
        }
        commandById.set(p.commandId, commandItem);
        break;
      }
      // One row per delegated worker: started/progress/lifecycle/terminal all update it in place,
      // so parallel work reads as a small set of live agents rather than an event dump.
      case "subagent.started": {
        const p = e.payload as { agentId: string; role: string; task: string };
        subagentRoles.set(p.agentId, p.role);
        const item = ensureSubagent(p.agentId, e.seq, e.timestamp);
        item.role = p.role;
        item.task = displayableSubagentTask(p.task);
        item.status = "running";
        break;
      }
      case "subagent.progress": {
        const p = e.payload as { agentId: string; message: string; percent?: number };
        const item = ensureSubagent(p.agentId, e.seq, e.timestamp);
        item.progress = p.message;
        if (p.percent !== undefined) item.percent = p.percent;
        if (item.progressLog[item.progressLog.length - 1] !== p.message) item.progressLog.push(p.message);
        if (item.progressLog.length > 40) item.progressLog.splice(0, item.progressLog.length - 40);
        break;
      }
      case "subagent.lifecycle": {
        const p = e.payload as { agentId: string; role: string; task: string; state: string; reason?: string };
        const item = ensureSubagent(p.agentId, e.seq, e.timestamp);
        subagentRoles.set(p.agentId, p.role);
        item.role = p.role;
        item.task = displayableSubagentTask(p.task);
        item.status = workerTimelineStatus(p.state);
        if (p.reason && (item.status === "blocked" || item.status === "failed")) {
          item.error = humanizeBlockReason(p.reason) ?? humanizeError(p.reason);
        }
        break;
      }
      case "subagent.artifact_written": {
        const p = e.payload as { agentId: string; artifact: { ref: string } };
        const item = ensureSubagent(p.agentId, e.seq, e.timestamp);
        if (!item.artifacts.includes(p.artifact.ref)) item.artifacts.push(p.artifact.ref);
        break;
      }
      case "subagent.completed": {
        const p = e.payload as { agentId: string; result?: string };
        const item = ensureSubagent(p.agentId, e.seq, e.timestamp);
        item.status = "completed";
        item.result = p.result;
        break;
      }
      case "subagent.failed": {
        const p = e.payload as { agentId: string; error: string };
        const item = ensureSubagent(p.agentId, e.seq, e.timestamp);
        item.status = "failed";
        item.error = humanizeBlockReason(p.error) ?? humanizeError(p.error);
        break;
      }
      case "eightbit.status": {
        const p = e.payload as { event: string; selected?: { providerId: string; modelId: string }; reasonCodes: string[]; accessibleText: string };
        // Capacity waits and route switches are the honest "why nothing is moving" story — a quiet
        // notice row, never a failure. Steady-state catalog noise stays out of the feed.
        if (p.event === "FREE_CAPACITY_WAIT") {
          items.push({ kind: "notice", id: `notice-${e.seq}`, seq: e.seq, notice: "capacity_wait", text: "Waiting for free capacity", detail: p.accessibleText || undefined, ts: e.timestamp });
        } else if (p.event === "ROUTE_ROTATED" && p.selected) {
          items.push({ kind: "notice", id: `notice-${e.seq}`, seq: e.seq, notice: "route_switch", text: `Switched to ${p.selected.providerId}/${p.selected.modelId}`, detail: p.accessibleText || undefined, ts: e.timestamp });
        } else if (p.event === "NO_ELIGIBLE_FREE_MODEL") {
          items.push({ kind: "notice", id: `notice-${e.seq}`, seq: e.seq, notice: "capacity_wait", text: "No free route available", detail: p.accessibleText || undefined, ts: e.timestamp });
        }
        break;
      }
      case "checkpoint.created": {
        const p = e.payload as { checkpointId: string; label: string; fileCount: number };
        items.push({ kind: "notice", id: `checkpoint-${p.checkpointId}`, seq: e.seq, notice: "checkpoint", text: p.label, detail: `${p.fileCount} file${p.fileCount === 1 ? "" : "s"}`, ts: e.timestamp });
        break;
      }
      default: {
        // Parallel-run orchestration emits durable workstream.*/synthesis.*/parallel.* records
        // outside the typed union — surface the lifecycle so delegated work is not invisible.
        const type = e.type as string;
        const workstreamId = (e as unknown as { workstreamId?: string }).workstreamId;
        const payload = e.payload as Record<string, unknown>;
        const system = (text: string, detail?: string) =>
          items.push({ kind: "system", id: `${type}-${workstreamId ?? "run"}-${e.seq}`, seq: e.seq, turnId: workstreamId ?? "parallel", text: detail ? `${text} — ${detail}` : text, ts: e.timestamp });
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
 * The backend's worker lifecycle state vocabulary mapped onto the feed's subagent row states.
 * queued/waiting/blocked stay visible as themselves — collapsing them into "running" would lie
 * about a parked worker the way the lifecycle bar refuses to.
 */
function workerTimelineStatus(state: string): Extract<TimelineItem, { kind: "subagent" }>["status"] {
  switch (state) {
    case "created":
    case "queued":
      return "queued";
    case "starting":
    case "running":
    case "recovering":
      return "running";
    case "waiting":
      return "waiting";
    case "blocked":
      return "blocked";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

/**
 * Worker `task` fields sometimes carry internal correlation ids instead of assignment prose
 * (mirrors `displayableAgentTask` in run-inspection) — those stay out of the primary label.
 */
function displayableSubagentTask(task: unknown): string {
  if (typeof task !== "string" || task.length === 0) return "";
  return /^(plan-|task-|[0-9a-f]{8}-[0-9a-f]{4}-)/i.test(task) ? "" : task;
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
