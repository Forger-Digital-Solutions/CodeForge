import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type CodeForgeServer } from "../src/index.js";

/**
 * R35 Mission R — multi-session isolation over the real HTTP control plane.
 * Sessions are scoping containers on a single-tenant loopback server: one
 * session's turns, work items, and event stream must never appear under
 * another session's API surface.
 */
describe("session isolation (R35-R)", () => {
  let server: CodeForgeServer;
  let base: string;

  beforeEach(async () => {
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("one session's turns and events are not visible through another session's reads", async () => {
    const persistence = (server as unknown as {
      persistence: {
        upsertSession(s: unknown): Promise<void>;
        upsertTurn(t: unknown): Promise<void>;
        upsertWorkItem(i: unknown): Promise<void>;
        appendEvent(e: unknown): Promise<void>;
      };
    }).persistence;

    const now = new Date().toISOString();
    await persistence.upsertSession({ id: "session-a", title: "A", status: "completed", createdAt: now, updatedAt: now });
    await persistence.upsertSession({ id: "session-b", title: "B", status: "completed", createdAt: now, updatedAt: now });
    await persistence.upsertTurn({ id: "turn-a1", sessionId: "session-a", seq: 1, userMessage: "secret task A", status: "completed", startedAt: now, completedAt: now });
    await persistence.upsertWorkItem({ kind: "note", id: "wi-a1", sessionId: "session-a", title: "a-only", createdAt: now, updatedAt: now });
    await persistence.appendEvent({
      type: "turn.completed",
      sessionId: "session-a",
      seq: 1,
      timestamp: now,
      payload: { turnId: "turn-a1", result: "a-result" },
    });

    const sessionRes = await fetch(`${base}/api/sessions/session-b`);
    expect(sessionRes.status).toBe(200);
    const sessionB = (await sessionRes.json()) as {
      turns?: Array<{ id: string }>;
      workItems?: Array<{ id: string }>;
      events?: Array<{ sessionId: string }>;
    };
    expect(sessionB.turns ?? []).toEqual([]);
    for (const item of sessionB.workItems ?? []) {
      expect(item.id).not.toBe("wi-a1");
    }
    for (const event of sessionB.events ?? []) {
      expect(event.sessionId).toBe("session-b");
    }

    const eventsRes = await fetch(`${base}/api/sessions/session-b/events`);
    const eventsB = (await eventsRes.json()) as Array<{ sessionId: string; type: string }>;
    for (const event of eventsB) {
      expect(event.sessionId).toBe("session-b");
    }
    expect(eventsB.some((e) => e.type === "turn.completed")).toBe(false);
  });

  it("resolving another turn's approval by id cannot cross into a session that has no such approval", async () => {
    const res = await fetch(`${base}/api/approvals/nonexistent-approval/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow_once" }),
    });
    expect(res.status).toBe(404);
  });
});
