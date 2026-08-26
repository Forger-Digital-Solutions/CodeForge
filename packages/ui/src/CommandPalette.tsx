import React, { useState, useEffect, useCallback } from "react";

export interface Command {
  id: string;
  label: string;
  description: string;
  icon: string;
  action: () => void;
  shortcut?: string;
}

interface CommandPaletteProps {
  commands: Command[];
  isOpen: boolean;
  onClose: () => void;
}

export default function CommandPalette({ commands, isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const filtered = query
    ? commands.filter((cmd) => cmd.label.toLowerCase().includes(query.toLowerCase()))
    : commands;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      inputRef.current?.focus();
    }
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          filtered[selectedIndex]!.action();
          onClose();
        }
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [filtered, selectedIndex, onClose]
  );

  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="command-palette-header">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command..."
            autoFocus
          />
          <button className="command-palette-close" onClick={onClose}>×</button>
        </div>
        <div className="command-palette-list">
          {filtered.length === 0 && (
            <div style={{ padding: "12px 16px", color: "var(--text-muted)", fontSize: 12 }}>No commands found</div>
          )}
          {filtered.map((cmd, idx) => (
            <div
              key={cmd.id}
              className={`command-palette-item ${idx === selectedIndex ? "selected" : ""}`}
              onMouseEnter={() => setSelectedIndex(idx)}
              onClick={() => {
                cmd.action();
                onClose();
              }}
            >
              <span className="command-palette-icon">{cmd.icon}</span>
              <div className="command-palette-content">
                <div className="command-palette-label">{cmd.label}</div>
                <div className="command-palette-desc">{cmd.description}</div>
              </div>
              {cmd.shortcut && <span className="command-palette-shortcut">{cmd.shortcut}</span>}
            </div>
          ))}
        </div>
        <div className="command-palette-footer">
          <span>↑↓ to navigate</span>
          <span>↵ to select</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}
