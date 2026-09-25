import type { ChatMessage } from "@codeforge/providers";

/**
 * R34 dispatch-time history compaction for the interactive turn loop.
 *
 * Two rules, both non-destructive (the durable `messageHistory` and run journal keep the
 * authoritative outputs — only the per-dispatch copy shrinks):
 *
 * 1. Identical-argument supersession: a tool result that is later re-issued with identical
 *    arguments is provably stale — the newer result is authoritative.
 * 2. Mutation staleness: after a successful write_file/edit_file to path P, earlier
 *    read-type observations of P are stale. The role-run transcript already rewrites these
 *    durably; the interactive loop had no equivalent, so stale file contents both wasted
 *    input tokens and could mislead subsequent edits (edit_file's hash protection would
 *    reject against them anyway). Mirrors that behavior at dispatch without mutating the
 *    journal. run_command is deliberately not a mutation trigger: most commands are
 *    reads/tests, and invalidating everything after each would force expensive re-reads.
 */

function isSupersedableTool(name: string): boolean {
  return name === "read_file" || name === "list_files" || name === "search_files" || name.startsWith("repo_");
}

function isPathMutationTool(name: string): boolean {
  return name === "write_file" || name === "edit_file";
}

const ERROR_PREFIX = /^(Error:|\[Denied|\[Blocked|\[Cancelled|\[Expired|Unknown tool)/;

/** Deterministic key for a JSON argument string: key order and whitespace insensitive. */
function stableArgsKey(argsJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const sortValue = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(sortValue).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${sortValue((value as Record<string, unknown>)[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return sortValue(parsed);
}

function argsPath(argsJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { path?: unknown }).path === "string") {
      return (parsed as { path: string }).path;
    }
  } catch {
    /* malformed args — not a keyable mutation */
  }
  return undefined;
}

/**
 * Compact stale tool outputs in a dispatch-time message list. Returns the input array
 * untouched when nothing is stale (callers may rely on identity for a fast path).
 */
export function compactSupersededToolOutputs(messages: ChatMessage[]): ChatMessage[] {
  // Map each toolCallId to its call metadata.
  const callMetaById = new Map<string, { name: string; argsJson: string; key?: string; path?: string }>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const tc of message.toolCalls) {
      const name = tc.function?.name;
      if (!name) continue;
      const argsJson = tc.function?.arguments ?? "";
      callMetaById.set(tc.id, {
        name,
        argsJson,
        ...(isSupersedableTool(name) ? { key: stableArgsKey(argsJson) } : {}),
        ...(isPathMutationTool(name) ? { path: argsPath(argsJson) } : {}),
      });
    }
  }
  if (callMetaById.size === 0) return messages;

  // Latest index providing each (tool,args) observation — earlier ones are superseded.
  const latestIndexByKey = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role !== "tool" || !message.toolCallId) return;
    const meta = callMetaById.get(message.toolCallId);
    if (meta?.key !== undefined) latestIndexByKey.set(`${meta.name}\0${meta.key}`, index);
  });

  // Successful write/edit result indices plus the path they mutated. A read of that path
  // at an earlier index is stale — superseded by the mutation itself.
  const mutations: Array<{ index: number; path: string }> = [];
  messages.forEach((message, index) => {
    if (message.role !== "tool" || !message.toolCallId) return;
    const meta = callMetaById.get(message.toolCallId);
    if (meta?.path === undefined) return;
    if (ERROR_PREFIX.test(message.content ?? "")) return;
    mutations.push({ index, path: meta.path });
  });

  let result: ChatMessage[] | undefined;
  const markStale = (index: number, content: string): void => {
    const message = messages[index];
    if (!message || message.content === content) return;
    // Already-invalidated markers (the role path's durable rewrite, or a prior compaction
    // pass) are ~130 chars — replacing them with another marker churns text for ~zero bytes
    // and would erase the better provenance the durable invalidation carries.
    if ((message.content?.length ?? 0) <= 256) return;
    result ??= messages.slice();
    result[index] = { ...message, content };
  };

  messages.forEach((message, index) => {
    if (message.role !== "tool" || !message.toolCallId) return;
    const meta = callMetaById.get(message.toolCallId);
    if (!meta || !isSupersedableTool(meta.name)) return;
    if (meta.key !== undefined && latestIndexByKey.get(`${meta.name}\0${meta.key}`) !== index) {
      markStale(index, `[superseded: a newer ${meta.name} result with identical arguments is authoritative; this stale output was removed from model context]`);
      return;
    }
    const readPath = argsPath(meta.argsJson);
    if (readPath !== undefined && mutations.some((m) => m.index > index && m.path === readPath)) {
      markStale(index, `[stale: a successful write to ${readPath} invalidated this ${meta.name} result; it was removed from model context — re-read before relying on it]`);
    }
  });
  return result ?? messages;
}
