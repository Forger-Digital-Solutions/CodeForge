import React, { useState, useRef, useEffect, useCallback } from "react";
import { USER_INTENT_HOLD_QUIET_GRACE_MS, type ExecutionMode } from "@codeforge/protocol";
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

export interface ContextMatch {
  path: string;
  symbol?: string;
  line?: number;
  reason?: string;
}

interface ComposerProps {
  placeholder: string;
  onSend: (message: string, attachments?: Attachment[]) => void;
  onSteer: (message: string, attachments?: Attachment[]) => void;
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
  /** Lets a parent (e.g. the empty state's "+ Add favorite" button) open THIS same canonical
   * picker instead of a second, separate one. Omit both for the picker's normal self-managed
   * open/close behavior — unchanged from before. */
  isModelPickerOpen?: boolean;
  onModelPickerOpenChange?: (isOpen: boolean) => void;
  executionMode?: ExecutionMode;
  onExecutionModeChange?: (mode: ExecutionMode) => void;
  onComposerActivity?: (active: boolean) => void;
  executionState?: "running" | "user_intent_hold" | "steer_queued" | "reconciling_steer";
  /** Repository/runtime context chips shown as the first row inside the composer surface. */
  contextRow?: React.ReactNode;
  /**
   * Resolves an "@" query to repository matches (files and symbols). Wired by the host to
   * Repository Intelligence; absent, the picker says so instead of pretending to search.
   */
  searchContext?: (query: string) => Promise<ContextMatch[]>;
}

export interface Attachment {
  id: string;
  type: "file" | "image" | "folder";
  name: string;
  path?: string;
  content?: string; // base64 for images
  size?: number;
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
  isModelPickerOpen,
  onModelPickerOpenChange,
  executionMode = "agent",
  onExecutionModeChange,
  onComposerActivity,
  executionState = "running",
  contextRow,
  searchContext,
}: ComposerProps) {
  const [input, setInput] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const [showAttachments, setShowAttachments] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextMatches, setContextMatches] = useState<ContextMatch[] | null>(null);
  const contextSearchSeq = useRef(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [contextQuery, setContextQuery] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const holdReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attachmentsRef = useRef<HTMLDivElement>(null);
  const contextPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    if (holdReleaseTimerRef.current) clearTimeout(holdReleaseTimerRef.current);
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  // Handle drag and drop
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      processFiles(files);
    }
  }, []);

  const processFiles = async (files: File[]) => {
    for (const file of files) {
      const attachment: Attachment = {
        id: crypto.randomUUID(),
        type: file.type.startsWith("image/") ? "image" : "file",
        name: file.name,
        size: file.size,
      };

      if (file.type.startsWith("image/")) {
        const base64 = await fileToBase64(file);
        attachment.content = base64;
      } else {
        const text = await fileToText(file);
        attachment.content = text;
      }

      setAttachments((prev) => [...prev, attachment]);
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const fileToText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  };

  // Handle clipboard paste
  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    
    if (imageItems.length > 0) {
      e.preventDefault();
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (file) {
          const base64 = await fileToBase64(file);
          const attachment: Attachment = {
            id: crypto.randomUUID(),
            type: "image",
            name: file.name || "pasted-image.png",
            content: base64,
            size: file.size,
          };
          setAttachments((prev) => [...prev, attachment]);
        }
      }
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const wasEmpty = input.length === 0;
    setInput(value);
    if (holdReleaseTimerRef.current) {
      clearTimeout(holdReleaseTimerRef.current);
      holdReleaseTimerRef.current = null;
    }
    if (isRunning && wasEmpty && value.length > 0) onComposerActivity?.(true);
    if (isRunning && value.length === 0 && input.length > 0) {
      holdReleaseTimerRef.current = setTimeout(() => {
        holdReleaseTimerRef.current = null;
        onComposerActivity?.(false);
      }, USER_INTENT_HOLD_QUIET_GRACE_MS);
    } else if (isRunning && value.length > 0) {
      holdReleaseTimerRef.current = setTimeout(() => {
        holdReleaseTimerRef.current = null;
        onComposerActivity?.(false);
      }, USER_INTENT_HOLD_QUIET_GRACE_MS);
    }
    const parts = value.split(/\s+/);
    const lastWord = parts[parts.length - 1] ?? "";
    setShowCommands(lastWord.startsWith("/") || value.endsWith("/"));
    
    // Handle @ context picker trigger
    const atIndex = value.lastIndexOf("@");
    if (atIndex >= 0 && (atIndex === 0 || value[atIndex - 1] === " ")) {
      const query = value.slice(atIndex + 1);
      if (query.length > 0 || value.endsWith("@")) {
        setContextQuery(query);
        setShowContextPicker(true);
      } else {
        setShowContextPicker(false);
      }
    } else {
      setShowContextPicker(false);
    }
  };

  // Debounced repository search for the "@" picker; a stale response never overwrites a newer one.
  useEffect(() => {
    if (!showContextPicker || contextQuery.length === 0 || !searchContext) {
      setContextMatches(null);
      return;
    }
    const seq = ++contextSearchSeq.current;
    const handle = setTimeout(() => {
      searchContext(contextQuery)
        .then((matches) => { if (contextSearchSeq.current === seq) setContextMatches(matches.slice(0, 8)); })
        .catch(() => { if (contextSearchSeq.current === seq) setContextMatches([]); });
    }, 180);
    return () => clearTimeout(handle);
  }, [showContextPicker, contextQuery, searchContext]);

  const insertContextReference = (match: ContextMatch) => {
    const atIndex = input.lastIndexOf("@");
    const reference = `@${match.path}${match.symbol ? `#${match.symbol}` : ""} `;
    const next = atIndex >= 0 ? `${input.slice(0, atIndex)}${reference}` : `${input}${reference}`;
    setInput(next);
    setShowContextPicker(false);
    setContextMatches(null);
    textareaRef.current?.focus();
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleSubmit = () => {
    if (!isComposerSendable(input) && attachments.length === 0) return;
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
      onSteer(trimmed, attachments);
    } else {
      onSend(trimmed, attachments);
    }
    setInput("");
    setShowCommands(false);
    setAttachments([]);
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
      setShowAttachments(false);
      setShowContextPicker(false);
    }
  };

  const currentFilter = input.split(/\s+/).pop() ?? "";

  return (
    <div className="workspace-composer" style={{ position: "relative" }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isPaused && (
        <div className="composer-status">
          <span className="composer-status-dot paused" />
          <span style={{ fontSize: 11, color: "var(--cf-warning)" }}>Paused</span>
          <button type="button" className="btn-sm" onClick={onResume}>Resume</button>
          <button type="button" className="btn-sm danger" onClick={onStop}>Stop</button>
        </div>
      )}
      {isRunning && !isPaused && executionState === "user_intent_hold" && (
        <div className="composer-status" role="status" aria-live="polite">
          <span className="composer-status-dot paused" />
          <span style={{ fontSize: 11, color: "var(--cf-warning)" }}>Waiting for your steer…</span>
        </div>
      )}
      {isRunning && !isPaused && executionState !== "user_intent_hold" && (
        <div className="composer-status">
          <span className="composer-status-dot running" />
          <span style={{ fontSize: 11, color: "var(--cf-success)" }}>Agent working</span>
          <button type="button" className="btn-sm" onClick={onPause}>Pause</button>
          <button type="button" className="btn-sm danger" onClick={onStop}>Stop</button>
        </div>
      )}

      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="composer-attachments" ref={attachmentsRef} role="list" aria-label="Attachments">
          {attachments.map((att) => (
            <div key={att.id} className="attachment-chip" role="listitem">
              <span className="attachment-icon" aria-hidden="true">
                {att.type === "image" ? "🖼" : att.type === "folder" ? "📁" : "📄"}
              </span>
              <span className="attachment-name" title={att.name}>{att.name}</span>
              {att.size && <span className="attachment-size">{formatSize(att.size)}</span>}
              <button
                type="button"
                className="attachment-remove"
                onClick={() => removeAttachment(att.id)}
                aria-label={`Remove ${att.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Context picker — real Repository Intelligence matches, inserted as @path references */}
      {showContextPicker && contextQuery.length > 0 && (
        <div className="context-picker" ref={contextPickerRef} role="listbox" aria-label="Context references">
          <div className="context-picker-header">@ References</div>
          <div className="context-picker-items">
            {!searchContext ? (
              <div className="context-picker-item" role="option" aria-disabled="true">
                <span>📄</span>
                <span>Repository search is not available in this workspace</span>
              </div>
            ) : contextMatches === null ? (
              <div className="context-picker-item" role="option" aria-disabled="true">
                <span>⌕</span>
                <span>Searching "@{contextQuery}"…</span>
              </div>
            ) : contextMatches.length === 0 ? (
              <div className="context-picker-item" role="option" aria-disabled="true">
                <span>📄</span>
                <span>No matches for "@{contextQuery}"</span>
              </div>
            ) : (
              contextMatches.map((match) => (
                <button
                  type="button"
                  key={`${match.path}#${match.symbol ?? ""}#${match.line ?? ""}`}
                  className="context-picker-item"
                  role="option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertContextReference(match)}
                  title={match.reason ? `${match.path} · ${match.reason}` : match.path}
                >
                  <span>{match.symbol ? "ƒ" : "📄"}</span>
                  <span className="context-picker-path">{match.path}</span>
                  {match.symbol && <span className="context-picker-symbol">{match.symbol}{match.line ? `:${match.line}` : ""}</span>}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/*
        One composer surface: prompt on top, controls along the bottom edge — attachments and
        execution mode on the left, model route and the send/stop action on the right. Keyboard
        help lives under the box so the control row stays readable at narrow widths.
      */}
      <div className={`composer-box ${isRunning ? "steering" : ""}`}>
        {contextRow && <div className="composer-context-row">{contextRow}</div>}
        <textarea
          ref={textareaRef}
          className={`composer-input ${isRunning ? "steering" : ""}`}
          placeholder={placeholder}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          aria-label={isRunning ? "Steer the running task" : "Describe a task"}
        />

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
            <div className="composer-attachment-btns">
              <button
                type="button"
                className="attachment-btn"
                onClick={() => setShowAttachments(!showAttachments)}
                aria-expanded={showAttachments}
                aria-label={showAttachments ? "Hide attachments" : "Add attachment"}
                title={showAttachments ? "Hide attachments" : "Add file, image, or folder (Ctrl+Shift+A)"}
              >
                +
              </button>
              {showAttachments && (
                <div className="attachment-menu" role="menu">
                  <button type="button" className="attachment-menu-item" role="menuitem" onClick={() => triggerFileInput("file")}>
                    <span>📄</span> Add file
                  </button>
                  <button type="button" className="attachment-menu-item" role="menuitem" onClick={() => triggerFileInput("image")}>
                    <span>🖼</span> Add image
                  </button>
                  <button type="button" className="attachment-menu-item" role="menuitem" onClick={() => triggerFileInput("folder")}>
                    <span>📁</span> Add folder
                  </button>
                </div>
              )}
              <input
                type="file"
                id="hidden-file-input"
                multiple
                accept="*/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length > 0) processFiles(files);
                  e.target.value = "";
                }}
              />
            </div>
            <div className="execution-mode-selector" role="group" aria-label="Execution mode">
              <button
                type="button"
                className={`execution-mode-option ${executionMode === "agent" ? "selected" : ""}`}
                aria-pressed={executionMode === "agent"}
                onClick={() => onExecutionModeChange?.("agent")}
                title="Agent runs the full autonomous workflow with approval and verification gates"
              >
                Agent
              </button>
              <button
                type="button"
                className={`execution-mode-option ${executionMode === "chat" ? "selected" : ""}`}
                aria-pressed={executionMode === "chat"}
                onClick={() => onExecutionModeChange?.("chat")}
                title="Chat starts a conversational runtime turn"
              >
                Chat
              </button>
            </div>
          </div>
          <div className="composer-toolbar-right">
            {models && models.length > 0 && (
              <ModelSelector
                models={models}
                selectedId={selectedModelId ?? "auto"}
                onSelect={onSelectModel ?? (() => {})}
                onShowDetails={onShowModelDetails}
                onUpgradeNavigation={onUpgradeNavigation}
                modelSections={modelSections}
                isOpen={isModelPickerOpen}
                onOpenChange={onModelPickerOpenChange}
              />
            )}
            <button
              type="button"
              className={`composer-btn composer-send ${isComposerSendable(input) || attachments.length > 0 ? "primary" : ""}`}
              onClick={handleSubmit}
              disabled={!isComposerSendable(input) && attachments.length === 0}
              title={isRunning ? "Steer (Enter)" : "Send (Enter)"}
              aria-label={isRunning ? "Steer the running task" : "Send"}
            >
              ↑
            </button>
          </div>
        </div>
      </div>
      <div className="composer-hint" aria-hidden="true">
        Enter to send · Shift+Enter for newline · Esc to stop · / for commands · @ for context
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function triggerFileInput(type: "file" | "image" | "folder") {
  const input = document.getElementById("hidden-file-input") as HTMLInputElement;
  if (input) {
    input.accept = type === "image" ? "image/*" : "*/*";
    input.webkitdirectory = type === "folder";
    input.click();
  }
}
