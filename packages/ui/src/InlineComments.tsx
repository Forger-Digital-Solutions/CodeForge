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
    <div className="inline-comments">
      {unresolved.length > 0 && (
        <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {unresolved.map((c) => (
            <div key={c.id} className="inline-comment">
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span className="inline-comment-author">{c.author}</span>
                  <span style={{ fontSize: 10, color: "var(--cf-text-muted)" }}>
                    {new Date(c.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                <div className="inline-comment-text">{c.text}</div>
              </div>
              {onResolve && (
                <button
                  className="btn-sm"
                  style={{ padding: "2px 6px", fontSize: 10, alignSelf: "flex-start" }}
                  onClick={() => onResolve(c.id)}
                >
                  Resolve
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={handleSubmit} className="inline-comment-input">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
        />
        <button type="submit" className="btn-sm primary" disabled={!text.trim()}>
          Comment
        </button>
      </form>
    </div>
  );
}
