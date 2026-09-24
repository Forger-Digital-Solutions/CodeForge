import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";

type Server = ReturnType<typeof createServer>;
type ApiResponse = { status: number; body: Record<string, unknown> };

function toolCall(name: string, args: Record<string, unknown>, id: string) {
  const json = JSON.stringify(args);
  return [
    { type: "tool_call_started" as const, toolCallId: id, toolName: name },
    { type: "tool_call_delta" as const, toolCallId: id, delta: json },
    { type: "tool_call_completed" as const, toolCallId: id, toolName: name, arguments: json },
    { type: "finish" as const, finishReason: "tool_calls" },
  ];
}

async function fetchJson(url: string, body?: unknown): Promise<ApiResponse> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("workflow recovery after a post-edit tool loop", () => {
  let workspace: string;
  let server: Server | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "workflow-loop-recovery-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "calc.ts"), "export const sum = (a: number, b: number) => a - b;\n");
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "loop-recovery-test", type: "module" }));
  });

  afterEach(async () => {
    await server?.stop();
    await rm(workspace, { recursive: true, force: true });
  });

  it("continues once after a real edit, then requires verification and the completion gate", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({
      providerId: "codeforge",
      streamEvents: [
        toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
        toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
        toolCall("read_file", { path: "src/calc.ts" }, "read-2"),
        toolCall("read_file", { path: "src/calc.ts" }, "read-3"),
        toolCall("read_file", { path: "src/calc.ts" }, "read-4"),
        [{ type: "text_delta", delta: "The implementation is ready for verification." }, { type: "finish", finishReason: "stop" }],
      ],
    }));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true });
    await server.start();
    const base = `http://localhost:${server.httpPort}`;
    expect((await fetchJson(`${base}/api/workspace/set`, { path: workspace })).status).toBe(200);
    const started = await fetchJson(`${base}/api/workflow/run`, {
      sessionId: "loop-recovery-session",
      message: "Fix sum so it adds two numbers",
      verificationCommands: ["node -e \"const fs=require('fs'); if(fs.readFileSync('src/calc.ts','utf8').includes('a + b')){console.log('1 passed')}else{console.log('1 failed');process.exit(1)}\""],
    });
    expect(started.status).toBe(200);
    const taskId = String(started.body.taskId);

    let status = "";
    for (let i = 0; i < 80; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const session = await fetchJson(`${base}/api/sessions/loop-recovery-session`);
      for (const approval of (session.body.pendingApprovals ?? []) as Array<{ approvalId: string }>) {
        await fetchJson(`${base}/api/approvals/${approval.approvalId}/resolve`, { decision: "allow_once" });
      }
      const workflow = await fetchJson(`${base}/api/workflow/${taskId}`);
      status = String((workflow.body.task as { status: string }).status);
      if (["complete", "completed", "blocked", "failed"].includes(status)) break;
    }

    const session = await fetchJson(`${base}/api/sessions/loop-recovery-session`);
    const events = session.body.events as Array<{ type: string; payload?: { label?: string } }>;
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Implementing the approved plan")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Recovering a stalled implementation")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(1);
    expect(events.some((event) => event.type === "workflow.verification_completed")).toBe(true);
    expect(await readFile(join(workspace, "src", "calc.ts"), "utf8")).toContain("a + b");
    expect(status).toBe("complete");
  });

  it("does not continue a loop that changed no file", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({
      providerId: "codeforge",
      streamEvents: [
        toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
        toolCall("read_file", { path: "src/calc.ts" }, "read-2"),
        toolCall("read_file", { path: "src/calc.ts" }, "read-3"),
        [{ type: "text_delta", delta: "No edit was made." }, { type: "finish", finishReason: "stop" }],
      ],
    }));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true });
    await server.start();
    const base = `http://localhost:${server.httpPort}`;
    expect((await fetchJson(`${base}/api/workspace/set`, { path: workspace })).status).toBe(200);
    const started = await fetchJson(`${base}/api/workflow/run`, {
      sessionId: "no-edit-loop-session",
      message: "Fix sum so it adds two numbers",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(started.status).toBe(200);
    const taskId = String(started.body.taskId);

    let status = "";
    for (let i = 0; i < 80; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const workflow = await fetchJson(`${base}/api/workflow/${taskId}`);
      status = String((workflow.body.task as { status: string }).status);
      if (["complete", "completed", "blocked", "failed"].includes(status)) break;
    }

    const session = await fetchJson(`${base}/api/sessions/no-edit-loop-session`);
    const events = session.body.events as Array<{ type: string; payload?: { label?: string } }>;
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Implementing the approved plan")).toHaveLength(1);
    expect(events.some((event) => event.type === "turn.started" && event.payload?.label === "Recovering a stalled implementation")).toBe(false);
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(1);
    expect(await readFile(join(workspace, "src", "calc.ts"), "utf8")).toBe(before);
    expect(status).toBe("blocked");
  });

  it("stops after one continuation when the model loops again", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({
      providerId: "codeforge",
      streamEvents: [
        toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
        toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
        toolCall("read_file", { path: "src/calc.ts" }, "read-2"),
        toolCall("read_file", { path: "src/calc.ts" }, "read-3"),
        toolCall("read_file", { path: "src/calc.ts" }, "read-4"),
        toolCall("read_file", { path: "src/calc.ts" }, "recovery-read-1"),
        toolCall("read_file", { path: "src/calc.ts" }, "recovery-read-2"),
        toolCall("read_file", { path: "src/calc.ts" }, "recovery-read-3"),
      ],
    }));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true });
    await server.start();
    const base = `http://localhost:${server.httpPort}`;
    expect((await fetchJson(`${base}/api/workspace/set`, { path: workspace })).status).toBe(200);
    const started = await fetchJson(`${base}/api/workflow/run`, {
      sessionId: "repeated-loop-session",
      message: "Fix sum so it adds two numbers",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(started.status).toBe(200);
    const taskId = String(started.body.taskId);

    let status = "";
    for (let i = 0; i < 80; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const workflow = await fetchJson(`${base}/api/workflow/${taskId}`);
      status = String((workflow.body.task as { status: string }).status);
      if (["complete", "completed", "blocked", "failed"].includes(status)) break;
    }

    const session = await fetchJson(`${base}/api/sessions/repeated-loop-session`);
    const events = session.body.events as Array<{ type: string; payload?: { label?: string } }>;
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label)).toHaveLength(3);
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Recovering a stalled implementation")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(1);
    expect(status).toBe("blocked");
  });
});
