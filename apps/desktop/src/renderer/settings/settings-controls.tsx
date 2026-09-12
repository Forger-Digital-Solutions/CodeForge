import React, { useEffect, useId, useRef, useState } from "react";

/**
 * CodeForge-native Settings controls. One visual system: every dropdown is the keyboard-accessible
 * `CfSelect` (browser-native selects are OS-rendered and cannot be themed — they are banned here),
 * every boolean is the accessible `Toggle` switch, and status is always a truthful `StatusBadge`.
 */

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <span className="cf-toggle">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="cf-toggle-track" aria-hidden="true">
        <span className="cf-toggle-thumb" />
      </span>
    </span>
  );
}

export interface CfSelectOption {
  value: string;
  label: string;
}

/**
 * Desktop dropdown with a real listbox: typeahead-free, arrow-key navigable, Enter/Space selects,
 * Escape closes. Replaces the bright native `<select>` controls the old settings screen relied on.
 */
export function CfSelect({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: string;
  options: CfSelectOption[];
  onChange: (next: string) => void;
  label: string;
  disabled?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  useEffect(() => {
    if (open && listRef.current) listRef.current.focus();
  }, [open]);

  const commit = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusedIndex((current) => (current + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusedIndex((current) => (current - 1 + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (focusedIndex >= 0) commit(focusedIndex);
      else commit(options.findIndex((o) => o.value === value));
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="cf-select" ref={rootRef}>
      <button
        type="button"
        className="cf-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          setFocusedIndex(options.findIndex((o) => o.value === value));
          setOpen((current) => !current);
        }}
      >
        <span>{selected?.label ?? value}</span>
        <span className="cf-select-caret" aria-hidden="true">▼</span>
      </button>
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="cf-select-menu"
          ref={listRef}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`cf-select-option${option.value === value ? " selected" : ""}${index === focusedIndex ? " focused" : ""}`}
              onMouseEnter={() => setFocusedIndex(index)}
              onClick={() => commit(index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  label: string;
}): React.ReactElement {
  return (
    <div className="cf-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`cf-segmented-option${option.value === value ? " selected" : ""}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsGroup({ title, children, danger }: { title?: string; children: React.ReactNode; danger?: boolean }): React.ReactElement {
  return (
    <section className={`settings-group${danger ? " danger-zone" : ""}`}>
      {title ? <div className="settings-group-title">{title}</div> : null}
      {children}
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  control,
  status,
}: {
  title: string;
  description?: string;
  control?: React.ReactNode;
  status?: "ok" | "warn" | "error" | "info";
}): React.ReactElement {
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-row-title">{title}</div>
        {description ? <div className="settings-row-description">{description}</div> : null}
      </div>
      <div className="settings-row-control">
        {status ? <StatusBadge kind={status} /> : control}
      </div>
    </div>
  );
}

export function StatusBadge({ kind, children }: { kind: "ok" | "warn" | "error" | "info"; children?: React.ReactNode }): React.ReactElement {
  const labels = { ok: "Active", warn: "Needs attention", error: "Unavailable", info: "Info" } as const;
  return (
    <span className={`status-badge ${kind}`}>
      {kind === "ok" ? "✓ " : kind === "warn" ? "⚠ " : kind === "error" ? "✗ " : ""}
      {children ?? labels[kind]}
    </span>
  );
}

/** GitHub avatar with a deterministic initials fallback — a broken/absent image never breaks the UI. */
export function Avatar({
  url,
  name,
  size,
}: {
  url?: string;
  name: string;
  size?: "sm";
}): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const cls = size === "sm" ? "account-avatar-sm" : "account-avatar";
  const fallbackCls = size === "sm" ? "account-avatar-fallback-sm" : "account-avatar-fallback";
  if (!url || failed) {
    const initials = (name.trim()[0] ?? "C").toUpperCase();
    return (
      <span className={fallbackCls} aria-hidden="true">{initials}</span>
    );
  }
  return (
    <img
      className={cls}
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export function SettingsButton({
  children,
  onClick,
  variant,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "primary" | "danger";
  disabled?: boolean;
  title?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`settings-btn${variant ? ` ${variant}` : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
