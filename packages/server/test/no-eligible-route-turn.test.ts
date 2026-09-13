import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeZero } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime } from "../src/agent-runtime.js";

/**
 * R5 regression: a turn that has no admitted, healthy route must end failed, never "completed".
 * With every route cooled down (a provider-wide capacity mark), the loop had nothing to call and
 * the runtime fell through to "Task completed successfully" — a task that did nothing reported
 * as done. The workflow's completion gate caught it downstream; the turn itself must not lie.
 */
describe("AgentRuntime — no eligible route fails closed", () => {
  let tmpDir: string;
  let persistence: ISessionPersistence;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "no-route-turn-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
  });

  afterEach(async () => {
    await persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("marks the turn failed with an honest reason and emits turn.failed instead of completing", async () => {
    const eventStore = new EventStore();
    const runtime = createAgentRuntime({
      sessionId: "no-route",
      eventStore,
      persistence,
      firewall: new ForgeZero(), // nothing registered → ForgeAuto has no route at all
      providerCatalog: new InMemoryProviderCatalog(),
      workspacePath: tmpDir,
    });
    const turnId = await runtime.startTurn("Fix the bug");
    let state = runtime.getTurn(turnId);
    for (let i = 0; i < 100 && state?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      state = runtime.getTurn(turnId);
    }
    expect(state?.status).toBe("failed");
    expect(state?.error).toMatch(/No eligible free route/);
    // The failure event is emitted after the state flips; give the adapter a beat.
    await new Promise((r) => setTimeout(r, 150));
    const events = eventStore.getAll({ afterSeq: 0 });
    expect(events.some((e) => e.type === "turn.failed")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed")).toBe(false);
    expect(events.some((e) => e.type === "router.selection")).toBe(false);
  });
});
