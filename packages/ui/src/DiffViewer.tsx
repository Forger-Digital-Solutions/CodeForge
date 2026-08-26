import React, { useState } from "react";

interface DiffHunk {
  line: number;
  type: "context" | "addition" | "removal";
  text: string;
}

interface DiffViewerProps {
  diff: string;
  fileName?: string;
}

function parseDiff(diff: string, fileName?: string): { file: string; hunks: DiffHunk[] } {
  const lines = diff.split("\n");
  const fileMatch = lines[0]?.match(/^\+\+\+ b\/(.+)$/);
  const file = fileMatch ? fileMatch[1]! : (fileName ?? "unknown");
  const hunks: DiffHunk[] = [];
  let lineNo = 1;
  for (let i = 1; i < lines.length; i++) {
    const text = lines[i] ?? "";
    if (text.startsWith("+") && !text.startsWith("+++")) {
      hunks.push({ line: lineNo++, type: "addition", text: text.slice(1) });
    } else if (text.startsWith("-") && !text.startsWith("---")) {
      hunks.push({ line: lineNo++, type: "removal", text: text.slice(1) });
    } else {
      hunks.push({ line: lineNo++, type: "context", text: text.slice(1) });
    }
  }
  return { file, hunks };
}

export default function DiffViewer({ diff, fileName }: DiffViewerProps) {
  const [showDiff, setShowDiff] = useState(false);
  const { file, hunks } = parseDiff(diff, fileName);

  if (!showDiff) {
    return (
      <button className="work-item-btn" onClick={() => setShowDiff(true)}>Diff</button>
    );
  }

  return (
    <div style={{ marginTop: 8, border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
      <div style={{ padding: "6px 12px", background: "var(--bg-tertiary)", fontSize: 11, fontFamily: "var(--font-mono)", borderBottom: "1px solid var(--border)" }}>
        {fileName ?? file ?? "unknown"}
      </div>
      <div style={{ maxHeight: 240, overflow: "auto", fontFamily: "var(--font-mono)", fontSize: 12 }}>
        {hunks.map((hunk, idx) => (
          <div key={idx} style={{
            display: "flex",
            background: hunk.type === "addition" ? "rgba(34,197,94,0.08)" : hunk.type === "removal" ? "rgba(239,68,68,0.08)" : "transparent",
            color: hunk.type === "addition" ? "var(--success)" : hunk.type === "removal" ? "var(--danger)" : "var(--text-secondary)",
          }}>
            <span style={{ width: 40, textAlign: "right", paddingRight: 8, color: "var(--text-muted)", userSelect: "none" }}>{hunk.line}</span>
            <span style={{ width: 16, textAlign: "center", color: "var(--text-muted)" }}>{hunk.type === "addition" ? "+" : hunk.type === "removal" ? "-" : " "}</span>
            <span style={{ flex: 1, whiteSpace: "pre" }}>{hunk.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
