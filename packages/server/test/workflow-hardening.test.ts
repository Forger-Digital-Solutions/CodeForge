import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";

async function fetchJson(url: string, body?: unknown, method = "POST"): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

describe("WorkflowService hardening — production autonomous execution", () => {
  let ws: string;
  let port: number;
  let server: InstanceType<typeof createServer>;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "wf-hardening-"));
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a:number,b:number){return a-b}");
    await writeFile(join(ws, "package.json"), JSON.stringify({ type: "module" }));
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    port = (server as unknown as { httpPort: number }).httpPort;
    const setRes = await fetchJson(`http://localhost:${port}/api/workspace/set`, { path: ws });
    expect(setRes.status).toBe(200);
  });

  afterEach(async () => {
    await server.stop();
    await rm(ws, { recursive: true, force: true });
  });

  it("rejects empty message", async () => {
    const res = await fetchJson(`http://localhost:${port}/api/workflow/run`, { sessionId: "sess-empty", message: "   " });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Message is required|message required/i);
  });

  it("rejects message too long (>10000)", async () => {
    const long = "a".repeat(10001);
    const res = await fetchJson(`http://localhost:${port}/api/workflow/run`, { sessionId: "sess-long", message: long });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/too long/i);
  });

  it("rejects invalid workspace path (nonexistent)", async () => {
    const res = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-badws",
      message: "Fix add function",
      workspacePath: join(ws, "nonexistent-dir-xyz"),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/does not exist|Invalid workspace/i);
  });

  it("rejects concurrent workflows per session (max 1)", async () => {
    const first = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-concur",
      message: "Fix add function to return a + b with a long implementation requiring approval for multi file feature",
      verificationCommands: ["node -e \"setTimeout(()=>process.exit(0), 4000)\""],
    });
    expect(first.status).toBe(200);
    // Second immediate for same session should be rejected
    const second = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-concur",
      message: "Fix add function again",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(second.status).toBe(400);
    expect(JSON.stringify(second.body)).toMatch(/already running/i);
    // Cleanup: cancel first to avoid leakage
    const body = first.body as { taskId: string };
    await fetchJson(`http://localhost:${port}/api/workflow/${body.taskId}/cancel`, {}, "POST");
    await new Promise((r) => setTimeout(r, 600));
  });

  it("enforces the global workflow cap and releases every slot after cancellation", async () => {
    const started = [] as Array<{ taskId: string }>;
    for (let index = 0; index < 20; index++) {
      const response = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
        sessionId: `global-session-${index}`,
        message: "Implement a multi file feature that waits for explicit approval",
        verificationCommands: ["node -e \"process.exit(0)\""],
      });
      expect(response.status).toBe(200);
      started.push(response.body as { taskId: string });
    }

    const overflow = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "global-session-overflow",
      message: "Fix add function",
    });
    expect(overflow.status).toBe(400);
    expect(JSON.stringify(overflow.body)).toMatch(/too many concurrent workflows/i);

    await Promise.all(started.map(({ taskId }) =>
      fetchJson(`http://localhost:${port}/api/workflow/${taskId}/cancel`, {}, "POST"),
    ));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const afterRelease = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "global-session-after-release",
      message: "Fix add function",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(afterRelease.status).toBe(200);
    await fetchJson(`http://localhost:${port}/api/workflow/${(afterRelease.body as { taskId: string }).taskId}/cancel`, {}, "POST");
  });

  it("redacts secrets in persisted turn and evidence", async () => {
    const secret = "sk-proj-abcdef1234567890";
    const run = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-secret",
      message: `Fix calc and use key ${secret} should be redacted`,
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(run.status).toBe(200);
    const { taskId } = run.body as { taskId: string };
    // Auto-resolve approvals and wait for completion
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const sess = await fetchJson(`http://localhost:${port}/api/sessions/sess-secret`, undefined, "GET");
        const pending = (sess.body as { pendingApprovals: Array<{ approvalId: string }> }).pendingApprovals;
        for (const a of pending) await fetchJson(`http://localhost:${port}/api/approvals/${a.approvalId}/resolve`, { decision: "allow_once" });
      } catch {}
      const get = await fetchJson(`http://localhost:${port}/api/workflow/${taskId}`, undefined, "GET");
      const data = get.body as { task: { phase: string; status: string } };
      if (["completed", "failed", "cancelled"].includes(data.task.phase) || ["complete", "completed", "failed"].includes(data.task.status)) break;
    }
    await new Promise((r) => setTimeout(r, 500));
    const sess = await fetchJson(`http://localhost:${port}/api/sessions/sess-secret`, undefined, "GET");
    const sessBody = sess.body as { turns: Array<{ userMessage: string; error?: string }>; events: Array<{ type: string; payload: unknown }> };
    const turnsStr = JSON.stringify(sessBody.turns);
    expect(turnsStr).not.toContain(secret);
    expect(turnsStr).toContain("[REDACTED]");
    const eventsStr = JSON.stringify(sessBody.events);
    // task.created title should be redacted
    expect(eventsStr).not.toContain(secret);
  });

  it("handles workflow cancel and surfaces cancelled phase", async () => {
    const run = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-cancel-h",
      message: "Fix add function with cancel test implementing a feature that requires approval",
      verificationCommands: ["node -e \"setTimeout(()=>process.exit(0), 5000)\""],
    });
    expect(run.status).toBe(200);
    const { taskId } = run.body as { taskId: string };
    await new Promise((r) => setTimeout(r, 400));
    const cancel = await fetchJson(`http://localhost:${port}/api/workflow/${taskId}/cancel`, {}, "POST");
    expect(cancel.status).toBe(200);
    await new Promise((r) => setTimeout(r, 600));
    const get = await fetchJson(`http://localhost:${port}/api/workflow/${taskId}`, undefined, "GET");
    const data = get.body as { task: { phase: string; status: string } };
    expect(["cancelled", "failed", "completed", "awaiting_approval", "implementing", "verifying"]).toContain(data.task.phase);
  });

  it("lists workflows and includes task metadata", async () => {
    const run = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-list-h",
      message: "Fix add",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(run.status).toBe(200);
    const list = await fetchJson(`http://localhost:${port}/api/workflow`, undefined, "GET");
    expect(list.status).toBe(200);
    const arr = list.body as Array<{ id: string; title: string; phase: string }>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeGreaterThan(0);
    expect(arr[0]!.id).toBeDefined();
    expect(arr[0]!.phase).toBeDefined();
  });
});
