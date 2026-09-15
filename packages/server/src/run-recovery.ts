import type { AgentRunJournal, AgentRunJournalMessage } from "@codeforge/protocol";
import type { DurableToolExecutionRecord } from "./agent-runtime.js";

export type { AgentRunJournal, AgentRunJournalMessage };

export interface RunRecoveryToolRecord {
  toolName: string;
  executionClass: DurableToolExecutionRecord["executionClass"];
  state: DurableToolExecutionRecord["state"];
}

export type RunRecoveryOutcome =
  | {
      outcome: "resume";
      reason: string;
      /** Tool-call ids present in the transcript without a recorded observation; replay-safe
       * (read-only) calls are re-executed by the resumed run, never blindly for writes. */
      replayToolCallIds: string[];
    }
  | { outcome: "replan"; reason: string }
  | { outcome: "fail"; reason: string };

const TOOL_RECORD_TERMINAL = new Set(["observation_recorded", "completed", "failed", "cancelled"]);
const READ_ONLY_CLASSES = new Set<string>(["read_only"]);

function isToolCallRequest(record: AgentRunJournalMessage): record is AgentRunJournalMessage & { toolCalls: Array<{ id: string; name: string; arguments: string }> } {
  return record.role === "assistant" && Array.isArray(record.toolCalls) && record.toolCalls.length > 0;
}

/**
 * Classify how a crashed run may be recovered from its durable journal and tool-execution
 * records. Pure and deterministic — it never executes a tool and never touches provider state.
 *
 * RESUME requires the recorded conversation to be continuation-safe: every assistant tool-call
 * request must already have its observation, except trailing requests whose durable records are
 * provably replay-safe (read-only). Any unobserved write/command class means the physical side
 * effect may have landed without its result being recorded, so the only honest continuation is a
 * fresh plan (REPLAN). A missing or unreadable journal means there is nothing to continue from
 * (FAIL).
 */
export function classifyRunRecovery(
  journal: AgentRunJournal | undefined,
  toolRecords: RunRecoveryToolRecord[],
): RunRecoveryOutcome {
  if (!journal) {
    return { outcome: "fail", reason: "RECOVERY_FAIL: no durable execution journal exists for this run" };
  }
  if (journal.state === "converged_failed" || journal.state === "completed") {
    return { outcome: "replan", reason: `RECOVERY_REPLAN: journal already terminal (${journal.state})` };
  }
  if (!Array.isArray(journal.messages) || journal.messages.length === 0) {
    return { outcome: "fail", reason: "RECOVERY_FAIL: journal transcript is empty or unreadable" };
  }

  const requestedToolCallIds = new Set<string>();
  const observedToolCallIds = new Set<string>();
  const requestedNamesById = new Map<string, string>();
  for (const message of journal.messages) {
    if (isToolCallRequest(message)) {
      for (const call of message.toolCalls) {
        requestedToolCallIds.add(call.id);
        requestedNamesById.set(call.id, call.name);
      }
    } else if (message.role === "tool" && message.toolCallId) {
      observedToolCallIds.add(message.toolCallId);
    }
  }
  const unobservedToolCallIds = [...requestedToolCallIds].filter((id) => !observedToolCallIds.has(id));

  const nonTerminalRecords = toolRecords.filter((record) => !TOOL_RECORD_TERMINAL.has(record.state));
  const nonTerminalUnsafe = nonTerminalRecords.filter((record) => !READ_ONLY_CLASSES.has(record.executionClass));
  if (nonTerminalUnsafe.length > 0) {
    return {
      outcome: "replan",
      reason: `RECOVERY_REPLAN: ${nonTerminalUnsafe.length} tool execution(s) were mid-flight at crash with non-read-only side effects (${nonTerminalUnsafe.map((r) => r.toolName).join(", ")}); their physical outcome is unknown and not provably replay-safe, so replaying the transcript could duplicate irreversible work`,
    };
  }

  if (unobservedToolCallIds.length === 0) {
    // Transcript is internally consistent. Remaining non-terminal records can only be read-only
    // (filtered above); they are safe to re-issue and their observations will be re-recorded.
    if (nonTerminalRecords.length > 0) {
      return {
        outcome: "resume",
        reason: `RECOVERY_RESUME: transcript is consistent; ${nonTerminalRecords.length} read-only tool execution(s) will be re-issued`,
        replayToolCallIds: [],
      };
    }
    return {
      outcome: "resume",
      reason: "RECOVERY_RESUME: recorded transcript is consistent and every durable tool execution is terminal",
      replayToolCallIds: [],
    };
  }

  // Trailing tool calls lack observations. Replay is only honest when each unobserved call is
  // provably read-only per its durable record and tool name.
  const KNOWN_READ_ONLY_TOOLS = new Set([
    "list_files", "read_file", "search_files", "get_file_outline", "get_diagnostics",
    "find_references", "find_definition", "repo_index_status", "repo_query_symbols", "repo_explain_context",
  ]);
  const unobservedNames = new Set(unobservedToolCallIds.map((id) => requestedNamesById.get(id) ?? "?"));
  const allNamesReadOnly = unobservedToolCallIds.every((id) => KNOWN_READ_ONLY_TOOLS.has(requestedNamesById.get(id) ?? ""));
  const recordsForUnobserved = nonTerminalRecords.filter((record) => unobservedNames.has(record.toolName));

  if (!allNamesReadOnly || recordsForUnobserved.some((record) => !READ_ONLY_CLASSES.has(record.executionClass))) {
    return {
      outcome: "replan",
      reason: `RECOVERY_REPLAN: ${unobservedToolCallIds.length} tool call(s) lack recorded observations and are not provably replay-safe (${[...unobservedNames].join(", ")})`,
    };
  }
  return {
    outcome: "resume",
    reason: `RECOVERY_RESUME: ${unobservedToolCallIds.length} read-only tool call(s) will be replayed before continuing the recorded conversation`,
    replayToolCallIds: unobservedToolCallIds,
  };
}
