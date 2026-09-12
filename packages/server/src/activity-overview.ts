import type { SessionRecord, TurnRecord, WorkItem } from "@codeforge/sessions";

/**
 * Powers the desktop empty-workspace "Overview" card. Every number here is derived from data
 * CodeForge already persists (sessions/turns/work-items) — no new tracking is introduced, and
 * nothing here uploads anything: this module is pure, synchronous, and given data the caller
 * already fetched.
 *
 * Metric definitions (documented here because they are non-obvious trade-offs, not because the
 * code is unclear):
 *  - `tasks`      = number of sessions whose `updatedAt` falls within `period`. One session is one
 *                   task/conversation.
 *  - `messages`   = total TurnRecord count across those same in-period sessions. A session that
 *                   was last touched inside the window contributes ALL of its turns, not just the
 *                   ones that individually fall inside the window — attributing a whole session to
 *                   the period it was last active in is a deliberate simplification (re-fetching
 *                   per-turn timestamps against three different windows would multiply the I/O for
 *                   a number a desktop dashboard doesn't need to be that precise about).
 *  - `tokens`     = sum of `run_inspection` work items' `usage.totalTokens` for in-period sessions.
 *                   This ONLY covers completed autonomous agent runs — ordinary interactive chat
 *                   turns do not currently have token accounting anywhere in `@codeforge/sessions`.
 *                   The UI must label this honestly (e.g. "tokens · agent runs") rather than
 *                   implying it's a total across every message.
 *  - `activeDays` = distinct calendar dates (derived from each turn's `completedAt ?? startedAt`,
 *                   falling back to the owning session's `updatedAt` when a turn has neither) among
 *                   in-period sessions' turns.
 *  - `currentStreak` / `heatmap` = ALWAYS computed over the user's full lifetime activity,
 *                   independent of `period` — a streak resetting because someone clicked "7d" would
 *                   be confusing, not informative. The heatmap is a fixed trailing window
 *                   (`HEATMAP_DAYS`), regardless of `period`.
 *  - `mostUsedModel` = the mode of `run_inspection.provider.modelId` among in-period sessions (most
 *                   accurate — one entry per completed agent run). If no agent runs exist in the
 *                   period, falls back to the mode of `session.currentModelId` (coarser — the last
 *                   model a session had selected, not a full per-turn history). `source` tells the
 *                   caller which tier produced the answer so the UI can be honest about precision
 *                   if it wants to be.
 */

export type ActivityPeriod = "all" | "30d" | "7d";

export interface ActivityMostUsedModel {
  modelId: string;
  count: number;
  source: "agent-run" | "session-selection";
}

export interface ActivityHeatmapDay {
  date: string;
  count: number;
  /** 0 = no activity, 1..3 = increasing intensity buckets. Purely a rendering hint. */
  level: 0 | 1 | 2 | 3;
}

export interface ActivityOverview {
  period: ActivityPeriod;
  tasks: number;
  messages: number;
  tokens: number;
  activeDays: number;
  currentStreak: number;
  mostUsedModel: ActivityMostUsedModel | null;
  heatmap: ActivityHeatmapDay[];
  /** True if the account has ANY session ever, regardless of `period` — drives the empty-state copy. */
  hasAnyHistory: boolean;
}

const HEATMAP_DAYS = 365;
const PERIOD_DAYS: Record<Exclude<ActivityPeriod, "all">, number> = { "30d": 30, "7d": 7 };

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function turnDateKey(turn: TurnRecord, sessionUpdatedAt: string): string {
  const ts = turn.completedAt ?? turn.startedAt ?? sessionUpdatedAt;
  return dateKey(new Date(ts));
}

function heatmapLevel(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  return 3;
}

function topEntry(counts: Map<string, number>): [string, number] | null {
  let best: [string, number] | null = null;
  for (const entry of counts) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best;
}

/**
 * Pure computation — no I/O. The caller is responsible for fetching `sessions`, each session's
 * turns (`turnsBySessionId`), and every `run_inspection` work item (`workItems`, pre-filtered or
 * not — this function filters by kind itself).
 */
export function buildActivityOverview(
  sessions: SessionRecord[],
  turnsBySessionId: Map<string, TurnRecord[]>,
  workItems: WorkItem[],
  period: ActivityPeriod,
  now: Date = new Date(),
): ActivityOverview {
  const periodStartMs = period === "all" ? null : now.getTime() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000;
  const inPeriod = (iso: string): boolean => periodStartMs === null || new Date(iso).getTime() >= periodStartMs;

  const runInspections = workItems.filter(
    (w): w is Extract<WorkItem, { kind: "run_inspection" }> => w.kind === "run_inspection",
  );

  // Lifetime per-day activity — feeds the heatmap and the streak, independent of `period`.
  const lifetimeDayCounts = new Map<string, number>();
  for (const session of sessions) {
    for (const turn of turnsBySessionId.get(session.id) ?? []) {
      const key = turnDateKey(turn, session.updatedAt);
      lifetimeDayCounts.set(key, (lifetimeDayCounts.get(key) ?? 0) + 1);
    }
  }

  const sessionsInPeriod = sessions.filter((s) => inPeriod(s.updatedAt));
  const sessionIdsInPeriod = new Set(sessionsInPeriod.map((s) => s.id));

  let messages = 0;
  const activeDaysInPeriod = new Set<string>();
  for (const session of sessionsInPeriod) {
    const turns = turnsBySessionId.get(session.id) ?? [];
    messages += turns.length;
    for (const turn of turns) activeDaysInPeriod.add(turnDateKey(turn, session.updatedAt));
  }

  const runsInPeriod = runInspections.filter((r) => sessionIdsInPeriod.has(r.sessionId));
  let tokens = 0;
  const agentRunModelCounts = new Map<string, number>();
  for (const run of runsInPeriod) {
    if (run.usage?.totalTokens) tokens += run.usage.totalTokens;
    if (run.provider?.modelId) {
      agentRunModelCounts.set(run.provider.modelId, (agentRunModelCounts.get(run.provider.modelId) ?? 0) + 1);
    }
  }

  let mostUsedModel: ActivityMostUsedModel | null = null;
  const topAgentRunModel = topEntry(agentRunModelCounts);
  if (topAgentRunModel) {
    mostUsedModel = { modelId: topAgentRunModel[0], count: topAgentRunModel[1], source: "agent-run" };
  } else {
    const sessionModelCounts = new Map<string, number>();
    for (const s of sessionsInPeriod) {
      if (s.currentModelId) sessionModelCounts.set(s.currentModelId, (sessionModelCounts.get(s.currentModelId) ?? 0) + 1);
    }
    const topSessionModel = topEntry(sessionModelCounts);
    if (topSessionModel) mostUsedModel = { modelId: topSessionModel[0], count: topSessionModel[1], source: "session-selection" };
  }

  // Current streak: consecutive active days ending today, or ending yesterday if today has no
  // activity yet (so the streak doesn't visibly drop to 0 the moment the clock rolls past midnight
  // before the user has done anything today).
  let currentStreak = 0;
  const cursor = new Date(now);
  if (!lifetimeDayCounts.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (lifetimeDayCounts.has(dateKey(cursor))) {
    currentStreak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const heatmap: ActivityHeatmapDay[] = [];
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = dateKey(d);
    const count = lifetimeDayCounts.get(key) ?? 0;
    heatmap.push({ date: key, count, level: heatmapLevel(count) });
  }

  return {
    period,
    tasks: sessionsInPeriod.length,
    messages,
    tokens,
    activeDays: activeDaysInPeriod.size,
    currentStreak,
    mostUsedModel,
    heatmap,
    hasAnyHistory: sessions.length > 0,
  };
}
