import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type CodeForgeServer } from "../src/index.js";

describe("CF-17 intent-hold protocol boundary", () => {
  let server: CodeForgeServer;
  let port: number;

  beforeEach(async () => {
    server = createServer({ port: 0, dbPath: ":memory:" });
    const persistence = (server as unknown as { persistence: { upsertSession: (session: unknown) => void } }).persistence;
    const now = new Date().toISOString();
    persistence.upsertSession({ id: "hold-api", title: "hold", createdAt: now, updatedAt: now, status: "running" });
    await server.start();
    port = server.httpPort;
  });

  afterEach(async () => { await server.stop(); });

  it("acknowledges bounded hold transitions and persists no draft payload", async () => {
    const endpoint = `http://localhost:${port}/api/sessions/hold-api/intent-hold`;
    const enteredResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "request", runId: "run-api", turnId: "turn-api" }),
    });
    const entered = await enteredResponse.json() as { active: boolean; generation: number; state: string };
    expect(enteredResponse.status).toBe(200);
    expect(entered).toMatchObject({ active: true, generation: 1, state: "user_intent_hold" });

    const stateResponse = await fetch(`http://localhost:${port}/api/sessions/hold-api`);
    const state = await stateResponse.json() as { workItems: unknown[]; events: unknown[] };
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("PASSWORD=secret");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("ghp_");

    const staleRelease = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release", generation: 99 }),
    });
    expect(staleRelease.status).toBe(409);

    const release = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release", generation: entered.generation }),
    });
    expect(release.status).toBe(200);
  });
});
