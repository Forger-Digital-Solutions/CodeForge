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

  it("redacts secret-shaped strings inside R55 work items while keeping credential refs", async () => {
    const store = createSessionPersistence({ dbPath: ":memory:" });
    stores.push(store);
    const now = new Date().toISOString();
    const leaked = "sk-proj-user-source-secret-value";

    // The persisted shape is credential-ref-only; if key material is ever smuggled into the
    // metadata anyway, the write-time redactor must strip it rather than store it verbatim.
    await store.upsertWorkItem({
      kind: "user_intelligence_source",
      id: "user-intelligence-source-secret",
      ownerUserId: "alice",
      source: {
        sourceId: "s1",
        ownerUserId: "alice",
        credentialRef: "user-api-credential:0123456789abcdef01234567",
        modelId: leaked,
      },
      createdAt: now,
      updatedAt: now,
    } satisfies WorkItem);
    await store.upsertWorkItem({
      kind: "forgeauto_roster",
      id: "forgeauto-roster-secret",
      ownerUserId: "alice",
      entitlement: "CUSTOM",
      slots: [{ kind: "AUTO", sourceClass: "USER_API", note: `Bearer ${leaked}` }],
      lead: { mode: "NONE" },
      updatedAt: now,
    } satisfies WorkItem);
    await store.upsertWorkItem({
      kind: "shilling_entry",
      id: "shilling:r55-secret",
      entry: { id: "x", note: `Bearer ${leaked}` },
    } satisfies WorkItem);

    const persisted = JSON.stringify({
      source: await store.getWorkItemsByKind("user_intelligence_source"),
      roster: await store.getWorkItemsByKind("forgeauto_roster"),
      shilling: await store.getWorkItemsByKind("shilling_entry"),
    });
    expect(persisted).not.toContain(leaked);
    expect(persisted).toContain("user-api-credential:0123456789abcdef01234567");
  });
});