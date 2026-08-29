import React, { useState, useRef, useEffect } from "react";
import SlashCommands, { SLASH_COMMANDS } from "./SlashCommands.js";
import { ModelSelector, type ModelSelectorItem, type ModelSection } from "./ModelSelector.js";

/** A prompt is sendable only when it has non-whitespace content. */
export function isComposerSendable(input: string): boolean {
  return input.trim().length > 0;
}

/**
 * Whether an Enter keypress in the composer should submit the prompt.
 * Enter sends; Shift+Enter inserts a newline; Enter is never a submit while an
 * IME composition is active (isComposing, or keyCode 229 for browsers that omit
 * the flag). This is the single source of truth shared by the textarea handler.
 */
export function shouldSubmitOnEnter(e: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  if (e.key !== "Enter") return false;
  if (e.shiftKey) return false;
  if (e.isComposing) return false;
  if (e.keyCode === 229) return false;
  return true;
}

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
  modelSections?: ModelSection[];
}

export default function Composer({
  placeholder,
  onSend,
  onSteer,
  onStop,
  onPause,
  onResume,
  onBackground,
  isRunning,
  isPaused,
  models,
  selectedModelId,
  onSelectModel,
  onShowModelDetails,
  onUpgradeNavigation,
  modelSections,
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
    if (!isComposerSendable(input)) return;
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
    // Enter sends; Shift+Enter inserts a newline; IME composition never submits.
    const native = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
    if (shouldSubmitOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: native?.isComposing, keyCode: native?.keyCode })) {
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
          className={`composer-btn ${isComposerSendable(input) ? "primary" : ""}`}
          onClick={handleSubmit}
          disabled={!isComposerSendable(input)}
          title={isRunning ? "Steer (Enter)" : "Send (Enter)"}
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
              modelSections={modelSections}
            />
          )}
        </div>
        <div className="composer-toolbar-right">
          Enter to send · Shift+Enter for newline · Esc to stop · / for commands
        </div>
      </div>
    </div>
  );
}