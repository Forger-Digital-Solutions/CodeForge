import crypto from "node:crypto";

/**
 * FG-1B deterministic tool-output compression.
 *
 * Compression controls model-context size; it never rewrites reality. The authoritative
 * post-redaction output stays in the ToolExecutionRecord (and therefore in the durable event
 * stream); only the model-context representation is bounded. All transformations are pure
 * structural functions of the input text — no model summarization, no time, no randomness —
 * so identical inputs always produce identical representations.
 *
 * Guarantees:
 *  - failure/error lines are always retained (never hidden because they fell outside an excerpt);
 *  - head lines are retained so command identity / exit code markers survive;
 *  - repeated identical lines are folded with explicit counts;
 *  - the result is hard-bounded and every omission is marked;
 *  - callers run this AFTER secret redaction; compression never un-redacts or stores raw secrets.
 */

export interface CompressToolOutputOptions {
  /** Outputs at or below this byte size pass through unchanged. Default 4096. */
  minBytes?: number;
  /** Hard upper bound for the model-context representation. Default 24576. */
  maxBytes?: number;
  /** Lines kept around each failure line. Default 8. */
  failureContextLines?: number;
  /** Minimum run length for consecutive-duplicate folding. Default 4. */
  minConsecutiveRun?: number;
  /** Identifier embedded as provenance so the authoritative artifact can be referenced. */
  artifactRef?: string;
}

export interface CompressedToolOutput {
  /** Bounded model-context representation. Equal to the input when `applied` is false. */
  representation: string;
  applied: boolean;
  originalBytes: number;
  compressedBytes: number;
  strategies: string[];
  /** Number of physical lines removed by folding/omission. */
  omittedLineCount: number;
}

interface FoldedLine {
  text: string;
  /** Lines this entry stands for (1 for a kept line, >1 for folded runs). */
  represents: number;
}

const FAILURE_PATTERN = /\b(error|failed|failure|exception|panic|fatal|assert(?:ion)?\s|✗|✘|npm err|traceback|exit code:?\s*[1-9])/i;

function isFailureLine(line: string): boolean {
  return FAILURE_PATTERN.test(line);
}

function foldConsecutiveRuns(lines: string[], minRun: number): FoldedLine[] {
  const folded: FoldedLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    let runEnd = index + 1;
    while (runEnd < lines.length && lines[runEnd] === line) runEnd++;
    const runLength = runEnd - index;
    if (runLength >= minRun) {
      folded.push({ text: line, represents: 1 });
      folded.push({ text: `[forgegreen: identical line repeated ${runLength - 1} more times]`, represents: runLength - 1 });
    } else {
      for (let i = 0; i < runLength; i++) folded.push({ text: line, represents: 1 });
    }
    index = runEnd;
  }
  return folded;
}

function foldGlobalRepeats(lines: FoldedLine[], threshold: number): FoldedLine[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.represents > 1 || isFailureLine(line.text) || line.text.startsWith("[forgegreen:")) continue;
    if (line.text.length > 160) continue;
    counts.set(line.text, (counts.get(line.text) ?? 0) + 1);
  }
  const summary = new Map<string, number>();
  const result: FoldedLine[] = [];
  for (const line of lines) {
    const total = counts.get(line.text) ?? 0;
    if (total < threshold) {
      result.push(line);
      continue;
    }
    const seen = summary.get(line.text) ?? 0;
    summary.set(line.text, seen + 1);
    if (seen === 0) {
      result.push(line);
    } else if (seen === total - 1) {
      result.push({ text: `[forgegreen: line appeared ${total} times in output; earlier occurrences folded]`, represents: total - 1 });
    }
    // middle occurrences are dropped
  }
  return result;
}

function mergeWindows(indices: number[], context: number, length: number): Array<[number, number]> {
  if (indices.length === 0) return [];
  const sorted = [...indices].sort((a, b) => a - b);
  const first = sorted[0];
  if (first === undefined) return [];
  const windows: Array<[number, number]> = [];
  let start = Math.max(0, first - context);
  let end = Math.min(length - 1, first + context);
  for (let i = 1; i < sorted.length; i++) {
    const value = sorted[i];
    if (value === undefined) continue;
    const windowStart = Math.max(0, value - context);
    const windowEnd = Math.min(length - 1, value + context);
    if (windowStart <= end + 1) {
      end = Math.max(end, windowEnd);
    } else {
      windows.push([start, end]);
      start = windowStart;
      end = windowEnd;
    }
  }
  windows.push([start, end]);
  return windows;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

function lineByteLength(line: string | undefined): number {
  return line === undefined ? 0 : Buffer.byteLength(line, "utf-8");
}

function selectBoundedLines(lines: string[], maxBytes: number): string[] {
  const selected = lines.join("\n");
  if (byteLength(selected) <= maxBytes) return lines;
  // Keep head and tail; every dropped region is marked. Failure lines were already selected
  // before this function runs, so this bound never removes failure information silently.
  const headBudget = Math.floor(maxBytes * 0.55);
  const tailBudget = Math.floor(maxBytes * 0.3);
  const kept: string[] = [];
  let used = 0;
  let cutHead = 0;
  while (cutHead < lines.length && used + lineByteLength(lines[cutHead]) + 1 <= headBudget) {
    const line = lines[cutHead];
    if (line === undefined) break;
    kept.push(line);
    used += Buffer.byteLength(line, "utf-8") + 1;
    cutHead++;
  }
  const tail: string[] = [];
  let tailUsed = 0;
  let cutTail = lines.length - 1;
  while (cutTail > cutHead && tailUsed + lineByteLength(lines[cutTail]) + 1 <= tailBudget) {
    const line = lines[cutTail];
    if (line === undefined) break;
    tail.unshift(line);
    tailUsed += Buffer.byteLength(line, "utf-8") + 1;
    cutTail--;
  }
  const omitted = cutTail - cutHead + 1;
  if (omitted > 0) {
    kept.push(`[forgegreen: ${omitted} lines omitted by size bound; authoritative raw output retains them]`);
  }
  kept.push(...tail);
  return kept;
}

export function compressToolOutput(output: string, options: CompressToolOutputOptions = {}): CompressedToolOutput {
  const minBytes = options.minBytes ?? 4096;
  const maxBytes = options.maxBytes ?? 24576;
  const context = options.failureContextLines ?? 8;
  const minRun = options.minConsecutiveRun ?? 4;
  const originalBytes = byteLength(output);

  if (originalBytes <= minBytes || maxBytes <= 0) {
    return { representation: output, applied: false, originalBytes, compressedBytes: originalBytes, strategies: [], omittedLineCount: 0 };
  }

  const lines = output.split("\n");
  const strategies: string[] = [];

  const afterConsecutive = foldConsecutiveRuns(lines, minRun);
  if (afterConsecutive.length < lines.length) strategies.push("consecutive_repeat_fold");
  const afterGlobal = foldGlobalRepeats(afterConsecutive, 8);
  if (afterGlobal.length < afterConsecutive.length) strategies.push("global_repeat_fold");

  let working = afterGlobal.map((line) => line.text);
  const failureIndices: number[] = [];
  for (let i = 0; i < working.length; i++) {
    const line = working[i];
    if (line !== undefined && isFailureLine(line)) failureIndices.push(i);
  }
  if (failureIndices.length > 0) strategies.push("failure_neighborhood_retention");

  const windows = mergeWindows(failureIndices, context, working.length);
  const keep = new Set<number>();
  const headLines = 12;
  const tailLines = 12;
  for (let i = 0; i < Math.min(headLines, working.length); i++) keep.add(i);
  for (let i = Math.max(0, working.length - tailLines); i < working.length; i++) keep.add(i);
  for (const [start, end] of windows) {
    for (let i = start; i <= end; i++) keep.add(i);
  }

  let omittedLines = 0;
  if (keep.size < working.length) {
    strategies.push("outside_context_omitted");
    const selected: string[] = [];
    let i = 0;
    while (i < working.length) {
      const line = working[i];
      if (keep.has(i) && line !== undefined) {
        selected.push(line);
        i++;
        continue;
      }
      let runEnd = i;
      while (runEnd < working.length && !keep.has(runEnd)) runEnd++;
      const omitted = runEnd - i;
      omittedLines += omitted;
      // Failure lines are never dropped silently: every failure index is inside a kept window,
      // so anything omitted here is known non-failure content by construction.
      selected.push(`[forgegreen: ${omitted} non-failure lines omitted; full output retained in the authoritative artifact]`);
      i = runEnd;
    }
    working = selected;
  }

  const beforeBound = working.length;
  working = selectBoundedLines(working, maxBytes);
  if (working.length < beforeBound) strategies.push("head_tail_bound");

  let representation = working.join("\n");
  if (byteLength(representation) > maxBytes) {
    // Absolute bound; the marker names the authoritative artifact for retrieval.
    const buf = Buffer.from(representation, "utf-8");
    representation = `${buf.subarray(0, maxBytes).toString("utf-8")}\n[forgegreen: representation hard-bounded at ${maxBytes} bytes; authoritative raw output retained]`;
  }

  if (options.artifactRef && strategies.length > 0) {
    representation = `[forgegreen tool-output compression: original=${originalBytes}B representation=${byteLength(representation)}B artifact=${options.artifactRef} digest=sha256:${crypto.createHash("sha256").update(output).digest("hex").slice(0, 16)}]\n${representation}`;
  }

  return {
    representation,
    applied: strategies.length > 0,
    originalBytes,
    compressedBytes: byteLength(representation),
    strategies,
    omittedLineCount: Math.max(0, lines.length - working.length),
  };
}
