import React, { useState } from "react";
import type { WorkItem } from "@codeforge/sessions";

interface QuestionBarProps {
  question: WorkItem;
  onAnswer: (answer: string) => void;
}

const isQuestion = (w: WorkItem): w is Extract<WorkItem, { kind: "question" }> => w.kind === "question";

export default function QuestionBar({ question, onAnswer }: QuestionBarProps) {
  const [answer, setAnswer] = useState("");

  if (!isQuestion(question)) return null;

  const handleSubmit = () => {
    if (!answer.trim()) return;
    onAnswer(answer);
    setAnswer("");
  };

  return (
    <div style={{
      position: "fixed",
      bottom: 80,
      left: "50%",
      transform: "translateX(-50%)",
      background: "var(--bg-secondary)",
      border: "1px solid var(--accent)",
      borderRadius: "var(--radius-lg)",
      padding: 14,
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      zIndex: 1000,
      minWidth: 400,
      maxWidth: 600,
    }}>
      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--accent)", marginBottom: 8 }}>
        Agent Question
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>{question.prompt}</div>
      {question.options && question.options.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {question.options.map((opt) => (
            <button key={opt} className="work-item-btn primary" onClick={() => onAnswer(opt)}>{opt}</button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={answer}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAnswer(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && handleSubmit()}
          placeholder="Type your answer..."
          style={{
            flex: 1,
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "8px 12px",
            color: "var(--text-primary)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            outline: "none",
          }}
        />
        <button className="composer-btn primary" onClick={handleSubmit} disabled={!answer.trim()}>Send</button>
      </div>
    </div>
  );
}
