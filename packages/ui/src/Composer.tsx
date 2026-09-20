import { MAX_ATTACHMENT_CHARS, MAX_ATTACHMENTS_PER_MESSAGE } from "@codeforge/protocol";
import type { RunPresentation } from "./run-lifecycle.js";
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
  /**
   * Canonical projection of the run. When provided, the "working" indicator, its label and its
   * visibility come from it — a terminal run can never show "Agent working".
   */
  run?: RunPresentation;
  /** True while the run is actively doing work (lifecycle.active); gates the working indicator. */
  working?: boolean;
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
  /** Task authority contract — rendered as the composer-level mode controls. */
  authority?: { permissionMode: string; planMode: string } | null;
  onAuthorityChange?: (modes: { permissionMode?: string; planMode?: string }) => void;
  onComposerActivity?: (active: boolean) => void;
  executionState?: "running" | "user_intent_hold" | "steer_queued" | "reconciling_steer";
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
  onPause: _onPause,
  onResume: _onResume,
  isRunning,
  isPaused,
  run,
  working,
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
  authority,
  onAuthorityChange,
  onComposerActivity,
  executionState = "running",
  searchContext,
}: ComposerProps) {
  const [input, setInput] = useState("");
  const [showCommands, setShowCommands] = useState(false);
  const [showAttachments, setShowAttachments] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextMatches, setContextMatches] = useState<ContextMatch[] | null>(null);
  const contextSearchSeq = useRef(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** Why the last attachment attempt was refused or trimmed — shown beside the chips, never silent. */
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
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
    const notices: string[] = [];
    let accepted = 0;
    for (const file of files) {
      const verdict = classifyAttachmentCandidate(file, attachments.length + accepted);
      if (verdict !== "ok") {
        notices.push(verdict);
        continue;
      }
      let text: string;
      try {
        text = await fileToText(file);
      } catch {
        notices.push(`"${file.name}" could not be read (it may be locked or no longer exist).`);
        continue;
      }
      if (looksBinary(text)) {
        notices.push(`"${file.name}" is not a text file. Only text and code files can be attached.`);
        continue;
      }
      if (text.length > MAX_ATTACHMENT_CHARS) {
        notices.push(`"${file.name}" is large; only the first ${Math.round(MAX_ATTACHMENT_CHARS / 1000)}K characters were attached.`);
        text = text.slice(0, MAX_ATTACHMENT_CHARS);
      }
      if (attachments.some((a) => a.name === file.name && a.size === file.size)) {
        notices.push(`"${file.name}" is already attached.`);
        continue;
      }
      accepted += 1;
      const attachment: Attachment = { id: crypto.randomUUID(), type: "file", name: file.name, size: file.size, content: text };
      setAttachments((prev) => [...prev, attachment]);
    }
    setAttachmentNotice(notices.length > 0 ? notices.join(" ") : null);
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
    const fileItems = items.filter((item) => item.kind === "file" && !item.type.startsWith("image/"));
    if (imageItems.length > 0 && fileItems.length === 0) {
      // The free routes are text models: an image would be dropped on the way to the model. Say so.
      e.preventDefault();
      setAttachmentNotice(IMAGE_UNSUPPORTED_NOTICE);
      return;
    }
    if (fileItems.length > 0) {
      e.preventDefault();
      const files = fileItems.map((item) => item.getAsFile()).filter((f): f is File => Boolean(f));
      await processFiles(files);
    }
  }, [attachments]);

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
      {/* Status strips inform only — Pause/Stop/Resume live canonically in the
          task header so each visible control has exactly one meaning. The working
          indicator follows the canonical lifecycle: terminal or waiting states
          never claim the agent is working. */}
      {isPaused && (
        <div className="composer-status">
          <span className="composer-status-dot paused" />
          <span style={{ fontSize: 11, color: "var(--cf-warning)" }}>Paused</span>
        </div>
      )}
      {!isPaused && isRunning && executionState === "user_intent_hold" && (
        <div className="composer-status" role="status" aria-live="polite">
          <span className="composer-status-dot paused" />
          <span style={{ fontSize: 11, color: "var(--cf-warning)" }}>Waiting for your steer…</span>
        </div>
      )}
      {!isPaused && executionState !== "user_intent_hold" && (working ?? isRunning) && (
        <div className="composer-status">
          <span className="composer-status-dot running" />
          <span style={{ fontSize: 11, color: "var(--cf-success)" }}>{run?.label ?? "Agent working"}</span>
        </div>
      )}
      {!isPaused && !working && run && run.tone === "waiting" && executionState !== "user_intent_hold" && (
        <div className="composer-status" role="status" aria-live="polite">
          <span className="composer-status-dot paused" />
          <span style={{ fontSize: 11, color: "var(--cf-warning)" }}>{run.label}</span>
        </div>
      )}

      {attachmentNotice && (
        <div className="composer-attachment-notice" role="status">
          <span>{attachmentNotice}</span>
          <button type="button" className="attachment-remove" aria-label="Dismiss" onClick={() => setAttachmentNotice(null)}>×</button>
        </div>
      )}
      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="composer-attachments" ref={attachmentsRef} role="list" aria-label="Attachments">
          {attachments.map((att) => (
            <div key={att.id} className="attachment-chip" role="listitem" title={`${att.name} — attached as text; sent with your message`}>
              <span className="attachment-icon" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 2.5h5.5L12.5 5.5V13.5H4V2.5Z" stroke="currentColor" strokeWidth="1.3" /><path d="M9.5 2.5v3h3" stroke="currentColor" strokeWidth="1.3" /></svg>
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
                <span aria-hidden="true">≡</span>
                <span>Repository search is not available in this workspace</span>
              </div>
            ) : contextMatches === null ? (
              <div className="context-picker-item" role="option" aria-disabled="true">
                <span>⌕</span>
                <span>Searching "@{contextQuery}"…</span>
              </div>
            ) : contextMatches.length === 0 ? (
              <div className="context-picker-item" role="option" aria-disabled="true">
                <span aria-hidden="true">≡</span>
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
                  <span>{match.symbol ? "ƒ" : "≡"}</span>
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
                title={showAttachments ? "Hide attachments" : "Attach a text or code file (Ctrl+Shift+A)"}
              >
                +
              </button>
              {showAttachments && (
                <div className="attachment-menu" role="menu">
                  <button type="button" className="attachment-menu-item" role="menuitem" onClick={() => { triggerFileInput(); setShowAttachments(false); }}>
                    Attach a text or code file…
                  </button>
                  <div className="attachment-menu-hint">Up to {MAX_ATTACHMENTS_PER_MESSAGE} files, {Math.round(MAX_ATTACHMENT_CHARS / 1000)}K characters each. Images are not supported by the free models yet.</div>
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
            {onAuthorityChange && (
              <>
                <select
                  className="authority-select"
                  aria-label="Permission mode"
                  title={
                    "Auto Review: routine workspace work runs automatically; boundary crossings ask.\n" +
                    "Ask More Often: also asks before edits and project-modifying commands.\n" +
                    "Full Autonomy: adds installs and unfamiliar scripts — never external or destructive actions."
                  }
                  value={authority?.permissionMode ?? "auto_review"}
                  onChange={(e) => onAuthorityChange({ permissionMode: e.target.value })}
                >
                  <option value="auto_review">Auto Review</option>
                  <option value="ask_more">Ask More</option>
                  <option value="full_autonomy">Full Auto</option>
                </select>
                <select
                  className="authority-select"
                  aria-label="Plan mode"
                  title="Plan: Auto executes the strategy inside task authority. Plan: Review First waits for your decision."
                  value={authority?.planMode ?? "auto"}
                  onChange={(e) => onAuthorityChange({ planMode: e.target.value })}
                >
                  <option value="auto">Plan: Auto</option>
                  <option value="review_first">Plan: Review</option>
                </select>
              </>
            )}
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

function triggerFileInput() {
  const input = document.getElementById("hidden-file-input") as HTMLInputElement;
  if (input) {
    input.accept = "*/*";
    input.webkitdirectory = false;
    input.click();
  }
}

export const IMAGE_UNSUPPORTED_NOTICE = "Image attachments aren't supported by the free models yet — paste the text or describe the image instead.";
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** Refuse, up front, what cannot honestly be attached: images, oversized or too many files. */
export function classifyAttachmentCandidate(file: Pick<File, "name" | "size" | "type">, alreadyAttached: number): "ok" | string {
  if (alreadyAttached >= MAX_ATTACHMENTS_PER_MESSAGE) return `Only ${MAX_ATTACHMENTS_PER_MESSAGE} files can be attached to one message; "${file.name}" was not added.`;
  if (file.type.startsWith("image/")) return IMAGE_UNSUPPORTED_NOTICE;
  if (file.size > MAX_ATTACHMENT_BYTES) return `"${file.name}" is ${formatSize(file.size)}; files over ${formatSize(MAX_ATTACHMENT_BYTES)} can't be attached. Point CodeForge at the file in your project instead.`;
  return "ok";
}

/** Text files contain no NUL bytes and few control characters; anything else is a binary. */
export function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8000);
  if (sample.includes("\u0000")) return true;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++;
  }
  return sample.length > 0 && control / sample.length > 0.02;
}
