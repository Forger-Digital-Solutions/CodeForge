import type { ContextComposition, MeasuredNumber, RunRecord } from "./run-record.js";
import { derived, unknownMetric } from "./run-record.js";
import { sha256, type RecordedRequest } from "./recording-provider.js";

/**
 * Context accounting over a run's recorded model calls (protocol §10).
 *
 * Exact-hash arithmetic only. The conversation prefix re-sent on every call is the provider-
 * statelessness repeat and is reported separately from waste. "Avoidable duplicate" is limited to
 * two exact conditions: (1) a tool result whose content hash equals an earlier tool result of the
 * same tool with identical canonical arguments and no intervening mutating action; (2) file
 * content injected at bootstrap that is later re-read verbatim by `read_file` with no intervening
 * write to that path. Anything softer is not counted here.
 */

export type AvoidableDuplicateEvent = RunRecord["context"]["avoidableDuplicateEvents"][number];

export interface ToolCallTrace {
  /** Call index on which the model emitted the tool call. */
  callIndex: number;
  /** Role of the agent that issued the call (from the recorded request). */
  role?: string;
  toolCallId: string;
  toolName: string;
  /** Canonical arguments (as the runtime parsed them), when known; else the raw hash. */
  argumentsDigest: string;
  argumentsBytes: number;
  /** Tool result content hash and size as delivered to the model on the following call. */
  resultHash?: string;
  resultBytes?: number;
  /** Path the tool read or wrote, when the arguments name one. */
  path?: string;
}

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "run_command", "apply_patch", "write_patch", "delete_file", "move_file"]);
const READ_TOOLS = new Set(["read_file", "list_files", "search_files", "repo_context", "search_workspace"]);

export function isMutatingTool(name: string): boolean {
  const lower = name.toLowerCase();
  if (MUTATING_TOOLS.has(lower)) return true;
  // External interaction classes bump state as well (R22): browser interactions/submit, MCP external effects.
  return /^browser_(click|type|select|submit|navigate)/.test(lower) || lower.startsWith("plugin__");
}

export function isReadTool(name: string): boolean {
  const lower = name.toLowerCase();
  if (READ_TOOLS.has(lower)) return true;
  return /^browser_(inspect|read|screenshot|get)/.test(lower) || lower.startsWith("mcp__");
}

/** Message-level composition of one request. Tool results are attributed by tool name when the
 * message carries one (`name`), else by a `[tool:<name>]`/`Tool result (<name>)` prefix. */
export function composeRequest(request: RecordedRequest): ContextComposition {
  const composition: ContextComposition = { systemBytes: 0, userTaskBytes: 0, assistantBytes: 0, toolResultBytes: 0, toolResultBytesByTool: {}, otherBytes: 0 };
  let sawFirstUser = false;
  for (const message of request.messages) {
    switch (message.role) {
      case "system":
        composition.systemBytes += message.bytes;
        break;
      case "assistant":
        composition.assistantBytes += message.bytes;
        break;
      case "tool": {
        composition.toolResultBytes += message.bytes;
        const tool = message.toolName ?? inferToolName(message.content) ?? "unknown";
        composition.toolResultBytesByTool[tool] = (composition.toolResultBytesByTool[tool] ?? 0) + message.bytes;
        break;
      }
      case "user": {
        // The first user message is the assembled task/bootstrap context; later user messages are
        // runtime-injected tool results or steering — classify tool-result-shaped ones as such.
        if (!sawFirstUser) {
          sawFirstUser = true;
          composition.userTaskBytes += message.bytes;
        } else {
          const tool = inferToolName(message.content);
          if (tool) {
            composition.toolResultBytes += message.bytes;
            composition.toolResultBytesByTool[tool] = (composition.toolResultBytesByTool[tool] ?? 0) + message.bytes;
          } else {
            composition.userTaskBytes += message.bytes;
          }
        }
        break;
      }
      default:
        composition.otherBytes += message.bytes;
    }
  }
  return composition;
}

const TOOL_RESULT_PREFIXES = [
  /^\s*\[tool:([a-zA-Z0-9_.:-]+)\]/,
  /^\s*Tool result \(([a-zA-Z0-9_.:-]+)\)/i,
  /^\s*Tool `([a-zA-Z0-9_.:-]+)` (?:returned|result)/i,
  /^\s*Result of ([a-zA-Z0-9_.:-]+):/i,
  /^\s*\[reused\] ([a-zA-Z0-9_.:-]+)/i,
  /<tool_result name="([a-zA-Z0-9_.:-]+)"/,
];

export function inferToolName(content: string): string | undefined {
  const head = content.slice(0, 200);
  for (const re of TOOL_RESULT_PREFIXES) {
    const match = head.match(re);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export interface ContextAnalysis {
  avoidableDuplicateBytesWithinRole: number;
  avoidableDuplicateBytesCrossRole: number;
  transmittedContextBytes: number;
  finalConversationBytes: number;
  providerStatelessnessRepeatBytes: number;
  finalComposition: ContextComposition;
  avoidableDuplicateBytes: number;
  avoidableDuplicateEvents: AvoidableDuplicateEvent[];
  avoidableDuplicateTokens: MeasuredNumber;
  promptTokensPerByte?: number;
}

/**
 * Strip the runtime's duplicate-suppression provenance prefix so a replayed result hashes equal
 * to the original (the protocol counts replays as duplicates of *content*, the runtime already
 * saved the physical dispatch).
 */
export function normalizeToolResult(content: string): string {
  return content
    .replace(/^\s*\[(?:reused|replayed)[^\]]*\]\s*/i, "")
    .replace(/^\s*\(ForgeGreen: identical result reused[^)]*\)\s*/i, "")
    .trimEnd();
}

/**
 * Exact duplicate detection over the tool-call trace. `bootstrapFileContents` maps a workspace
 * path to the exact content injected at bootstrap (when the harness knows it).
 */
export function analyzeContext(
  requests: readonly RecordedRequest[],
  trace: readonly ToolCallTrace[],
  options: { bootstrapFileContents?: Map<string, string>; promptTokens?: number; promptBytes?: number } = {},
): ContextAnalysis {
  const transmitted = requests.reduce((sum, request) => sum + request.requestBytes, 0);
  const last = requests[requests.length - 1];
  const finalBytes = last ? last.messages.reduce((sum, message) => sum + message.bytes, 0) : 0;
  const finalComposition = last ? composeRequest(last) : { systemBytes: 0, userTaskBytes: 0, assistantBytes: 0, toolResultBytes: 0, toolResultBytesByTool: {}, otherBytes: 0 };

  const events: AvoidableDuplicateEvent[] = [];
  // Condition (1): identical read-tool result with identical arguments, no mutation in between.
  const seen = new Map<string, { callIndex: number; stateVersion: number; resultHash: string; role?: string }>();
  let stateVersion = 0;
  const ordered = [...trace].sort((a, b) => a.callIndex - b.callIndex);
  for (const call of ordered) {
    if (isMutatingTool(call.toolName)) {
      // Conservative: any mutation invalidates every prior read (protocol §10 — "no intervening
      // mutating action"), so a re-read after an unrelated write is never counted as waste.
      stateVersion += 1;
      continue;
    }
    if (!isReadTool(call.toolName) || !call.resultHash) continue;
    const key = `${call.toolName.toLowerCase()}\0${call.argumentsDigest}`;
    const prior = seen.get(key);
    if (prior && prior.stateVersion === stateVersion && prior.resultHash === call.resultHash) {
      events.push({ kind: "duplicate_tool_result", tool: call.toolName, argumentsDigest: call.argumentsDigest, bytes: call.resultBytes ?? 0, firstCallIndex: prior.callIndex, repeatCallIndex: call.callIndex, ...(prior.role ? { firstRole: prior.role } : {}), ...(call.role ? { repeatRole: call.role } : {}), crossRole: prior.role !== undefined && call.role !== undefined && prior.role !== call.role });
      // Attribute the next repeat to the most recent delivery of the same content, so an agent
      // re-reading its own read is within-role, not a second cross-role hit.
      seen.set(key, { callIndex: call.callIndex, stateVersion, resultHash: call.resultHash, ...(call.role ? { role: call.role } : {}) });
      continue;
    }
    seen.set(key, { callIndex: call.callIndex, stateVersion, resultHash: call.resultHash, ...(call.role ? { role: call.role } : {}) });
  }
  // Condition (2): bootstrap-injected file content re-read verbatim before any write to the path.
  if (options.bootstrapFileContents) {
    const written = new Set<string>();
    for (const call of ordered) {
      if (isMutatingTool(call.toolName) && call.path) written.add(call.path);
      if (call.toolName.toLowerCase() !== "read_file" || !call.path || !call.resultHash) continue;
      if (written.has(call.path)) continue;
      const bootstrap = options.bootstrapFileContents.get(call.path);
      if (bootstrap !== undefined && sha256(bootstrap.trimEnd()) === call.resultHash) {
        events.push({ kind: "bootstrap_then_reread", tool: call.toolName, argumentsDigest: call.argumentsDigest, bytes: call.resultBytes ?? Buffer.byteLength(bootstrap, "utf8"), firstCallIndex: -1, repeatCallIndex: call.callIndex, ...(call.role ? { repeatRole: call.role } : {}), crossRole: false });
      }
    }
  }
  const avoidableBytes = events.reduce((sum, event) => sum + event.bytes, 0);
  const ratio = options.promptTokens !== undefined && options.promptBytes !== undefined && options.promptBytes > 0 ? options.promptTokens / options.promptBytes : undefined;
  const avoidableTokens = ratio === undefined
    ? unknownMetric("provider prompt-token/byte ratio unavailable")
    : derived(Math.round(avoidableBytes * ratio), "HARNESS", "bytes × run prompt-token/byte ratio");
  return {
    avoidableDuplicateBytesWithinRole: events.filter((event) => !event.crossRole).reduce((sum, event) => sum + event.bytes, 0),
    avoidableDuplicateBytesCrossRole: events.filter((event) => event.crossRole).reduce((sum, event) => sum + event.bytes, 0),
    transmittedContextBytes: transmitted,
    finalConversationBytes: finalBytes,
    providerStatelessnessRepeatBytes: Math.max(0, transmitted - finalBytes),
    finalComposition,
    avoidableDuplicateBytes: avoidableBytes,
    avoidableDuplicateEvents: events,
    avoidableDuplicateTokens: avoidableTokens,
    ...(ratio !== undefined ? { promptTokensPerByte: ratio } : {}),
  };
}

/**
 * Build the tool-call trace from recorded requests alone: the tool calls a call emitted are matched
 * to the tool-result messages that first appear on the next request. Works for both message
 * conventions the runtime uses (role `tool` with `toolCallId`, or a user message wrapping the
 * result). Argument digests are over the raw argument string the model produced; callers with
 * access to the runtime's canonical arguments may override them.
 */
export function traceFromRequests(requests: readonly RecordedRequest[]): ToolCallTrace[] {
  const trace: ToolCallTrace[] = [];
  for (let i = 0; i < requests.length; i += 1) {
    const request = requests[i]!;
    const next = requests[i + 1];
    const newMessages = next ? next.messages.slice(request.messages.length) : [];
    const resultsById = new Map<string, { hash: string; bytes: number }>();
    const resultsInOrder: Array<{ hash: string; bytes: number; toolName?: string }> = [];
    for (const message of newMessages) {
      if (message.role === "assistant") continue;
      const normalized = normalizeToolResult(message.content);
      const entry = { hash: sha256(normalized), bytes: Buffer.byteLength(normalized, "utf8"), toolName: message.toolName ?? inferToolName(message.content) };
      if (message.toolCallId) resultsById.set(message.toolCallId, entry);
      resultsInOrder.push(entry);
    }
    request.emittedToolCalls.forEach((emitted, position) => {
      const byId = resultsById.get(emitted.id);
      const fallback = resultsInOrder[position];
      const result = byId ?? fallback;
      const canonical = canonicalArguments(emitted.arguments);
      trace.push({
        callIndex: request.callIndex,
        role: request.role,
        toolCallId: emitted.id,
        toolName: emitted.name,
        argumentsDigest: sha256(canonical.json),
        argumentsBytes: emitted.argumentsBytes,
        ...(canonical.path ? { path: canonical.path } : {}),
        ...(result ? { resultHash: result.hash, resultBytes: result.bytes } : {}),
      });
    });
  }
  return trace;
}

/** Stable JSON of the model's arguments (sorted keys) so formatting differences never defeat
 * duplicate detection; falls back to the raw string when the arguments are not JSON. */
export function canonicalArguments(raw: string): { json: string; path?: string } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const json = stableJson(parsed);
    const path = parsed && typeof parsed === "object" && typeof (parsed as { path?: unknown }).path === "string" ? (parsed as { path: string }).path.split("\\").join("/") : undefined;
    return { json, ...(path ? { path } : {}) };
  } catch {
    return { json: raw };
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
