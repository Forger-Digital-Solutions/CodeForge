import React, { useState } from "react";
import type { WorkItem } from "@codeforge/sessions";

interface QuestionBarProps {
  question: Extract<WorkItem, { kind: "question" }>;
  onAnswer: (answer: string) => void;
}

export default function QuestionBar({ question, onAnswer }: QuestionBarProps) {
  const [input, setInput] = useState("");

  const handleSubmit = () => {
    if (!input.trim()) return;
    onAnswer(input.trim());
    setInput("");
  };

  return (
    <div className="question-bar">
      <div className="question-header">Agent Question</div>
      <div className="question-body">{question.prompt}</div>
      {question.options && question.options.length > 0 && (
        <div className="question-options" style={{ marginBottom: 8 }}>
          {question.options.map((opt) => (
            <button key={opt} className="btn-sm primary" onClick={() => onAnswer(opt)}>
              {opt}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
          placeholder="Type your answer..."
          style={{
            flex: 1,
            padding: "6px 10px",
            background: "var(--cf-bg-input)",
            border: "1px solid var(--cf-border)",
            borderRadius: "var(--cf-radius)",
            color: "var(--cf-text)",
            fontSize: 12,
            fontFamily: "var(--cf-font)",
            outline: "none",
          }}
        />
        <button className="btn-sm primary" onClick={handleSubmit} disabled={!input.trim()}>
          Answer
        </button>
      </div>
    </div>
  );
}
