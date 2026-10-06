import crypto from "node:crypto";

export interface FileReadRange {
  startLine?: unknown;
  endLine?: unknown;
}

export function renderFileRead(raw: string, range: FileReadRange = {}, maxBytes = 100 * 1024): string {
  const start = range.startLine === undefined ? 1 : range.startLine;
  const requestedEnd = range.endLine;
  if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1
    || (requestedEnd !== undefined && (typeof requestedEnd !== "number" || !Number.isSafeInteger(requestedEnd) || requestedEnd < start))) {
    throw new Error("Invalid line range: use positive integer startLine/endLine with endLine >= startLine");
  }
  const lines = raw.split("\n");
  if (start > lines.length) throw new Error(`Invalid startLine: file has ${lines.length} lines`);
  const end = Math.min(requestedEnd ?? lines.length, lines.length);
  const cappedEnd = Math.min(end, start + 399);
  let content = lines.slice(start - 1, cappedEnd).join("\n");
  const byteTruncated = Buffer.byteLength(content, "utf8") > maxBytes;
  if (byteTruncated) {
    content = new TextDecoder().decode(Buffer.from(content, "utf8").subarray(0, maxBytes), { stream: true });
  }
  const shownEnd = start + content.split("\n").length - 1;
  const truncated = cappedEnd < end || byteTruncated;
  const notice = truncated
    ? `\n[TRUNCATED: showing lines ${start}-${shownEnd}${byteTruncated ? " (last line may be partial)" : ""} of ${lines.length}; limit 400 lines / ${maxBytes} bytes. Use startLine/endLine for another range.]`
    : range.startLine !== undefined || range.endLine !== undefined
      ? `\n[lines:${start}-${shownEnd} of ${lines.length}]`
      : "";
  // The edit guard protects the entire file, including bytes outside the displayed range.
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return `${content}${notice}\n[hash:${hash}]`;
}
