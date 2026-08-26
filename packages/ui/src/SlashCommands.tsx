import React, { useState, useEffect, useRef } from "react";

export interface SlashCommand {
  command: string;
  description: string;
  icon: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { command: "/plan", description: "Create a plan for the task", icon: "◫" },
  { command: "/run", description: "Run a shell command", icon: "⌘" },
  { command: "/test", description: "Run the test suite", icon: "◫" },
  { command: "/review", description: "Review pending changes", icon: "✎" },
  { command: "/help", description: "Show available commands", icon: "?" },
];

interface SlashCommandsProps {
  onSelect: (command: string) => void;
  filter?: string;
}

export default function SlashCommands({ onSelect, filter }: SlashCommandsProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = filter
    ? SLASH_COMMANDS.filter((cmd) => cmd.command.startsWith(filter.toLowerCase()))
    : SLASH_COMMANDS;

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      selected?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        onSelect(filtered[selectedIndex]!.command);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onSelect("");
    }
  };

  if (filtered.length === 0) {
    return (
      <div className="slash-commands" onKeyDown={handleKeyDown}>
        <div style={{ padding: "8px 12px", color: "var(--text-muted)", fontSize: 12 }}>No matching commands</div>
      </div>
    );
  }

  return (
    <div className="slash-commands" onKeyDown={handleKeyDown}>
      <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
        Commands
      </div>
      {filtered.map((cmd, idx) => (
        <div
          key={cmd.command}
          className={`slash-command-item ${idx === selectedIndex ? "selected" : ""}`}
          onMouseEnter={() => setSelectedIndex(idx)}
          onClick={() => onSelect(cmd.command)}
        >
          <span className="slash-command-icon">{cmd.icon}</span>
          <span className="slash-command-name">{cmd.command}</span>
          <span className="slash-command-desc">{cmd.description}</span>
        </div>
      ))}
    </div>
  );
}
