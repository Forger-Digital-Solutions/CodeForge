import { describe, expect, it } from "vitest";
import { CodexAccountAdapter, type CodexAppServerTransport } from "../src/codex-account.js";

function transportFor(options: {
  account?: unknown;
  limits?: unknown;
  turnText?: string;
  stream?: unknown[];
  errorMethods?: string[];
} = {}): { transport: CodexAppServerTransport; calls: string[] } {
  const calls: string[] = [];
  const transport: CodexAppServerTransport = {
    async request(method) {
      calls.push(method);
      if (options.errorMethods?.includes(method)) throw new Error("timeout");
      if (method === "account/read") return options.account ?? { account: { type: "chatgpt", accountId: "acct-1", email: "user@example.test", planType: "plus" } };
      if (method === "account/rateLimits/read") return options.limits ?? {
        rateLimits: { limitId: "codex", primary: { usedPercent: 20, resetsAt: Math.floor(Date.now() / 1000) + 60 }, secondary: null, rateLimitReachedType: null },
      };
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") return { text: options.turnText ?? "Codex response" };
      return {};
    },
    ...(options.stream ? { stream: async function* (method: string) { calls.push(method); for (const event of options.stream!) yield event; } } : {}),
  };
  return { transport, calls };
}

async function collectText(adapter: CodexAccountAdapter): Promise<string> {
  let text = "";
  for await (const event of adapter.streamChat({ model: "default", messages: [{ role: "user", content: "hello" }] })) {
    if (event.type === "text_delta") text += event.delta;
  }
  return text;
}

describe("Codex account route", () => {
  it("starts documented ChatGPT login without returning privileged tokens", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const transport: CodexAppServerTransport = {
      async request(method, params) {
        calls.push({ method, params });
        return { authUrl: "https://auth.example.test", userCode: "ABCD-EFGH", accessToken: "must-not-escape" };
      },
    };
    const result = await new CodexAccountAdapter({ transport }).startLogin();
    expect(result).toEqual({ authUrl: "https://auth.example.test", userCode: "ABCD-EFGH" });
    expect(calls).toEqual([{
      method: "account/login/start",
      params: { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" },
    }]);
  });

  it("classifies a missing codex executable as unavailable, not an auth failure", async () => {
    const adapter = new CodexAccountAdapter({
      transport: { request: async () => { throw new Error("spawn codex.exe ENOENT"); } },
    });
    await expect(adapter.readAccount()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(adapter.routeState).toBe("unauthenticated");
  });

  it("normalizes login failure and only cancels the requested login id", async () => {
    const failed = new CodexAccountAdapter({
      transport: { request: async () => { throw new Error("login failed"); } },
    });
    await expect(failed.startLogin()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    const { transport, calls } = transportFor();
    const adapter = new CodexAccountAdapter({ transport });
    await expect(adapter.cancelLogin("")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await adapter.cancelLogin("login-1");
    expect(calls).toContain("account/login/cancel");
  });

  it("fails closed before authentication and exposes no models", async () => {
    const { transport } = transportFor({ account: {} });
    const adapter = new CodexAccountAdapter({ transport });
    expect(await adapter.listModels()).toEqual([]);
    expect((await adapter.healthCheck()).status).toBe("auth_required");
  });

  it("reads ChatGPT account allowance and streams through the app-server seam", async () => {
    const { transport, calls } = transportFor({ stream: [
      { method: "item/agentMessage/delta", params: { delta: "hello" } },
      { method: "turn/completed", params: {} },
    ] });
    const adapter = new CodexAccountAdapter({ transport });
    expect((await adapter.healthCheck()).status).toBe("available");
    expect(adapter.routeState).toBe("allowance_available");
    expect((await adapter.listModels())[0]?.displayName).toContain("ChatGPT account");
    expect(await collectText(adapter)).toBe("hello");
    expect(calls).toContain("account/read");
    expect(calls).toContain("account/rateLimits/read");
    expect(calls).toContain("thread/start");
    expect(calls).toContain("turn/start");
  });

  it("accepts a managed ChatGPT account without exposing an email or account id", async () => {
    const { transport } = transportFor({ account: { account: { type: "chatgpt" } } });
    const adapter = new CodexAccountAdapter({ transport });
    expect(await adapter.readAccount()).toEqual({ accountId: "chatgpt-account", authMode: "chatgpt" });
  });

  it("refuses an exhausted allowance without starting a turn", async () => {
    const { transport, calls } = transportFor({ limits: { rateLimits: { primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 60 }, secondary: null, rateLimitReachedType: "primary" } } });
    const adapter = new CodexAccountAdapter({ transport });
    await expect(collectText(adapter)).rejects.toMatchObject({ code: "ALLOWANCE_EXHAUSTED" });
    expect(calls).not.toContain("thread/start");
  });

  it("normalizes app-server timeout failures and clears account state on logout", async () => {
    const { transport } = transportFor({ errorMethods: ["account/read"] });
    const adapter = new CodexAccountAdapter({ transport });
    expect((await adapter.healthCheck()).status).toBe("offline");

    const connected = transportFor();
    const connectedAdapter = new CodexAccountAdapter({ transport: connected.transport });
    await connectedAdapter.readAccount();
    await connectedAdapter.logout();
    expect(connectedAdapter.routeState).toBe("unauthenticated");
    expect(connectedAdapter.accountSnapshot).toBeNull();
    expect(await connectedAdapter.listModels()).toEqual([]);
  });

  it("fails with a normalized TIMEOUT when app-server does not respond", async () => {
    const transport: CodexAppServerTransport = {
      request: async () => await new Promise<unknown>(() => {}),
    };
    const adapter = new CodexAccountAdapter({ transport, timeoutMs: 1 });
    await expect(adapter.readAccount()).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("fails closed when CodeForge would need to delegate tools", async () => {
    const { transport, calls } = transportFor();
    const adapter = new CodexAccountAdapter({ transport });
    await expect(collectText(adapter)).resolves.toBe("Codex response");
    await expect(
      adapter.streamChat({
        model: "default",
        messages: [{ role: "user", content: "edit a file" }],
        tools: [{ type: "function", function: { name: "write_file", description: "write", parameters: { type: "object", properties: {} } } }],
      }).next(),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TOOL" });
    expect(calls.filter((method) => method === "thread/start")).toHaveLength(1);
  });

  it("bridges official dynamic tools to CodeForge with correlation, deduplication, and fail-closed validation", async () => {
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const executed: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const transport: CodexAppServerTransport = {
      snapshot: { processSessionId: "process-1" },
      async request(method, params) {
        requests.push({ method, params });
        if (method === "account/read") return { account: { type: "chatgpt", accountId: "acct-1" } };
        if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 10 }, secondary: null, rateLimitReachedType: null } };
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        return {};
      },
      async *stream(_method, _params, signal) {
        yield { method: "item/agentMessage/delta", params: { delta: "ready" } };
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        }
      },
    };
    const adapter = new CodexAccountAdapter({
      transport,
      toolExecutor: async (request) => {
        executed.push(request as unknown as Record<string, unknown>);
        return { success: true, output: "ok Bearer sk-secret-1234567890123456" };
      },
    });
    const iterator = adapter.streamChatWithContext({
      model: "default",
      messages: [{ role: "user", content: "write" }],
      tools: [{ type: "function", function: { name: "write_file", description: "write", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    }, { sessionId: "session-1", turnId: "cf-turn-1", workspacePath: "C:\\workspace" }, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "text_delta", delta: "ready" } });

    const dynamicRequest = {
      id: "server-1",
      method: "item/tool/call",
      processSessionId: "process-1",
      params: {
        threadId: "thread-1",
        turnId: "codex-turn-1",
        callId: "call-1",
        namespace: "codeforge",
        tool: "write_file",
        arguments: { path: "a.txt", content: "hello" },
      },
    };
    const [first, duplicate] = await Promise.all([
      adapter.handleServerRequest(dynamicRequest),
      adapter.handleServerRequest({ ...dynamicRequest, id: "server-duplicate" }),
    ]);
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ success: true, contentItems: [{ type: "inputText" }] });
    expect(JSON.stringify(first)).not.toContain("sk-secret");
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      providerId: "codex-account",
      processSessionId: "process-1",
      sessionId: "session-1",
      turnId: "cf-turn-1",
      providerThreadId: "thread-1",
      providerTurnId: "codex-turn-1",
      serverRequestId: "server-1",
      toolCallId: "call-1",
      namespace: "codeforge",
      toolName: "write_file",
    });
    expect(requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      cwd: "C:\\workspace",
      sandbox: "read-only",
      approvalPolicy: "untrusted",
      ephemeral: true,
      dynamicTools: [{ type: "namespace", name: "codeforge" }],
    });

    await expect(adapter.handleServerRequest({
      ...dynamicRequest,
      id: "malformed",
      params: { ...dynamicRequest.params, namespace: "forged" },
    })).rejects.toMatchObject({ code: "UNSUPPORTED_TOOL" });
    await expect(adapter.handleServerRequest({
      id: "built-in",
      method: "item/commandExecution/requestApproval",
      processSessionId: "process-1",
      params: { threadId: "thread-1", command: "dir" },
    })).rejects.toMatchObject({ code: "UNSUPPORTED_TOOL" });

    controller.abort();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await expect(adapter.handleServerRequest({ ...dynamicRequest, id: "late" })).rejects.toMatchObject({ code: "UNSUPPORTED_TOOL" });
  });
});
