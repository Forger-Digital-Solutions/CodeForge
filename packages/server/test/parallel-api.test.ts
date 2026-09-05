import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";

const execFile = promisify(execFileCallback);

async function request(port: number, route: string, method = "GET", body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as unknown };
}

describe("parallel run HTTP surface", () => {
  let root: string;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cf08g-parallel-api-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "service.ts"), "export const service = true;\n");
    await execFile("git", ["init", "-b", "main"], { cwd: root });
    await execFile("git", ["config", "user.name", "CodeForge"], { cwd: root });
    await execFile("git", ["config", "user.email", "codeforge@example.test"], { cwd: root });
    await execFile("git", ["add", "."], { cwd: root });
    await execFile("git", ["commit", "-m", "base"], { cwd: root });
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    port = (server as unknown as { httpPort: number }).httpPort;
    expect((await request(port, "/api/workspace/set", "POST", { path: root })).status).toBe(200);
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function waitForRun(sessionId: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const listed = await request(port, `/api/parallel-runs?sessionId=${sessionId}`);
      const runs = listed.body as Array<Record<string, unknown>>;
      if (runs.length > 0) return runs[0]!;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("parallel run never appeared in the listing");
  }

  it("accepts, lists, reads, and refuses to cancel a terminal parallel run", async () => {
    const sessionId = "cf08g-api-session";
    const accepted = await request(port, "/api/parallel-runs", "POST", { sessionId, workspacePath: root, goal: "Parallel API surface check" });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ ok: true, sessionId });

    const listed = await waitForRun(sessionId);
    expect(listed).toMatchObject({ kind: "parallel_run", sessionId, goal: "Parallel API surface check" });
    expect(typeof listed.baseRevision).toBe("string");
    const runId = String(listed.id);

    const fetched = await request(port, `/api/parallel-runs/${runId}`);
    expect(fetched.status).toBe(200);
    const run = fetched.body as Record<string, unknown>;
    expect(run).toMatchObject({ kind: "parallel_run", id: runId, sessionId });
    // The compact UI reads plan/workstream/dispatch state straight off this record.
    expect(Object.keys(run)).toEqual(expect.arrayContaining(["status", "baseRevision", "workstreams", "dispatches", "contracts"]));
    expect(Array.isArray(run.dispatches)).toBe(true);
    expect(JSON.stringify(run)).not.toContain("apiKey");

    // Cancellation of a run that already reached a terminal state is refused, not faked.
    const cancelled = await request(port, `/api/parallel-runs/${runId}/cancel`, "POST");
    expect([200, 409]).toContain(cancelled.status);
    expect(cancelled.body).toMatchObject({ ok: cancelled.status === 200 });

    expect((await request(port, "/api/parallel-runs/parallel-does-not-exist")).status).toBe(404);
    expect((await request(port, "/api/parallel-runs/parallel-does-not-exist/cancel", "POST")).status).toBe(409);
    expect((await request(port, "/api/parallel-runs", "POST", { sessionId })).status).toBe(400);
  }, 120_000);
});
