import { afterEach, describe, expect, it } from "vitest";
import { createSessionPersistence, type SessionRecord, type TurnRecord, type WorkItem } from "../src/index.js";

describe("SessionPersistence secret boundary", () => {
  const stores: Array<ReturnType<typeof createSessionPersistence>> = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  it("redacts known secrets in sessions, turns, work items, and persisted events", async () => {
    const store = createSessionPersistence({ dbPath: ":memory:" });
    stores.push(store);
    const secretText = "sk-proj-super-secret-value OPENCODE_API_KEY=secret OPENROUTER_API_KEY=secret AWS_SECRET_ACCESS_KEY=secret Bearer abcdefghijklmnop password=supersecret";
    const now = new Date().toISOString();

    await store.upsertSession({
      id: "secret-session",
      title: secretText,
      taskTitle: secretText,
      createdAt: now,
      updatedAt: now,
      status: "running",
    } satisfies SessionRecord);
    await store.upsertTurn({
      id: "secret-turn",
      sessionId: "secret-session",
      seq: 0,
      userMessage: secretText,
      error: secretText,
      status: "failed",
    } satisfies TurnRecord);
    await store.upsertWorkItem({
      kind: "evidence",
      id: "secret-evidence",
      sessionId: "secret-session",
      conclusion: secretText,
      references: [{ kind: "file", ref: secretText }],
      createdAt: now,
    } satisfies WorkItem);
    await store.appendEvent({ sessionId: "secret-session", type: "task.state_changed", payload: { detail: secretText } });

    const persisted = JSON.stringify({
      session: await store.getSession("secret-session"),
      turns: await store.getTurns("secret-session"),
      workItems: await store.getWorkItems("secret-session"),
      events: await store.getEvents("secret-session"),
    });

    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toContain("super-secret-value");
    expect(persisted).not.toContain("OPENCODE_API_KEY=secret");
    expect(persisted).not.toContain("AWS_SECRET_ACCESS_KEY=secret");
    expect(persisted).not.toContain("abcdefghijklmnop");
    expect(persisted).not.toContain("supersecret");
  });
});