import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerProcess,
  type CodexRpcRequest,
} from "../src/codex-app-server-process.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  readonly written: Array<Record<string, unknown>> = [];
  mode: "normal" | "silent" | "malformed" | "turn-response-only" | "init-silent" | "duplicate-response" | "duplicate-server" = "normal";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as Record<string, unknown>;
        this.written.push(message);
        this.respond(message);
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("close", 0, null));
    return true;
  }

  private respond(message: Record<string, unknown>): void {
    if (message.method === "initialize") {
      if (this.mode === "init-silent") return;
      this.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }) + "\n");
      return;
    }
    if (this.mode === "silent") return;
    if (this.mode === "malformed") {
      this.stdout.write("not-json\n");
      return;
    }
    if (this.mode === "duplicate-response" && message.method === "account/read") {
      const response = JSON.stringify({ id: message.id, result: {} }) + "\n";
      this.stdout.write(response);
      this.stdout.write(response);
      return;
    }
    if (message.method === "thread/start") {
      const approval = JSON.stringify({ id: "server-approval", method: "item/commandExecution/requestApproval", params: { command: "dir", threadId: "thread-1" } }) + "\n";
      this.stdout.write(approval);
      if (this.mode === "duplicate-server") this.stdout.write(approval);
      this.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: "thread-1" } } }) + "\n");
      return;
    }
    if (message.method === "turn/start") {
      this.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: "turn-1" } } }) + "\n");
      if (this.mode === "turn-response-only") return;
      this.stdout.write(JSON.stringify({ method: "unknown/event", params: { ignored: true } }) + "\n");
      this.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "hello" } }) + "\n");
      this.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1" } }) + "\n");
      return;
    }
    this.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
  }

  completeUnexpectedly(): void {
    this.exitCode = 17;
    this.emit("close", 17, null);
  }
}

describe("Codex app-server process transport", () => {
  it("performs initialize once, frames JSONL, correlates responses, and rejects arbitrary methods", async () => {
    let child: FakeChild | undefined;
    let spawnOptions: import("node:child_process").SpawnOptions | undefined;
    const transport = new CodexAppServerProcess({
      executable: "codex-fixture",
      env: { OPENAI_API_KEY: "must-not-reach-codex" },
      skipExecutableCheck: true,
      spawnFn: (_executable, _args, options) => {
        spawnOptions = options;
        child = new FakeChild();
        return child as never;
      },
      requestTimeoutMs: 100,
      shutdownTimeoutMs: 20,
    });

    await expect(transport.request("account/read", {})).resolves.toEqual({});
    await expect(transport.request("account/rateLimits/read", {})).resolves.toEqual({});
    await expect(transport.request("shell/exec", {})).rejects.toMatchObject({ code: "UNSUPPORTED_METHOD" });
    expect(child?.written.filter((message) => message.method === "initialize")).toHaveLength(1);
    expect(child?.written.find((message) => message.method === "initialize")?.params).toMatchObject({
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    expect(spawnOptions?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(transport.snapshot.state).toBe("ready");
    await transport.close();
    expect(transport.snapshot.state).toBe("closed");
  });

  it("streams notifications and handles server-initiated requests through the host callback", async () => {
    let child: FakeChild | undefined;
    const serverRequests: CodexRpcRequest[] = [];
    const transport = new CodexAppServerProcess({
      executable: "codex-fixture",
      skipExecutableCheck: true,
      spawnFn: () => {
        child = new FakeChild();
        child.mode = "duplicate-server";
        return child as never;
      },
      onServerRequest: (request) => {
        serverRequests.push(request);
        return { decision: "decline" };
      },
      shutdownTimeoutMs: 20,
    });

    await transport.request("thread/start", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(serverRequests).toHaveLength(1);
    expect(serverRequests[0]).toMatchObject({
      id: "server-approval",
      method: "item/commandExecution/requestApproval",
      params: { command: "dir", threadId: "thread-1" },
    });
    expect(serverRequests[0]?.processSessionId).toBe(transport.snapshot.processSessionId);
    const events: unknown[] = [];
    for await (const event of transport.stream!("turn/start", { threadId: "thread-1" })) events.push(event);
    expect(events).toEqual([
      { method: "unknown/event", params: { ignored: true } },
      { method: "item/agentMessage/delta", params: { delta: "hello" } },
      { method: "turn/completed", params: { threadId: "thread-1" } },
    ]);
    expect(transport.snapshot.pendingRequests).toBe(0);
    await transport.close();
    expect(child?.killed || child?.exitCode === 0).toBe(true);
  });

  it("fails pending requests on malformed frames and unexpected process death", async () => {
    let child: FakeChild | undefined;
    const transport = new CodexAppServerProcess({
      executable: "codex-fixture",
      requestTimeoutMs: 100,
      skipExecutableCheck: true,
      spawnFn: () => {
        child = new FakeChild();
        return child as never;
      },
      shutdownTimeoutMs: 20,
    });
    await transport.request("account/read", {});
    child!.mode = "malformed";
    await expect(transport.request("account/read", {})).rejects.toMatchObject({ code: "MALFORMED_FRAME" });

    let deadChild: FakeChild | undefined;
    const deadTransport = new CodexAppServerProcess({
      executable: "codex-fixture",
      requestTimeoutMs: 100,
      skipExecutableCheck: true,
      spawnFn: () => {
        deadChild = new FakeChild();
        return deadChild as never;
      },
      shutdownTimeoutMs: 20,
    });
    await deadTransport.request("account/read", {});
    deadChild!.mode = "silent";
    const pending = deadTransport.request("account/read", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    deadChild!.completeUnexpectedly();
    await expect(pending).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    await expect(deadTransport.request("account/read", {})).resolves.toEqual({});
    await deadTransport.close();
  });

  it("times out unanswered requests, restarts with a fresh process, and cleans pending state", async () => {
    const children: FakeChild[] = [];
    const transport = new CodexAppServerProcess({
      executable: "codex-fixture",
      requestTimeoutMs: 10,
      skipExecutableCheck: true,
      spawnFn: () => {
        const child = new FakeChild();
        children.push(child);
        return child as never;
      },
      shutdownTimeoutMs: 20,
    });
    await transport.request("account/read", {});
    children[0]!.mode = "silent";
    await expect(transport.request("account/read", {})).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(transport.snapshot.pendingRequests).toBe(0);
    await transport.restart();
    await transport.request("account/read", {});
    expect(children).toHaveLength(2);
    expect(transport.snapshot.restartCount).toBe(1);
    await transport.close();
  });

  it("ignores duplicate and late responses after their request is settled", async () => {
    let child: FakeChild | undefined;
    const transport = new CodexAppServerProcess({
      executable: "codex-fixture",
      requestTimeoutMs: 10,
      skipExecutableCheck: true,
      spawnFn: () => {
        child = new FakeChild();
        return child as never;
      },
      shutdownTimeoutMs: 20,
    });
    await transport.request("account/read", {});
    child!.mode = "duplicate-response";
    await expect(transport.request("account/read", {})).resolves.toEqual({});
    expect(transport.snapshot.pendingRequests).toBe(0);
    child!.mode = "silent";
    const lateRequest = transport.request("account/read", {});
    await expect(lateRequest).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    const lateId = child!.written.at(-1)?.id;
    child!.stdout.write(JSON.stringify({ id: lateId, result: { late: true } }) + "\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport.snapshot.pendingRequests).toBe(0);
    await transport.close();
  });

  it("redacts stderr before forwarding diagnostics", async () => {
    let child: FakeChild | undefined;
    const stderr: string[] = [];
    const transport = new CodexAppServerProcess({
      executable: "codex-fixture",
      skipExecutableCheck: true,
      onStderr: (line) => stderr.push(line),
      spawnFn: () => {
        child = new FakeChild();
        return child as never;
      },
      shutdownTimeoutMs: 20,
    });
    await transport.request("account/read", {});
    child!.stderr.write("Bearer sk-secret-1234567890123456\n");
    expect(stderr.join("\n")).not.toContain("sk-secret");
    expect(stderr.join("\n")).toContain("***");
    await transport.close();
  });

  it("closes a streaming turn promptly when its abort signal fires", async () => {
    let child: FakeChild | undefined;
    const transport = new CodexAppServerProcess({
      executable: "codex-fixture",
      skipExecutableCheck: true,
      spawnFn: () => {
        child = new FakeChild();
        return child as never;
      },
      shutdownTimeoutMs: 20,
    });
    await transport.request("account/read", {});
    child!.mode = "turn-response-only";
    const controller = new AbortController();
    const iterator = transport.stream!("turn/start", { threadId: "thread-1" }, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    controller.abort();
    await expect(next).resolves.toMatchObject({ done: true });
    await transport.close();
  });

  it("reports executable and startup failures without leaving a live transport", async () => {
    const missing = new CodexAppServerProcess({
      executable: "missing-codex",
      spawnFn: () => { throw new Error("spawn missing-codex ENOENT"); },
    });
    await expect(missing.request("account/read", {})).rejects.toMatchObject({ code: "EXECUTABLE_NOT_FOUND" });
    expect(missing.snapshot.state).toBe("failed");

    const spawnFailure = new CodexAppServerProcess({
      executable: "codex-fixture",
      skipExecutableCheck: true,
      spawnFn: () => { throw new Error("permission denied"); },
    });
    await expect(spawnFailure.request("account/read", {})).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(spawnFailure.snapshot.state).toBe("failed");

    const startupTimeout = new CodexAppServerProcess({
      executable: "codex-fixture",
      startupTimeoutMs: 10,
      skipExecutableCheck: true,
      spawnFn: () => {
        const child = new FakeChild();
        child.mode = "init-silent";
        return child as never;
      },
      shutdownTimeoutMs: 20,
    });
    await expect(startupTimeout.request("account/read", {})).rejects.toMatchObject({ code: "STARTUP_TIMEOUT" });
    expect(startupTimeout.snapshot.state).toBe("failed");
  });

  it("validates executable existence at spawn time", async () => {
    const missingFile = new CodexAppServerProcess({
      executable: "completely-missing-executable",
      spawnFn: () => { throw new Error("ENOENT: completely-missing-executable"); },
    });
    await expect(missingFile.request("account/read", {})).rejects.toMatchObject({
      code: "EXECUTABLE_NOT_FOUND",
      retryable: false,
    });
    expect(missingFile.snapshot.state).toBe("failed");
  });

  it("rejects path-based configured executable that does not exist with non-retryable error", async () => {
    const missingPath = new CodexAppServerProcess({
      executable: "/nonexistent/path/to/codex",
      spawnFn: () => { throw new Error("should not reach spawn"); },
    });
    await expect(missingPath.request("account/read", {})).rejects.toMatchObject({
      code: "EXECUTABLE_NOT_FOUND",
      retryable: false,
    });
    expect(missingPath.snapshot.state).toBe("failed");
  });

  it("uses configured executable when provided", async () => {
    let spawnedExecutable: string | undefined;
    const transport = new CodexAppServerProcess({
      executable: "codex-fixture",
      skipExecutableCheck: true,
      spawnFn: (executable) => {
        spawnedExecutable = executable;
        const child = new FakeChild();
        return child as never;
      },
      shutdownTimeoutMs: 20,
    });
    await transport.request("account/read", {});
    expect(spawnedExecutable).toBe("codex-fixture");
    await transport.close();
  });

  it("falls back to platform default when no configured executable", async () => {
    let spawnedExecutable: string | undefined;
    let spawnedArgs: readonly string[] | undefined;
    const transport = new CodexAppServerProcess({
      skipExecutableCheck: true,
      spawnFn: (executable, args) => {
        spawnedExecutable = executable;
        spawnedArgs = args;
        const child = new FakeChild();
        return child as never;
      },
      shutdownTimeoutMs: 20,
    });
    await transport.request("account/read", {});
    expect(transport.snapshot.executable).toMatch(/codex/);
    if (spawnedExecutable?.endsWith("node.exe") || spawnedExecutable?.endsWith("node")) {
      expect(spawnedArgs?.[0]).toMatch(/codex/);
    } else {
      expect(spawnedExecutable).toMatch(/codex/);
    }
    await transport.close();
  });

  it("rejects configured executable path that does not exist", async () => {
    const missingPath = new CodexAppServerProcess({
      executable: "/nonexistent/path/to/codex",
      spawnFn: () => { throw new Error("should not reach spawn"); },
    });
    await expect(missingPath.request("account/read", {})).rejects.toMatchObject({
      code: "EXECUTABLE_NOT_FOUND",
      retryable: false,
    });
    expect(missingPath.snapshot.state).toBe("failed");
  });

  it("accepts simple name (not a path) without existence check", async () => {
    const simpleName = new CodexAppServerProcess({
      executable: "codex",
      skipExecutableCheck: true,
      spawnFn: () => {
        const child = new FakeChild();
        return child as never;
      },
      shutdownTimeoutMs: 20,
    });
    await simpleName.request("account/read", {});
    await simpleName.close();
  });
});
