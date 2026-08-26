import React, { useState } from "react";

export interface Comment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  resolved?: boolean;
}

interface InlineCommentsProps {
  comments: Comment[];
  onAdd: (text: string) => void;
  onResolve?: (id: string) => void;
  placeholder?: string;
}

export default function InlineComments({ comments, onAdd, onResolve, placeholder = "Add a comment..." }: InlineCommentsProps) {
  const [text, setText] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onAdd(text.trim());
    setText("");
  };

  const unresolved = comments.filter((c) => !c.resolved);

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      {unresolved.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {unresolved.map((c) => (
            <div key={c.id} style={{ marginBottom: 8, padding: "6px 10px", background: "var(--bg-secondary)", borderRadius: "var(--radius)", fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                <strong style={{ color: "var(--accent)" }}>{c.author}</strong>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <div style={{ color: "var(--text-secondary)" }}>{c.text}</div>
              {onResolve && (
                <button className="work-item-btn" style={{ marginTop: 4, padding: "2px 8px", fontSize: 11 }} onClick={() => onResolve(c.id)}>Resolve</button>
              )}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "6px 10px",
            color: "var(--text-primary)",
            fontSize: 12,
            outline: "none",
          }}
        />
        <button type="submit" className="work-item-btn primary" disabled={!text.trim()} style={{ padding: "6px 12px" }}>Add</button>
      </form>
    </div>
  );
}
