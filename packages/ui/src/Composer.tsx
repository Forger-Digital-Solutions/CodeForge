import React, { useState, useRef, useEffect } from "react";
import SlashCommands, { SLASH_COMMANDS } from "./SlashCommands.js";

interface ComposerProps {
  placeholder: string;
  onSend: (message: string) => void;
  onSteer: (message: string) => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onBackground: () => void;
  isRunning: boolean;
  isPaused: boolean;
}

export default function Composer({ placeholder, onSend, onSteer, onStop, onPause, onResume, onBackground, isRunning, isPaused }: ComposerProps) {
  const [input, setInput] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    const parts = value.split(/\s+/);
    const lastWord = parts[parts.length - 1] ?? "";
    setShowCommands(lastWord.startsWith("/") || value.endsWith("/"));
  };

  const handleSubmit = () => {
    if (!input.trim()) return;
    const trimmed = input.trim();
    const slashMatch = trimmed.match(/^\/(\w+)(?:\s+(.*))?$/);
    if (slashMatch) {
      const [, command, arg] = slashMatch;
      const cmd = command ?? "";
      handleCommand(cmd, arg ?? "");
      setInput("");
      setShowCommands(false);
      return;
    }
    if (isRunning) {
      onSteer(trimmed);
    } else {
      onSend(trimmed);
    }
    setInput("");
    setShowCommands(false);
  };

  const handleCommand = (command: string, arg: string) => {
    const cmd = SLASH_COMMANDS.find((c) => c.command === `/${command}`);
    if (!cmd) {
      onSend(`/${command} ${arg}`.trim());
      return;
    }
    switch (cmd.command) {
      case "/plan":
        onSend(`Create a plan for: ${arg || "the current task"}`);
        break;
      case "/run":
        onSend(`Run command: ${arg || "(no command specified)"}`);
        break;
      case "/test":
        onSend("Run the test suite and report results");
        break;
      case "/review":
        onSend("Review pending changes");
        break;
      case "/help":
        onSend("Show available commands");
        break;
      default:
        onSend(`/${command} ${arg}`.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommands) {
      const commands = input.endsWith("/") ? SLASH_COMMANDS : SLASH_COMMANDS.filter((c) => c.command.startsWith(`/${input.split(/\s+/).pop() ?? ""}`.toLowerCase()));
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        if (e.key === "Enter" && commands.length > 0) {
          handleCommand(commands[0]!.command.slice(1), "");
          setInput("");
          setShowCommands(false);
        } else if (e.key === "Escape") {
          setShowCommands(false);
        }
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      if (isRunning) onStop();
      setShowCommands(false);
    }
  };

  const currentFilter = input.split(/\s+/).pop() ?? "";

  return (
    <div className="workspace-composer">
      {isPaused && (
        <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--warning)" }}>Paused</span>
          <button className="composer-btn" onClick={onResume}>Resume</button>
          <button className="composer-btn danger" onClick={onStop}>Stop</button>
        </div>
      )}
      {isRunning && !isPaused && (
        <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--success)" }}>Running</span>
          <button className="composer-btn" onClick={onPause}>Pause</button>
          <button className="composer-btn" onClick={onBackground}>Background</button>
          <button className="composer-btn danger" onClick={onStop}>Stop</button>
        </div>
      )}
      <div className="composer-input-row">
        <textarea
          ref={textareaRef}
          className={isRunning ? "steering-input" : "composer-input"}
          placeholder={placeholder}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <div className="composer-actions">
          <button className="composer-btn primary" onClick={handleSubmit} disabled={!input.trim()}>
            {isRunning ? "Steer" : "Send"}
          </button>
        </div>
      </div>
      {showCommands && (
        <SlashCommands
          onSelect={(command) => {
            if (!command) {
              setShowCommands(false);
              return;
            }
            const parts = input.split(/\s+/);
            const lastPart = parts.pop() ?? "";
            if (lastPart.startsWith("/")) {
              const arg = parts.join(" ");
              handleCommand(command.slice(1), arg);
            }
            setInput("");
            setShowCommands(false);
          }}
          filter={currentFilter.startsWith("/") ? currentFilter : undefined}
        />
      )}
      <div style={{ marginTop: 6, fontSize: 10, color: "var(--text-muted)" }}>
        Ctrl+Enter to send · Esc to stop · / for commands
      </div>
    </div>
  );
}
