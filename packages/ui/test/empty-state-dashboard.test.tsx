import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import Conversation from "../src/Conversation.js";
import { ActivityOverview, type ActivityOverviewData } from "../src/ActivityOverview.js";
import { ContextBar } from "../src/ContextBar.js";
import type { ModelSelectorItem } from "../src/ModelSelector.js";

const EMPTY_PROPS = { turns: [], workItems: [], displayMode: "compact" as const };

describe("Conversation empty-state greeting", () => {
  it("greets the signed-in user by their real display name", () => {
    const markup = renderToStaticMarkup(React.createElement(Conversation, { ...EMPTY_PROPS, userDisplayName: "Ed" }));
    // React-rendered HTML escapes the apostrophe as a numeric entity.
    expect(markup).toContain("What&#x27;s next, Ed?");
  });

  it("falls back to a neutral greeting when no display name is known — never a hardcoded person's name", () => {
    const markup = renderToStaticMarkup(React.createElement(Conversation, EMPTY_PROPS));
    expect(markup).toContain("What are we forging next?");
    expect(markup).not.toContain("What's next,");
  });
});

describe("Conversation workspace brief", () => {
  it("renders only supplied repository facts, including a visible non-color status", () => {
    const markup = renderToStaticMarkup(React.createElement(Conversation, {
      ...EMPTY_PROPS,
      workspaceBrief: {
        repositoryName: "CodeForge",
        branch: "feature/daily-driver",
        repositoryState: "changes",
        indexState: "READY",
        indexedFiles: 27,
        indexedSymbols: 84,
        isWorktree: true,
      },
    }));
    expect(markup).toContain("Selected workspace");
    expect(markup).toContain("Changes detected");
    expect(markup).toContain("feature/daily-driver · worktree");
    expect(markup).toContain("27 files · 84 symbols");
  });
});

describe("Conversation empty-state real favorites", () => {
  const favorites: ModelSelectorItem[] = [
    { id: "nemotron", displayName: "Nemotron 70B", tier: "free" },
    { id: "auto", displayName: "ForgeAuto/Free", tier: "free" },
  ];

  it("renders real favorited models by their actual display names, not a hardcoded placeholder", () => {
    const markup = renderToStaticMarkup(React.createElement(Conversation, { ...EMPTY_PROPS, favoriteModels: favorites, onSelectModel: () => {} }));
    expect(markup).toContain("Nemotron 70B");
    expect(markup).toContain("ForgeAuto/Free");
  });

  it("always offers a working (non-disabled) Add-favorite entry point into the canonical picker", () => {
    const markup = renderToStaticMarkup(React.createElement(Conversation, { ...EMPTY_PROPS, onOpenModelPicker: () => {} }));
    const button = markup.match(/<button[^>]*>\+ Add favorite<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
  });

  it("renders no favorite chips at all when there are none yet, without fabricating any", () => {
    const markup = renderToStaticMarkup(React.createElement(Conversation, EMPTY_PROPS));
    expect(markup).not.toContain("Nemotron");
    expect(markup).toContain("Favorite models");
  });
});

describe("Conversation empty-state activity overview integration", () => {
  const overview: ActivityOverviewData = {
    period: "all",
    tasks: 12,
    messages: 340,
    tokens: 50_000,
    activeDays: 8,
    currentStreak: 2,
    mostUsedModel: { modelId: "nemotron", count: 5, source: "agent-run" },
    heatmap: [],
    hasAnyHistory: true,
  };

  it("renders the overview card only when activity data has actually been fetched (not undefined)", () => {
    const withoutData = renderToStaticMarkup(React.createElement(Conversation, EMPTY_PROPS));
    expect(withoutData).not.toContain("activity-overview");

    const withData = renderToStaticMarkup(React.createElement(Conversation, { ...EMPTY_PROPS, activityOverview: overview }));
    expect(withData).toContain("Overview");
    expect(withData).toContain("340");
  });
});

describe("ActivityOverview", () => {
  const baseOverview: ActivityOverviewData = {
    period: "all",
    tasks: 134,
    messages: 846,
    tokens: 733_000,
    activeDays: 45,
    currentStreak: 2,
    mostUsedModel: { modelId: "openrouter::nemotron", count: 12, source: "agent-run" },
    heatmap: [{ date: "2026-09-11", count: 3, level: 2 }],
    hasAnyHistory: true,
  };

  it("renders real metric values passed in, never hardcoded sample numbers", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ActivityOverview, { overview: baseOverview, period: "all", onPeriodChange: () => {} }),
    );
    expect(markup).toContain("134");
    expect(markup).toContain("846");
    // 733,000 -> "733.0K"/"733K" style compact formatting, never "73.3M" (a different milestone-doc example number)
    expect(markup).not.toContain("73.3M");
  });

  it("resolves the most-used model id to a display name when a resolver is provided", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ActivityOverview, {
        overview: baseOverview,
        period: "all",
        onPeriodChange: () => {},
        resolveModelDisplayName: (id) => (id === "openrouter::nemotron" ? "Nemotron 70B" : id),
      }),
    );
    expect(markup).toContain("Nemotron 70B");
  });

  it("shows a truthful empty state instead of a zeroed grid when there is no history", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ActivityOverview, {
        overview: { ...baseOverview, tasks: 0, messages: 0, tokens: 0, activeDays: 0, currentStreak: 0, mostUsedModel: null, heatmap: [], hasAnyHistory: false },
        period: "all",
        onPeriodChange: () => {},
      }),
    );
    expect(markup).toContain("No completed CodeForge activity yet.");
    expect(markup).not.toContain("activity-heatmap-cell");
  });

  it("renders all three period filter buttons with the active one marked", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ActivityOverview, { overview: baseOverview, period: "7d", onPeriodChange: () => {} }),
    );
    expect(markup).toContain("All");
    expect(markup).toContain("30d");
    expect(markup).toContain("7d");
    expect(markup).toMatch(/activity-period-btn active"[^>]*aria-pressed="true"[^>]*>\s*7d/);
  });

  it("shows a loading state distinct from both the populated and empty states", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ActivityOverview, { overview: null, isLoading: true, period: "all", onPeriodChange: () => {} }),
    );
    expect(markup).toContain("Loading activity");
    expect(markup).not.toContain("No completed CodeForge activity yet.");
  });
});

describe("ContextBar", () => {
  it("shows the real runtime, workspace, and branch chips", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ContextBar, {
        runtimeLabel: "Local",
        workspaceName: "CodeForge",
        workspacePath: "G:\\CodeForge",
        isGitRepo: true,
        branch: "feat/forgegreen",
      }),
    );
    expect(markup).toContain("Local");
    expect(markup).toContain("CodeForge");
    expect(markup).toContain("feat/forgegreen");
    expect(markup).not.toContain("worktree");
  });

  it("never renders a branch chip for a non-git workspace", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ContextBar, { runtimeLabel: "Local", isGitRepo: false, branch: null }),
    );
    expect(markup).not.toContain("detached HEAD");
    expect(markup).not.toContain("context-chip\">null");
  });

  it("renders 'detached HEAD' truthfully instead of a bogus branch name", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ContextBar, { runtimeLabel: "Local", isGitRepo: true, branch: null, isDetached: true }),
    );
    expect(markup).toContain("detached HEAD");
  });

  it("shows the worktree chip only when the workspace actually is a worktree", () => {
    const withWorktree = renderToStaticMarkup(
      React.createElement(ContextBar, { runtimeLabel: "Local", isGitRepo: true, branch: "feature-x", isWorktree: true }),
    );
    expect(withWorktree).toContain("worktree");

    const withoutWorktree = renderToStaticMarkup(
      React.createElement(ContextBar, { runtimeLabel: "Local", isGitRepo: true, branch: "main", isWorktree: false }),
    );
    expect(withoutWorktree).not.toContain("worktree");
  });
});
