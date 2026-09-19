import type { WorkspaceEvent } from "@codeforge/protocol";
import type { WorkItem } from "@codeforge/sessions";

/**
 * Session-level activity projection for the Inspector.
 *
 * Real agent runs report file edits as `file.written` / `file.change_*` events and shell calls as
 * `command.executed` / `command.started|output|completed`, while demo/apply flows persist
 * `file_change` / `command` work items. Both are authoritative for their producer; merging them
 * here is what lets Changes and Commands describe what actually happened regardless of which
 * runtime path produced it.
 */

export interface SessionFileChange {
  id: string;
  path: string;
  changeType: "created" | "modified" | "deleted";
  additions: number;
  deletions: number;
  diff?: string;
  /** "reverted" changes are excluded entirely — a reverted change is not a change. */
}

export interface SessionCommand {
  id: string;
  command: string;
  workingDirectory?: string;
  status: "running" | "completed" | "failed" | "interrupted";
  exitCode?: number;
  durationMs?: number;
  output?: string;
  seq: number;
}

const normalizePath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/**
 * One row per changed file: the latest lifecycle word wins. `file.change_reverted` removes the
 * path outright; `file.written` fills in files that have no richer proposal record.
 */
export function projectSessionChanges(events: WorkspaceEvent[], workItems: WorkItem[]): SessionFileChange[] {
  const byPath = new Map<string, SessionFileChange>();
  const order: string[] = [];

  const put = (path: string, patch: Partial<SessionFileChange>): void => {
    const key = normalizePath(path);
    const existing = byPath.get(key);
    if (existing) {
      byPath.set(key, { ...existing, ...patch, path: existing.path });
      return;
    }
    byPath.set(key, {
      id: `change-${key}`,
      path,
      changeType: "modified",
      additions: 0,
      deletions: 0,
      ...patch,
    });
    order.push(key);
  };

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    switch (event.type) {
      case "file.change_proposed": {
        const p = event.payload;
        put(p.path, {
          id: `change-${p.changeId}`,
          changeType: p.changeType,
          additions: p.additions,
          deletions: p.deletions,
          ...(p.diff ? { diff: p.diff } : {}),
        });
        break;
      }
      case "file.change_reverted":
        byPath.delete(normalizePath(event.payload.path));
        break;
      case "file.written": {
        const key = normalizePath(event.payload.path);
        if (!byPath.has(key)) put(event.payload.path, { id: `written-${event.payload.fileCallId}` });
        break;
      }
      default:
        break;
    }
  }

  for (const item of workItems) {
    if (item.kind !== "file_change") continue;
    const key = normalizePath(item.path);
    const existing = byPath.get(key);
    // The work item is the durable record (it can carry comments); event rows fill gaps it leaves.
    byPath.set(key, {
      id: existing?.id ?? `wi-${item.id}`,
      path: item.path,
      changeType: item.changeType,
      additions: item.additions || existing?.additions || 0,
      deletions: item.deletions || existing?.deletions || 0,
      ...(item.diff ?? existing?.diff ? { diff: item.diff ?? existing?.diff } : {}),
    });
    if (!existing) order.push(key);
  }

  return order.filter((key) => byPath.has(key)).map((key) => byPath.get(key)!);
}

/**
 * Command history for the session. `command.started`/`completed` join by commandId; a completed
 * event whose id was never seen adopts the oldest still-running row (older producers generated
 * fresh ids per event). `command.executed` is a complete row in one event. When the session's run
 * is already terminal, a command that never reported completion is "interrupted", not running.
 */
export function projectSessionCommands(events: WorkspaceEvent[], workItems: WorkItem[], sessionTerminal = false): SessionCommand[] {
  const byId = new Map<string, SessionCommand>();
  const order: string[] = [];

  const upsert = (id: string, patch: Partial<SessionCommand> & { seq: number }): SessionCommand => {
    const existing = byId.get(id);
    const next: SessionCommand = existing
      ? { ...existing, ...patch }
      : { command: "", status: "running", ...patch, id };
    if (!existing) order.push(id);
    byId.set(id, next);
    return next;
  };

  /** The oldest still-running row — the adoptive parent for a completion with an unmatched id. */
  const oldestRunning = (): SessionCommand | undefined =>
    order.map((id) => byId.get(id)!).find((c) => c.status === "running");

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    switch (event.type) {
      case "command.started": {
        const p = event.payload;
        upsert(p.commandId, {
          command: p.command,
          ...(p.workingDirectory ? { workingDirectory: p.workingDirectory } : {}),
          status: "running",
          seq: event.seq,
        });
        break;
      }
      case "command.output": {
        const p = event.payload;
        const row = byId.get(p.commandId);
        if (row) byId.set(p.commandId, { ...row, output: (row.output ?? "") + p.output });
        break;
      }
      case "command.completed": {
        const p = event.payload;
        const row = byId.get(p.commandId) ?? oldestRunning();
        if (row) {
          byId.set(row.id, {
            ...row,
            status: p.exitCode === 0 ? "completed" : "failed",
            exitCode: p.exitCode,
            durationMs: p.durationMs,
          });
        } else {
          upsert(p.commandId, {
            command: "",
            status: p.exitCode === 0 ? "completed" : "failed",
            exitCode: p.exitCode,
            durationMs: p.durationMs,
            seq: event.seq,
          });
        }
        break;
      }
      case "command.executed": {
        const p = event.payload;
        upsert(p.commandId, {
          command: p.command,
          status: p.exitCode === 0 ? "completed" : "failed",
          exitCode: p.exitCode,
          output: p.output,
          seq: event.seq,
        });
        break;
      }
      default:
        break;
    }
  }

  if (sessionTerminal) {
    for (const [id, row] of byId) {
      if (row.status === "running") byId.set(id, { ...row, status: "interrupted" });
    }
  }

  const rows = order.map((id) => byId.get(id)!);
  for (const item of workItems) {
    if (item.kind !== "command") continue;
    // A work item is only merged onto an event row when it literally is that row (same id);
    // otherwise it is its own record from a producer that does not emit command events.
    if (byId.has(item.id)) continue;
    rows.push({
      id: `wi-${item.id}`,
      command: item.command,
      ...(item.workingDirectory ? { workingDirectory: item.workingDirectory } : {}),
      status: item.status === "running" ? (sessionTerminal ? "interrupted" : "running") : item.status,
      ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      ...(item.output ? { output: item.output } : {}),
      seq: Number.MAX_SAFE_INTEGER,
    });
  }
  return rows;
}

/** Latest verification totals for the session — workflow attempts first, then test_run items. */
export function projectSessionVerification(events: WorkspaceEvent[], workItems: WorkItem[]): { passed: number; failed: number; skipped: number } | null {
  const latest = [...events].reverse().find((event) => event.type === "workflow.verification_completed");
  if (latest?.type === "workflow.verification_completed") {
    const p = latest.payload;
    return { passed: p.passed, failed: p.failed, skipped: p.skipped };
  }
  const tests = workItems.filter((item) => item.kind === "test_run");
  if (tests.length === 0) return null;
  return {
    passed: tests.reduce((sum, t) => sum + (t.kind === "test_run" ? t.passed : 0), 0),
    failed: tests.reduce((sum, t) => sum + (t.kind === "test_run" ? t.failed : 0), 0),
    skipped: 0,
  };
}
