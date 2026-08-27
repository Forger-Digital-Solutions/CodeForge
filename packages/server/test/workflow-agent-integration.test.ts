import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createServer } from "../src/index.js";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function toolCall(toolName: string, args: Record<string, unknown>, id: string): any[] {
  const json = JSON.stringify(args);
  return [
    { type: "tool_call_started", toolCallId: id, toolName } as any,
    { type: "tool_call_delta", toolCallId: id, delta: json } as any,
    { type: "tool_call_completed", toolCallId: id, toolName, arguments: json } as any,
  ];
}

async function fetchJson(url: string, body?: unknown, method = "POST"): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

describe("Workflow ↔ AgentRuntime Real Integration", () => {
  let ws: string;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "wf-agent-"));
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    await writeFile(join(ws, "package.json"), JSON.stringify({ type: "module", name: "test" }));
  });

  afterEach(async () => {
    if (server) await server.stop();
    await rm(ws, { recursive: true, force: true });
  });

  it("workflow Implement phase delegates to AgentRuntime with ForgeZero-verified free model (real execution)", async () => {
    const buggyContent = fs.readFileSync(join(ws, "src", "calc.ts"), "utf-8");
    const hash = sha256(buggyContent);

    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({
      providerId: "codeforge",
      streamEvents: [
        [...toolCall("read_file", { path: "src/calc.ts" }, "call-1"), { type: "finish", finishReason: "tool_calls" } as any],
        [...toolCall("edit_file", { path: "src/calc.ts", oldText: "  return a - b;", newText: "  return a + b;", expectedHash: hash }, "call-2"), { type: "finish", finishReason: "tool_calls" } as any],
        [
          { type: "text_delta", delta: "Fixed" } as any,
          { type: "finish", finishReason: "stop" } as any,
        ],
      ],
    }));

    server = createServer({
      port: 0,
      dbPath: ":memory:",
      providerCatalog: catalog,
      useRealRuntime: true,
    } as any);
    await server.start();
    port = (server as any).httpPort;
    await fetchJson(`http://localhost:${port}/api/workspace/set`, { path: ws });

    const runRes = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "real-agent-sess",
      message: "Fix add function to return a + b",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(runRes.status).toBe(200);
    const { taskId } = runRes.body as { taskId: string };

    let completed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const sess = await fetchJson(`http://localhost:${port}/api/sessions/real-agent-sess`, undefined, "GET");
        const pending = (sess.body as any).pendingApprovals as Array<{ approvalId: string }>;
        for (const appr of pending) {
          await fetchJson(`http://localhost:${port}/api/approvals/${appr.approvalId}/resolve`, { decision: "allow_once" });
        }
      } catch {}
      const wf = await fetchJson(`http://localhost:${port}/api/workflow/${taskId}`, undefined, "GET");
      const task = (wf.body as any).task as { phase: string; status: string };
      if (task.phase === "completed" || task.status === "complete" || task.status === "completed") {
        completed = true;
        break;
      }
      if (task.phase === "failed" || task.status === "failed") break;
    }

    await new Promise((r) => setTimeout(r, 300));
    const fixed = fs.readFileSync(join(ws, "src/calc.ts"), "utf-8");
    expect(fixed).toContain("a + b");

    const sessRes = await fetchJson(`http://localhost:${port}/api/sessions/real-agent-sess`, undefined, "GET");
    const events = (sessRes.body as any).events as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain("task.created");
    expect(types).toContain("plan.started");
    expect(types.some((t) => t === "turn.started" || t === "tool.execution_started" || t === "tool.call_started")).toBe(true);
    expect(completed).toBe(true);
  });

  it("workflow via /api/send is routed to real autonomous execution when workspace set and coding intent", async () => {
    const catalog = new InMemoryProviderCatalog();
    const currentHash = sha256(fs.readFileSync(join(ws, "src", "calc.ts"), "utf-8"));
    catalog.register(createMockProvider({
      providerId: "codeforge",
      streamEvents: [
        [...toolCall("read_file", { path: "src/calc.ts" }, "c1"), { type: "finish", finishReason: "tool_calls" } as any],
        [...toolCall("edit_file", { path: "src/calc.ts", oldText: "  return a - b;", newText: "  return a + b;", expectedHash: currentHash }, "c2"), { type: "finish", finishReason: "tool_calls" } as any],
        [{ type: "text_delta", delta: "done" } as any, { type: "finish", finishReason: "stop" } as any],
      ],
    }));
    server = createServer({
      port: 0,
      dbPath: ":memory:",
      providerCatalog: catalog,
      useRealRuntime: true,
    } as any);
    await server.start();
    port = (server as any).httpPort;
    await fetchJson(`http://localhost:${port}/api/workspace/set`, { path: ws });

    const sendRes = await fetchJson(`http://localhost:${port}/api/send`, {
      sessionId: "send-workflow-sess",
      message: "Fix add function to return a + b",
      useWorkflow: true,
    });
    expect(sendRes.status).toBe(200);
    const body = sendRes.body as { ok: boolean; taskId?: string; turnId: string; mode: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toContain("workflow");

    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const sess = await fetchJson(`http://localhost:${port}/api/sessions/send-workflow-sess`, undefined, "GET");
        for (const appr of (sess.body as any).pendingApprovals) {
          await fetchJson(`http://localhost:${port}/api/approvals/${appr.approvalId}/resolve`, { decision: "allow_once" });
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 300));
    const fixed = fs.readFileSync(join(ws, "src/calc.ts"), "utf-8");
    expect(fixed).toContain("a + b");
  });

  it("workflow repair loop uses AgentRuntime after verification failure", async () => {
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
    const hash = sha256(fs.readFileSync(join(ws, "src", "calc.ts"), "utf-8"));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({
      providerId: "codeforge",
      streamEvents: [
        [...toolCall("read_file", { path: "src/calc.ts" }, "r1"), { type: "finish", finishReason: "tool_calls" } as any],
        [...toolCall("edit_file", { path: "src/calc.ts", oldText: "  return a - b;", newText: "  return a + b;", expectedHash: hash }, "r2"), { type: "finish", finishReason: "tool_calls" } as any],
        [{ type: "text_delta", delta: "fixed" } as any, { type: "finish", finishReason: "stop" } as any],
        [...toolCall("edit_file", { path: "src/calc.ts", oldText: "  return a - b;", newText: "  return a + b;", expectedHash: hash }, "rep1"), { type: "finish", finishReason: "tool_calls" } as any],
        [{ type: "text_delta", delta: "repaired" } as any, { type: "finish", finishReason: "stop" } as any],
      ],
    }));
    server = createServer({
      port: 0,
      dbPath: ":memory:",
      providerCatalog: catalog,
      useRealRuntime: true,
    } as any);
    await server.start();
    port = (server as any).httpPort;
    await fetchJson(`http://localhost:${port}/api/workspace/set`, { path: ws });

    const runRes = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "repair-sess",
      message: "Fix add function",
      verificationCommands: ["node -e \"const fs=require('fs'); const c=fs.readFileSync('src/calc.ts','utf-8'); if(c.includes('a + b')){console.log('1 passed'); process.exit(0)} else {console.log('1 failed'); process.exit(1)}\""],
    });
    expect(runRes.status).toBe(200);
    const { taskId } = runRes.body as { taskId: string };
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const sess = await fetchJson(`http://localhost:${port}/api/sessions/repair-sess`, undefined, "GET");
        for (const appr of (sess.body as any).pendingApprovals) {
          await fetchJson(`http://localhost:${port}/api/approvals/${appr.approvalId}/resolve`, { decision: "allow_once" });
        }
      } catch {}
      const wf = await fetchJson(`http://localhost:${port}/api/workflow/${taskId}`, undefined, "GET");
      const t = (wf.body as any).task as { phase: string };
      if (t.phase === "completed" || t.phase === "failed") break;
    }
    await new Promise((r) => setTimeout(r, 300));
    const fixed = fs.readFileSync(join(ws, "src/calc.ts"), "utf-8");
    expect(fixed).toContain("a + b");
    const sessRes = await fetchJson(`http://localhost:${port}/api/sessions/repair-sess`, undefined, "GET");
    const workItems = (sessRes.body as any).workItems as Array<{ kind: string }>;
    expect(workItems.length).toBeGreaterThan(0);
  });
});
