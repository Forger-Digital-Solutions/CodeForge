import React from "react";

export type ActivityPeriod = "all" | "30d" | "7d";

export interface ActivityHeatmapDay {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3;
}

export interface ActivityOverviewData {
  period: ActivityPeriod;
  tasks: number;
  messages: number;
  tokens: number;
  activeDays: number;
  currentStreak: number;
  mostUsedModel: { modelId: string; count: number; source: "agent-run" | "session-selection" } | null;
  heatmap: ActivityHeatmapDay[];
  hasAnyHistory: boolean;
}

export interface ActivityOverviewProps {
  overview: ActivityOverviewData | null;
  isLoading?: boolean;
  period: ActivityPeriod;
  onPeriodChange: (period: ActivityPeriod) => void;
  /** Resolves a raw model id (e.g. "openrouter::nemotron") to its display name, if known. */
  resolveModelDisplayName?: (modelId: string) => string;
}

const PERIOD_LABELS: Record<ActivityPeriod, string> = { all: "All", "30d": "30d", "7d": "7d" };

function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

/**
 * The desktop empty-state "Overview" card. Every number comes from `overview` — a prop the caller
 * fetched from `GET /api/activity/overview` (see `packages/server/src/activity-overview.ts` for
 * the exact, documented definition of every metric). This component never invents data: with no
 * history it renders a truthful empty state instead of a zeroed-out grid that could be mistaken
 * for "no activity yet today."
 */
export function ActivityOverview({ overview, isLoading, period, onPeriodChange, resolveModelDisplayName }: ActivityOverviewProps): React.ReactElement {
  const modelLabel = overview?.mostUsedModel
    ? (resolveModelDisplayName?.(overview.mostUsedModel.modelId) ?? overview.mostUsedModel.modelId)
    : "—";

  return (
    <div className="activity-overview" role="region" aria-label="Activity overview">
      <div className="activity-overview-header">
        <span className="activity-overview-title">Overview</span>
        <div className="activity-period-filter" role="group" aria-label="Time period">
          {(["all", "30d", "7d"] as ActivityPeriod[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`activity-period-btn ${period === p ? "active" : ""}`}
              aria-pressed={period === p}
              onClick={() => onPeriodChange(p)}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {!overview || isLoading ? (
        <div className="activity-overview-loading" aria-live="polite">Loading activity…</div>
      ) : !overview.hasAnyHistory ? (
        <div className="activity-overview-empty">
          <div className="activity-overview-empty-title">No completed CodeForge activity yet.</div>
          <div className="activity-overview-empty-subtitle">Your work history will appear here as you use CodeForge.</div>
        </div>
      ) : (
        <>
          <div className="activity-metrics-grid">
            <div className="activity-metric">
              <span className="activity-metric-value">{formatCompactNumber(overview.tasks)}</span>
              <span className="activity-metric-label">Tasks</span>
            </div>
            <div className="activity-metric">
              <span className="activity-metric-value">{formatCompactNumber(overview.messages)}</span>
              <span className="activity-metric-label">Messages</span>
            </div>
            <div className="activity-metric" title="Tokens from completed autonomous agent runs — interactive chat turns are not yet token-tracked">
              <span className="activity-metric-value">{formatCompactNumber(overview.tokens)}</span>
              <span className="activity-metric-label">Tokens (agent runs)</span>
            </div>
            <div className="activity-metric">
              <span className="activity-metric-value">{formatCompactNumber(overview.activeDays)}</span>
              <span className="activity-metric-label">Active days</span>
            </div>
            <div className="activity-metric" title="Consecutive days of activity, ending today — always lifetime, independent of the period filter above">
              <span className="activity-metric-value">{overview.currentStreak}d</span>
              <span className="activity-metric-label">Streak</span>
            </div>
            <div
              className="activity-metric"
              title={
                overview.mostUsedModel
                  ? overview.mostUsedModel.source === "agent-run"
                    ? "Most-used model across completed agent runs"
                    : "Most-used model by last selection per session (no agent-run data yet)"
                  : undefined
              }
            >
              <span className="activity-metric-value activity-metric-model">{modelLabel}</span>
              <span className="activity-metric-label">Most-used model</span>
            </div>
          </div>

          <div className="activity-heatmap" role="img" aria-label={`Activity over the last ${overview.heatmap.length} days`}>
            {overview.heatmap.map((day) => (
              <div key={day.date} className={`activity-heatmap-cell level-${day.level}`} title={`${day.date}: ${day.count} message${day.count === 1 ? "" : "s"}`} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default ActivityOverview;
