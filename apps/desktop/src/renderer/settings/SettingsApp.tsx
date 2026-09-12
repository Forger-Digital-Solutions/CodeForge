import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SettingsContext, type SettingsContextValue } from "./settings-context.js";
import { SETTINGS_SECTIONS, SETTINGS_GROUP_ORDER, getSettingsSection, searchSettings, type SettingsSearchResult } from "./settings-registry.js";

export interface SettingsAppProps {
  context: SettingsContextValue;
  /** Deep-link target: the section shown first. */
  initialSection?: string;
}

/**
 * The CodeForge Settings application: a persistent left navigation with search, grouped real
 * categories, and a content pane — a real application area, not a modal over the workspace.
 */
export default function SettingsApp({ context, initialSection }: SettingsAppProps): React.ReactElement {
  const [currentSection, setCurrentSection] = useState<string>(() =>
    getSettingsSection(initialSection ?? "general") ? initialSection ?? "general" : "general",
  );
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo<SettingsSearchResult[]>(() => searchSettings(query), [query]);

  const navigate = useCallback((sectionId: string) => {
    if (getSettingsSection(sectionId)) setCurrentSection(sectionId);
  }, []);

  // Deep links (account menu → Profile, header buttons, palette) arrive as prop changes after
  // mount — the shell owns the section state, so follow it whenever it changes.
  useEffect(() => {
    if (initialSection && getSettingsSection(initialSection)) setCurrentSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [currentSection]);

  // Keyboard convention: "/" (or Ctrl+F) jumps to settings search; Escape closes results.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "/" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f")) {
        const target = event.target as HTMLElement | null;
        const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
        if (!typing) {
          event.preventDefault();
          searchInputRef.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const section = getSettingsSection(currentSection) ?? SETTINGS_SECTIONS[0]!;
  const SectionComponent = section.component;
  const groups = [...new Set(SETTINGS_SECTIONS.map((s) => s.group))].sort(
    (a, b) => SETTINGS_GROUP_ORDER.indexOf(a) - SETTINGS_GROUP_ORDER.indexOf(b),
  );

  return (
    <SettingsContext.Provider value={context}>
      <div className="app-settings" aria-label="CodeForge Settings">
        <nav className="settings-nav" aria-label="Settings categories">
          <div className="settings-nav-header">
            <button type="button" className="settings-back-btn" onClick={context.closeSettings}>
              ← Back
            </button>
            <span className="settings-nav-title">Settings</span>
          </div>
          <div className="settings-search">
            <input
              ref={searchInputRef}
              className="settings-search-input"
              type="text"
              placeholder="Search settings  ( / )"
              aria-label="Search settings"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  (event.target as HTMLInputElement).blur();
                }
              }}
            />
            {query.trim().length > 0 && (
              <div className="settings-search-results" role="listbox" aria-label="Search results">
                {results.length === 0 ? (
                  <div className="settings-search-empty">No settings match “{query}”.</div>
                ) : (
                  results.map((result) => (
                    <button
                      key={result.id}
                      type="button"
                      role="option"
                      aria-selected={result.id === currentSection}
                      className="settings-search-result"
                      onClick={() => {
                        navigate(result.id);
                        setQuery("");
                      }}
                    >
                      {result.label}
                      <span className="settings-search-result-hint">{result.group}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <div className="settings-nav-scroll">
            {groups.map((group) => (
              <div key={group}>
                <div className="settings-nav-group-label">{group}</div>
                {SETTINGS_SECTIONS.filter((s) => s.group === group).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`settings-nav-item${s.id === currentSection ? " selected" : ""}`}
                    aria-current={s.id === currentSection ? "page" : undefined}
                    onClick={() => navigate(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </nav>
        <div className="settings-content" ref={contentRef} key={section.id}>
          <SectionComponent />
        </div>
      </div>
    </SettingsContext.Provider>
  );
}
