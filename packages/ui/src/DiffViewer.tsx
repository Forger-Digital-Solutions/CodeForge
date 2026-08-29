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

export function parseDiff(diff: string, fileName?: string): { file: string; lines: DiffLine[] } {
  const rawLines = diff.replace(/\n$/, "").split("\n");
  let file = fileName ?? "unknown";
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const raw of rawLines) {
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
  return { file, lines };
}

export default function DiffViewer({ diff, fileName }: DiffViewerProps) {
  const [showDiff, setShowDiff] = useState(false);
  const { file, lines } = parseDiff(diff, fileName);

  if (!showDiff) {
    return (
      <button className="btn-sm" onClick={() => setShowDiff(true)}>
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
      </div>
    </div>
  );
}
