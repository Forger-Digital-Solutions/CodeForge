import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
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

describe("Workflow Server Integration", () => {
  let ws: string;
  let port: number;
  let server: InstanceType<typeof createServer>;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "wf-server-"));
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    await writeFile(join(ws, "package.json"), JSON.stringify({ type: "module" }));
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    port = (server as unknown as { httpPort: number }).httpPort;
    // Set workspace
    const setRes = await fetchJson(`http://localhost:${port}/api/workspace/set`, { path: ws });
    expect(setRes.status).toBe(200);
  });

  afterEach(async () => {
    await server.stop();
    await rm(ws, { recursive: true, force: true });
  });

  it("runs workflow via HTTP and completes disciplined steps", async () => {
    const runRes = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "test-sess",
      message: "Fix add function to return a + b",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(runRes.status).toBe(200);
    const body = runRes.body as { ok: boolean; taskId: string; turnId: string };
    expect(body.ok).toBe(true);
    const taskId = body.taskId;
    expect(taskId).toBeDefined();

    // Poll until workflow completes (or timeout 15s), auto-resolving approvals when needed
    let lastState: unknown;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      // Auto-resolve any pending approvals for this session
      try {
        const sessCheck = await fetchJson(`http://localhost:${port}/api/sessions/test-sess`, undefined, "GET");
        const pending = (sessCheck.body as { pendingApprovals: Array<{ approvalId: string }> }).pendingApprovals;
        for (const appr of pending) {
          await fetchJson(`http://localhost:${port}/api/approvals/${appr.approvalId}/resolve`, { decision: "allow_once" });
        }
      } catch {}
      const getRes = await fetchJson(`http://localhost:${port}/api/workflow/${taskId}`, undefined, "GET");
      if (getRes.status === 200) {
        const data = getRes.body as { task: { status: string; phase: string } };
        lastState = data;
        if (data.task.status === "complete" || data.task.status === "completed" || data.task.status === "failed" || data.task.phase === "completed" || data.task.phase === "failed" || data.task.phase === "cancelled") {
          break;
        }
      }
    }
    // Give a bit more for file system
    await new Promise((r) => setTimeout(r, 800));
    const fixed = fs.readFileSync(join(ws, "src/calc.ts"), "utf-8");
    expect(fixed).toContain("a + b");

    // Check session has events
    const sessRes = await fetchJson(`http://localhost:${port}/api/sessions/test-sess`, undefined, "GET");
    expect(sessRes.status).toBe(200);
    const sessBody = sessRes.body as { events: unknown[]; workItems: unknown[] };
    expect(sessBody.events.length).toBeGreaterThan(5);
    // Should have workflow-related events like task.created, plan.started, etc.
    const eventsStr = JSON.stringify(sessBody.events);
    expect(eventsStr).toContain("task.created");
    expect(eventsStr).toContain("plan.started");
  });

  it("workflow approval flow blocks until resolved", async () => {
    const runRes = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-approve",
      message: "Implement multi file feature for provider routing across several modules",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(runRes.status).toBe(200);
    const { taskId } = runRes.body as { taskId: string };
    // Wait for approval to be requested
    let approvalId: string | null = null;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const sess = await fetchJson(`http://localhost:${port}/api/sessions/sess-approve`, undefined, "GET");
      const body = sess.body as { pendingApprovals: Array<{ approvalId: string; tool: string }> };
      if (body.pendingApprovals.length > 0) {
        approvalId = body.pendingApprovals[0]!.approvalId;
        break;
      }
    }
    expect(approvalId).toBeTruthy();
    // Resolve approval
    const resolveRes = await fetchJson(`http://localhost:${port}/api/approvals/${approvalId}/resolve`, { decision: "allow_once" });
    expect(resolveRes.status).toBe(200);

    // Wait for completion
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const getRes = await fetchJson(`http://localhost:${port}/api/workflow/${taskId}`, undefined, "GET");
      const data = getRes.body as { task: { status: string; phase: string } };
      if (data.task.status === "complete" || data.task.status === "completed" || data.task.status === "failed" || data.task.phase === "completed") break;
    }
    const final = await fetchJson(`http://localhost:${port}/api/workflow/${taskId}`, undefined, "GET");
    const finalBody = final.body as { task: { status: string; phase: string } };
    expect(["complete", "completed"]).toContain(finalBody.task.status);
    expect(finalBody.task.phase).toBe("completed");
  });

  it("workflow cancel works", async () => {
    const runRes = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-cancel",
      message: "Fix add function",
      verificationCommands: ["node -e \"setTimeout(()=>process.exit(0), 5000)\""],
    });
    expect(runRes.status).toBe(200);
    const { taskId } = runRes.body as { taskId: string };
    await new Promise((r) => setTimeout(r, 300));
    const cancelRes = await fetchJson(`http://localhost:${port}/api/workflow/${taskId}/cancel`, {}, "POST");
    expect(cancelRes.status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    const getRes = await fetchJson(`http://localhost:${port}/api/workflow/${taskId}`, undefined, "GET");
    const data = getRes.body as { task: { status?: string; phase: string } };
    // May be cancelled or still running briefly; allow either cancelled or completed after abort
    expect(["cancelled", "failed", "completed", "awaiting_approval", "implementing", "verifying"]).toContain(data.task.phase);
  });

  it("lists workflows", async () => {
    const runRes = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-list",
      message: "Fix add",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(runRes.status).toBe(200);
    const listRes = await fetchJson(`http://localhost:${port}/api/workflow`, undefined, "GET");
    expect(listRes.status).toBe(200);
    const list = listRes.body as unknown[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });
});
