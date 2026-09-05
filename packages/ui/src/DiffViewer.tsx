import React, { useState } from "react";

interface DiffLine {
  type: "context" | "addition" | "removal" | "meta";
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface DiffViewerProps {
  diff: string;
  fileName?: string;
}

const MAX_DIFF_CHARS = 512_000;
const MAX_RENDERED_LINES = 2_000;

export function parseDiff(diff: string, fileName?: string): { file: string; lines: DiffLine[]; truncated: boolean } {
  const source = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  const rawLines = source.replace(/\n$/, "").split("\n");
  const truncated = diff.length > MAX_DIFF_CHARS || rawLines.length > MAX_RENDERED_LINES;
  let file = fileName ?? "unknown";
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const raw of rawLines.slice(0, MAX_RENDERED_LINES)) {
    // Skip file/index headers — they carry no reviewable content.
    if (raw.startsWith("+++ ")) {
      const m = raw.match(/^\+\+\+ b\/(.+)$/);
      if (m && !fileName) file = m[1]!;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff ") || raw.startsWith("index ")) {
      continue;
    }

    // Hunk header — anchors the old/new line counters and renders as a separator.
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1]!, 10);
      newLine = parseInt(hunk[2]!, 10);
      lines.push({ type: "meta", text: raw });
      continue;
    }

    if (raw.startsWith("+")) {
      lines.push({ type: "addition", newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith("-")) {
      lines.push({ type: "removal", oldLine, text: raw.slice(1) });
      oldLine++;
    } else {
      lines.push({ type: "context", oldLine, newLine, text: raw.startsWith(" ") ? raw.slice(1) : raw });
      oldLine++;
      newLine++;
    }
  }
  return { file, lines, truncated };
}

export default function DiffViewer({ diff, fileName }: DiffViewerProps) {
  const [showDiff, setShowDiff] = useState(false);
  const { file, lines, truncated } = parseDiff(diff, fileName);

  if (!showDiff) {
    return (
      <button className="btn-sm" onClick={() => setShowDiff(true)} aria-expanded={false}>
        View Diff
      </button>
    );
  }

  return (
    <div className="diff-viewer">
      <div className="diff-header">
        <span>{fileName ?? file}</span>
        <button
          className="btn-sm"
          style={{ padding: "1px 6px", fontSize: 10, marginLeft: "auto" }}
          onClick={() => setShowDiff(false)}
          aria-expanded={true}
        >
          Hide
        </button>
      </div>
      <div className="diff-content">
        {lines.map((line, idx) => (
          <div key={idx} className={`diff-line ${line.type}`}>
            {line.type === "meta" ? (
              <span className="diff-line-text diff-line-meta">{line.text}</span>
            ) : (
              <>
                <span className="diff-line-number">{line.oldLine ?? ""}</span>
                <span className="diff-line-number">{line.newLine ?? ""}</span>
                <span className="diff-line-sign">
                  {line.type === "addition" ? "+" : line.type === "removal" ? "−" : " "}
                </span>
                <span className="diff-line-text">{line.text}</span>
              </>
            )}
          </div>
        ))}
        {truncated ? <div className="diff-truncated">Diff is bounded to the first {MAX_RENDERED_LINES} lines for responsive review.</div> : null}
      </div>
    </div>
  );
}
