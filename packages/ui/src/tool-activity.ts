/**
 * Readable descriptions of tool activity.
 *
 * While an agent works, the tool feed IS the progress report — it is how a user follows what is
 * happening and spots it going wrong early. "Read file / running" says almost nothing: it omits
 * WHICH file and WHAT came back, so a hundred identical rows scroll past carrying no information.
 *
 * These helpers turn the arguments and result a tool already reports into the two things worth
 * showing on one line: the target it acted on, and what came back. Both degrade gracefully — a tool
 * this module has never seen still renders its name and a sensible target rather than nothing.
 */

/** The salient argument for a tool call — the path, command, or query it acted on. */
export function describeToolTarget(toolName: string, argsJson?: string): string | undefined {
  const args = safeParse(argsJson);
  if (!args) return undefined;

  // Ordered by specificity: the first key a tool actually supplies is the one worth showing.
  const preferred = ["path", "file_path", "filePath", "file", "command", "cmd", "pattern", "query", "search", "url", "name", "directory", "dir"];
  for (const key of preferred) {
    const v = args[key];
    if (typeof v === "string" && v.trim().length > 0) return shorten(v.trim());
  }
  const first = Object.values(args).find((v) => typeof v === "string" && v.trim().length > 0);
  return typeof first === "string" ? shorten(first.trim()) : undefined;
}

/**
 * A one-line summary of what a finished tool call produced. Errors win over results: a failure the
 * user cannot see is the one that wastes their time.
 */
export function summarizeToolResult(input: {
  status: "running" | "completed" | "failed" | "blocked";
  result?: string;
  error?: string;
}): string | undefined {
  const { status, result, error } = input;
  if (status === "running") return undefined;
  if (status === "blocked") return error ? firstLine(error) : "blocked";
  if (status === "failed") return error ? firstLine(error) : "failed";
  if (!result) return undefined;

  const trimmed = result.trim();
  if (trimmed.length === 0) return "no output";

  const lines = trimmed.split("\n").length;
  const head = firstLine(trimmed);
  // A single short line is its own best summary; anything longer is reported by size, because a
  // truncated middle of a long output reads as if it were the whole of it.
  if (lines === 1 && head.length <= 80) return head;
  return `${lines} line${lines === 1 ? "" : "s"}`;
}

/** Whether there is more detail worth expanding for this call. */
export function hasToolDetail(input: { result?: string; error?: string }): boolean {
  const body = input.error ?? input.result ?? "";
  return body.trim().split("\n").length > 1 || body.trim().length > 80;
}

/** Elapsed time in the compact form a progress line wants. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function safeParse(json?: string): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(s: string): string {
  return shorten(s.trim().split("\n")[0] ?? "", 120);
}

/**
 * Shorten from the LEFT for long values, keeping the end. Paths and commands carry their meaning at
 * the tail — `.../src/calc.ts` identifies the file, while the repository prefix it shares with every
 * other row does not.
 */
function shorten(value: string, max = 72): string {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - (max - 1))}`;
}
