import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceEvent } from "@codeforge/protocol";
import { createServer } from "../src/index.js";

interface SseClient {
  events: WorkspaceEvent[];
  close: () => void;
  waitFor: (predicate: (event: WorkspaceEvent) => boolean, timeoutMs?: number) => Promise<WorkspaceEvent>;
}

async function connectSse(port: number, lastSeq = 0): Promise<SseClient> {
  const events: WorkspaceEvent[] = [];
  const waiters = new Set<{
    predicate: (event: WorkspaceEvent) => boolean;
    resolve: (event: WorkspaceEvent) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let buffer = "";
  let response: http.IncomingMessage | null = null;
  let closed = false;

  const request = http.get(`http://localhost:${port}/api/events${lastSeq > 0 ? `?lastSeq=${lastSeq}` : ""}`);
  await new Promise<void>((resolve, reject) => {
    request.once("response", (incoming) => {
      response = incoming;
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (!data) continue;
          const parsed = JSON.parse(data) as Partial<WorkspaceEvent>;
          if (!Number.isSafeInteger(parsed.seq)) continue;
          const event = parsed as WorkspaceEvent;
          events.push(event);
          for (const waiter of [...waiters]) {
            if (!waiter.predicate(event)) continue;
            clearTimeout(waiter.timer);
            waiters.delete(waiter);
            waiter.resolve(event);
          }
        }
      });
      resolve();
    });
    request.once("error", reject);
  });

  return {
    events,
    close: () => {
      if (closed) return;
      closed = true;
      response?.destroy();
      request.destroy();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("SSE client closed"));
      }
      waiters.clear();
    },
    waitFor: (predicate, timeoutMs = 5_000) => {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error("Timed out waiting for SSE event"));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

async function jsonRequest(port: number, pathname: string, body?: unknown, method = "POST"): Promise<any> {
  const response = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}

async function waitForTerminal(port: number, taskId: string): Promise<{ phase: string; status: string }> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const body = await jsonRequest(port, `/api/workflow/${taskId}`, undefined, "GET");
    const task = body.task as { phase: string; status: string };
    if (["completed", "failed", "cancelled"].includes(task.phase)) return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Workflow did not reach a terminal state");
}

describe("SSE reconnect and renderer reconstruction E2E", () => {
  let workspace: string;
  let server: ReturnType<typeof createServer>;
  let port: number;
  const clients: SseClient[] = [];

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "codeforge-sse-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "calc.ts"), "export const add = (a: number, b: number) => a - b;\n");
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "sse-e2e", type: "module" }));
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    port = server.httpPort;
    await jsonRequest(port, "/api/workspace/set", { path: workspace });
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    await server.stop();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("replays missed active and terminal events without duplicate effects", async () => {
    const first = await connectSse(port);
    clients.push(first);
    const run = await jsonRequest(port, "/api/workflow/run", {
      sessionId: "reconnect-session",
      message: "Fix add function to return a + b",
      verificationCommands: ["node -e \"setTimeout(()=>process.exit(0),250)\""],
    });
    const taskId = run.taskId as string;
    const approvalEvent = await first.waitFor((event) => event.type === "approval.requested");
    const lastSeq = approvalEvent.seq;
    first.close();

    const snapshot = await jsonRequest(port, "/api/sessions/reconnect-session", undefined, "GET");
    expect(snapshot.pendingApprovals).toHaveLength(1);
    await jsonRequest(port, `/api/approvals/${snapshot.pendingApprovals[0].approvalId}/resolve`, { decision: "allow_once" });
    expect(await waitForTerminal(port, taskId)).toMatchObject({ phase: "completed" });

    const reconnect = await connectSse(port, lastSeq);
    clients.push(reconnect);
    await reconnect.waitFor((event) => event.type === "task.completed");
    expect(reconnect.events.every((event) => event.seq > lastSeq)).toBe(true);
    expect(new Set(reconnect.events.map((event) => event.seq)).size).toBe(reconnect.events.length);
    expect(fs.readFileSync(join(workspace, "src", "calc.ts"), "utf8")).toContain("a + b");

    const reloadedRenderer = await connectSse(port);
    clients.push(reloadedRenderer);
    await reloadedRenderer.waitFor((event) => event.type === "task.completed");
    const taskEvents = reloadedRenderer.events.filter((event) =>
      JSON.stringify(event.payload).includes(taskId),
    );
    expect(taskEvents.some((event) => event.type === "task.created")).toBe(true);
    expect(taskEvents.some((event) => event.type === "task.completed")).toBe(true);
    expect(new Set(taskEvents.map((event) => event.seq)).size).toBe(taskEvents.length);
  });

  it("delivers each live event once to each concurrent client", async () => {
    const left = await connectSse(port);
    const right = await connectSse(port);
    clients.push(left, right);
    const run = await jsonRequest(port, "/api/workflow/run", {
      sessionId: "duplicate-session",
      message: "Fix add function",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    const leftCreated = await left.waitFor((event) => event.type === "task.created");
    const rightCreated = await right.waitFor((event) => event.seq === leftCreated.seq);
    expect(rightCreated.type).toBe("task.created");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(left.events.filter((event) => event.seq === leftCreated.seq)).toHaveLength(1);
    expect(right.events.filter((event) => event.seq === leftCreated.seq)).toHaveLength(1);
    await jsonRequest(port, `/api/workflow/${run.taskId}/cancel`, {});
  });
});
