import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WelcomeScreen, { formatLastOpened } from "../src/renderer/WelcomeScreen.js";
import type { Project } from "../src/renderer/App.js";

const noop = () => {};

function renderWelcome(overrides: Partial<Parameters<typeof WelcomeScreen>[0]> = {}): string {
  return renderToStaticMarkup(
    React.createElement(WelcomeScreen, {
      recentProjects: [],
      onOpenProject: noop,
      onCreateProject: noop,
      onRemoveRecent: noop,
      loading: false,
      error: null,
      ...overrides,
    }),
  );
}

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  path: "G:\\CodeForge",
  name: "CodeForge",
  lastOpened: new Date().toISOString(),
  ...over,
});

describe("welcome screen launcher", () => {
  it("first-run state shows identity, headline, and both project actions with no recents section", () => {
    const html = renderWelcome();
    expect(html).toContain("Welcome to CodeForge");
    expect(html).toContain("What are we building today?");
    expect(html).toContain("Open an existing project or create a new workspace to get started.");
    expect(html).toContain("Open project folder");
    expect(html).toContain("Create new project");
    expect(html).not.toContain("Recent projects");
  });

  it("keeps the free-model assurances visible", () => {
    const html = renderWelcome();
    expect(html).toContain("Free AI models included");
    expect(html).toContain("No API key required");
    expect(html).toContain("Changes verified before completion");
  });

  it("returning-user state lists recent projects with a relative timestamp", () => {
    const html = renderWelcome({
      recentProjects: [project({ lastOpened: new Date(Date.now() - 2 * 3600_000).toISOString() })],
    });
    expect(html).toContain("Recent projects");
    expect(html).toContain("CodeForge");
    expect(html).toContain("G:\\CodeForge");
    expect(html).toContain("2 hours ago");
  });

  it("marks a folder that no longer exists and offers a remove control", () => {
    const html = renderWelcome({ recentProjects: [project({ exists: false, name: "Gone" })] });
    expect(html).toContain("welcome-recent-row stale");
    expect(html).toContain("folder not found");
    expect(html).toContain('aria-label="Remove Gone from recent projects"');
    // A stale row does not claim a last-opened time — that would be a lie about reachability.
    expect(html).not.toContain("ago</span>");
  });

  it("caps the rendered list at five entries", () => {
    const recents = Array.from({ length: 8 }, (_, i) => project({ id: `p${i}`, name: `Proj ${i}`, path: `C:\\p${i}` }));
    const html = renderWelcome({ recentProjects: recents });
    expect(html).toContain("Proj 4");
    expect(html).not.toContain("Proj 5");
  });

  it("renders the error surface when project open fails", () => {
    const html = renderWelcome({ error: "Project folder does not exist: C:\\gone" });
    expect(html).toContain("welcome-error");
    expect(html).toContain("Project folder does not exist");
  });
});

describe("formatLastOpened", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  it("formats coarse human deltas", () => {
    expect(formatLastOpened("2026-01-10T11:59:40Z", now)).toBe("Just now");
    expect(formatLastOpened("2026-01-10T11:30:00Z", now)).toBe("30 minutes ago");
    expect(formatLastOpened("2026-01-10T09:00:00Z", now)).toBe("3 hours ago");
    expect(formatLastOpened("2026-01-09T12:00:00Z", now)).toBe("Yesterday");
    expect(formatLastOpened("2026-01-05T12:00:00Z", now)).toBe("5 days ago");
    expect(formatLastOpened("2025-11-01T12:00:00Z", now)).toBe("2 months ago");
    expect(formatLastOpened("2024-01-10T12:00:00Z", now)).toBe("2 years ago");
  });

  it("returns empty for unparseable input rather than guessing", () => {
    expect(formatLastOpened("not-a-date", now)).toBe("");
    expect(formatLastOpened("", now)).toBe("");
  });
});
