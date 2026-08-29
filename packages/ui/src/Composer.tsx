import React, { useState, useRef, useEffect } from "react";
import SlashCommands, { SLASH_COMMANDS } from "./SlashCommands.js";
import { ModelSelector, type ModelSelectorItem } from "./ModelSelector.js";

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
  models?: ModelSelectorItem[];
  selectedModelId?: string | null;
  onSelectModel?: (model: ModelSelectorItem) => void;
  onShowModelDetails?: (model: ModelSelectorItem) => void;
  onUpgradeNavigation?: (url: string) => void;
}

export default function Composer({
  placeholder,
  onSend,
  onSteer,
  onStop,
  onPause,
  onResume,
  isRunning,
  isPaused,
  models,
  selectedModelId,
  onSelectModel,
  onShowModelDetails,
  onUpgradeNavigation,
}: ComposerProps) {
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
      const commands = input.endsWith("/")
        ? SLASH_COMMANDS
        : SLASH_COMMANDS.filter((c) =>
            c.command.startsWith(`/${input.split(/\s+/).pop() ?? ""}`.toLowerCase()),
          );
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
    <div className="workspace-composer" style={{ position: "relative" }}>
      {isPaused && (
        <div className="composer-status">
          <span className="composer-status-dot paused" />
          <span style={{ fontSize: 11, color: "var(--cf-warning)" }}>Paused</span>
          <button type="button" className="btn-sm" onClick={onResume}>Resume</button>
          <button type="button" className="btn-sm danger" onClick={onStop}>Stop</button>
        </div>
      )}
      {isRunning && !isPaused && (
        <div className="composer-status">
          <span className="composer-status-dot running" />
          <span style={{ fontSize: 11, color: "var(--cf-success)" }}>Agent working</span>
          <button type="button" className="btn-sm" onClick={onPause}>Pause</button>
          <button type="button" className="btn-sm danger" onClick={onStop}>Stop</button>
        </div>
      )}
      <div className="composer-input-row">
        <textarea
          ref={textareaRef}
          className={`composer-input ${isRunning ? "steering" : ""}`}
          placeholder={placeholder}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button
          type="button"
          className={`composer-btn ${input.trim() ? "primary" : ""}`}
          onClick={handleSubmit}
          disabled={!input.trim()}
          title={isRunning ? "Steer (Ctrl+Enter)" : "Send (Ctrl+Enter)"}
          style={{ minWidth: 40, height: 38, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}
        >
          ↑
        </button>
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

      <div className="composer-toolbar">
        <div className="composer-toolbar-left">
          {models && models.length > 0 && (
            <ModelSelector
              models={models}
              selectedId={selectedModelId ?? "auto"}
              onSelect={onSelectModel ?? (() => {})}
              onShowDetails={onShowModelDetails}
              onUpgradeNavigation={onUpgradeNavigation}
            />
          )}
        </div>
        <div className="composer-toolbar-right">
          Ctrl+Enter to send · Esc to stop · / for commands
        </div>
      </div>
    </div>
  );
}
