import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type CodeForgeServer } from "../src/index.js";
import { resolveCloseAction } from "../../../apps/desktop/src/close-lifecycle.js";

/**
 * The desktop's close-safety dialog and tray never compute "is work active" themselves — they ask
 * `CodeForgeServer.getRuntimeStatus()`, the one authoritative source (spec: canonical data sources
 * must not each invent their own notion of "active task"). This test proves that source is
 * actually accurate using the REAL server and REAL persistence — not a mocked React/Electron
 * stand-in — because a good-looking close dialog backed by a status object that doesn't reflect
 * reality would be worse than no dialog at all.
 *
 * This cannot exercise the real Electron Tray/BrowserWindow (that requires a native-ABI-matched
 * SQLite binding this sandbox's toolchain cannot produce — see the certification report). What it
 * DOES prove, with a real server and no mocking of the status computation itself: a genuinely
 * running local command makes `activeWork` true and `recoverable` false (exactly matching
 * `resolveCloseAction`'s "always ask, never silently discard" rule for unrecoverable work), and
 * completing that command makes the server correctly report idle again.
 */
describe("CodeForgeServer.getRuntimeStatus() — the real authority behind close-safety", () => {
  let server: CodeForgeServer;

  beforeEach(async () => {
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("reports idle/recoverable with no active work on a fresh server", async () => {
    const status = await server.getRuntimeStatus();
    expect(status.activeWork).toBe(false);
    expect(status.activeCommands).toBe(0);
    expect(status.recoverable).toBe(true);
    expect(resolveCloseAction(status, "ask")).toBe("quit");
  });

  it("reflects a genuinely running local command as active AND unrecoverable — and resolveCloseAction always asks", async () => {
    const persistence = (server as unknown as { persistence: { upsertSession: (s: unknown) => Promise<void>; upsertWorkItem: (item: unknown) => Promise<void> } }).persistence;
    await persistence.upsertSession({ id: "session-1", title: "Task", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
    await persistence.upsertWorkItem({
      kind: "command",
      id: "cmd-1",
      sessionId: "session-1",
      command: "npm test",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const status = await server.getRuntimeStatus();
    expect(status.activeWork).toBe(true);
    expect(status.activeCommands).toBe(1);
    // A running local child process is exactly the case getRuntimeStatus documents as
    // unrecoverable (it will be killed if the process quits) — so no remembered preference may
    // ever silently quit or minimize past it.
    expect(status.recoverable).toBe(false);
    expect(status.unrecoverableResources.length).toBeGreaterThan(0);
    expect(resolveCloseAction(status, "tray")).toBe("ask");
    expect(resolveCloseAction(status, "quit-safe")).toBe("ask");
  });

  it("returns to idle once the command completes, and normal close preferences apply again", async () => {
    const persistence = (server as unknown as { persistence: { upsertSession: (s: unknown) => Promise<void>; upsertWorkItem: (item: unknown) => Promise<void> } }).persistence;
    await persistence.upsertSession({ id: "session-1", title: "Task", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
    await persistence.upsertWorkItem({
      kind: "command",
      id: "cmd-2",
      sessionId: "session-1",
      command: "npm test",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    expect((await server.getRuntimeStatus()).activeWork).toBe(true);

    await persistence.upsertWorkItem({
      kind: "command",
      id: "cmd-2",
      sessionId: "session-1",
      command: "npm test",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
    });

    const status = await server.getRuntimeStatus();
    expect(status.activeWork).toBe(false);
    expect(status.recoverable).toBe(true);
    expect(resolveCloseAction(status, "ask")).toBe("quit");
  });

  it("reports multiple simultaneously active commands with an accurate count", async () => {
    const persistence = (server as unknown as { persistence: { upsertSession: (s: unknown) => Promise<void>; upsertWorkItem: (item: unknown) => Promise<void> } }).persistence;
    await persistence.upsertSession({ id: "session-1", title: "Task", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running" });
    for (const id of ["cmd-a", "cmd-b"]) {
      await persistence.upsertWorkItem({
        kind: "command",
        id,
        sessionId: "session-1",
        command: "npm run build",
        status: "running",
        startedAt: new Date().toISOString(),
      });
    }
    const status = await server.getRuntimeStatus();
    expect(status.activeCommands).toBe(2);
    expect(status.unrecoverableResources[0]).toContain("2 local commands");
  });
});
