import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import type { ToolDefinition } from "@codeforge/tools";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createExternalToolSurface, type PluginToolHost } from "../src/external-tools.js";
import { ERROR_CODES } from "@codeforge/agent";

/**
 * R22 wiring proof: browser/MCP tools flow through the same ToolRegistry → ToolBroker →
 * permission gate → durable record pipeline as built-ins. No live browser or MCP server is
 * needed — the seam under test is dispatch/authority/durability, and the externalTools surface
 * is injected with stub executors that prove the chain end-to-end.
 */

const BROWSER_STATE_DEF: ToolDefinition = {
  name: "browser_state",
  description: "Read the governed browser session state",
  parameters: { type: "object", properties: { sessionId: { type: "string" } } },
  requiredPermission: "network",
  readOnly: true,
  executionClass: "network",
};

const MCP_READ_DEF: ToolDefinition = {
  name: "mcp__docs__lookup",
  description: "[MCP:docs] Look up a documentation entry",
  parameters: { type: "object", properties: { topic: { type: "string" } } },
  requiredPermission: "network",
  readOnly: true,
  executionClass: "network",
};

const BROWSER_SUBMIT_DEF: ToolDefinition = {
  name: "browser_submit",
  description: "Submit a form in the governed browser",
  parameters: { type: "object", properties: { target: { type: "object" } }, required: ["target"] },
  requiredPermission: "network",
  readOnly: false,
  executionClass: "network",
};

class ExternalToolProvider implements ProviderAdapter {
  readonly providerId = "test-provider";
  readonly isTestProvider = true;
  private callCount = 0;
  constructor(private readonly calls: { toolName: string; args: Record<string, unknown> }[]) {
    if (calls.length === 0) throw new Error("needs at least one scripted call");
  }
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "test-model", displayName: "Test Model", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("Use streamChat"); }
  async *streamChat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.callCount++;
    const call = this.calls[this.callCount - 1];
    if (call) {
      yield { type: "tool_call_started", toolCallId: `tc-${this.callCount}`, toolName: call.toolName };
      yield { type: "tool_call_completed", toolCallId: `tc-${this.callCount}`, toolName: call.toolName, arguments: JSON.stringify(call.args) };
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 20 } };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: "done" };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() { return { status: "available" as const }; }
}

const ALL_PERMISSIONS = { read: true, search: true, write: true, executeCommand: true, network: true };
const NO_NETWORK = { ...ALL_PERMISSIONS, network: false };

describe("R22 external tool wiring — registry, authority, receipts", () => {
  let tmpDir: string;
  let persistence: ReturnType<typeof createSessionPersistence>;
  let eventStore: EventStore;
  let firewall: ForgeZero;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-ext-tools-test-"));
    persistence = createSessionPersistence();
    eventStore = new EventStore();
    firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "test-model" }));
  });

  afterEach(async () => {
    persistence.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const buildRuntime = (externalTools?: {
    definitions?: ToolDefinition[];
    execute?: (name: string, args: Record<string, unknown>) => Promise<string | undefined>;
    effectOf?: (toolName: string) => "network_read" | "external" | undefined;
  }) => {
    const catalog = new InMemoryProviderCatalog();
    return {
      catalog,
      runtime: createAgentRuntime({
        sessionId: "ext-session",
        eventStore,
        persistence,
        firewall,
        providerCatalog: catalog,
        workspacePath: tmpDir,
        externalTools,
      }),
    };
  };

  const runOnce = async (
    runtime: ReturnType<typeof createAgentRuntime>,
    catalog: InMemoryProviderCatalog,
    toolName: string,
    args: Record<string, unknown>,
    permissions = ALL_PERMISSIONS,
  ) => {
    catalog.register(new ExternalToolProvider([{ toolName, args }]));
    return runtime.executeAgentRun({
      runId: `run-${toolName}-${crypto.randomUUID().slice(0, 8)}`,
      agentId: "coder",
      role: "coder",
      goal: "exercise external tool",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions,
    });
  };

  it("denies browser tools outright when the lease grants network:false (broker permission gate)", async () => {
    let executorCalled = false;
    const { runtime, catalog } = buildRuntime({
      definitions: [BROWSER_STATE_DEF],
      execute: async () => { executorCalled = true; return "SHOULD-NOT-REACH"; },
    });
    const result = await runOnce(runtime, catalog, "browser_state", { sessionId: "s-1" }, NO_NETWORK);
    expect(executorCalled).toBe(false);
    const exec = result.toolExecutions.find((t) => t.toolName === "browser_state");
    expect(exec?.success).toBe(false);
    expect(exec?.error).toBe(ERROR_CODES.TOOL_PERMISSION_DENIED);
    expect(exec?.output).toContain("network");
  });

  it("executes external tools through the chain with network:true and journals a network-class durable record", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const { runtime, catalog } = buildRuntime({
      definitions: [BROWSER_STATE_DEF],
      execute: async (name, args) => {
        calls.push({ name, args });
        return `<untrusted-data source="browser">MARKER-OUTPUT</untrusted-data>`;
      },
    });
    const result = await runOnce(runtime, catalog, "browser_state", { sessionId: "s-1" });
    expect(calls).toEqual([{ name: "browser_state", args: { sessionId: "s-1" } }]);
    const exec = result.toolExecutions.find((t) => t.toolName === "browser_state");
    expect(exec?.success).toBe(true);
    expect(exec?.output).toContain("MARKER-OUTPUT");

    const records = (await persistence.getWorkItemsByKind("agent_tool_execution")) as unknown as {
      toolName: string; executionClass: string; state: string;
    }[];
    const rec = records.find((r) => r.toolName === "browser_state");
    expect(rec?.executionClass).toBe("network");
    expect(rec?.state).toBe("observation_recorded");
  });

  it("rejects external definitions that lack a governed namespace prefix", async () => {
    const { runtime, catalog } = buildRuntime({
      definitions: [{
        name: "evil_shadow_tool",
        description: "attempts to bypass namespace policy",
        parameters: { type: "object", properties: {} },
        requiredPermission: "read",
        readOnly: true,
        executionClass: "read",
      }],
      execute: async () => "nope",
    });
    catalog.register(new ExternalToolProvider([{ toolName: "evil_shadow_tool", args: {} }]));
    await expect(
      runtime.executeAgentRun({
        runId: "run-unprefixed",
        agentId: "coder",
        role: "coder",
        goal: "attempt shadow registration",
        workspaceId: "ws-1",
        workspacePath: tmpDir,
        permissions: ALL_PERMISSIONS,
      }),
    ).rejects.toThrow(/governed namespace prefix/);
  });

  it("denies browser_submit on autonomous runs — Tier 3 external commit has no approval channel", async () => {
    let executorCalled = false;
    const { runtime, catalog } = buildRuntime({
      definitions: [BROWSER_SUBMIT_DEF],
      execute: async () => { executorCalled = true; return "COMMITTED"; },
    });
    const result = await runOnce(runtime, catalog, "browser_submit", { target: { role: "button", name: "Pay now" } });
    expect(executorCalled).toBe(false);
    const exec = result.toolExecutions.find((t) => t.toolName === "browser_submit");
    expect(exec?.success).toBe(false);
    expect(exec?.error).toBe(ERROR_CODES.TOOL_PERMISSION_DENIED);
    expect(exec?.output).toContain("no approval channel");
  });

  it("denies MCP external-effect tools on autonomous runs via effectOf, even with network:true", async () => {
    let executorCalled = false;
    const { runtime, catalog } = buildRuntime({
      definitions: [{
        name: "mcp__hub__publish",
        description: "[MCP:hub] Publish a package",
        parameters: { type: "object", properties: {} },
        requiredPermission: "network",
        readOnly: false,
        executionClass: "network",
      }],
      execute: async () => { executorCalled = true; return "PUBLISHED"; },
      effectOf: (name) => (name === "mcp__hub__publish" ? "external" : undefined),
    });
    const result = await runOnce(runtime, catalog, "mcp__hub__publish", {});
    expect(executorCalled).toBe(false);
    const exec = result.toolExecutions.find((t) => t.toolName === "mcp__hub__publish");
    expect(exec?.success).toBe(false);
    expect(exec?.error).toBe(ERROR_CODES.TOOL_PERMISSION_DENIED);
  });

  it("permits MCP network_read tools on autonomous runs when network is granted", async () => {
    const { runtime, catalog } = buildRuntime({
      definitions: [MCP_READ_DEF],
      execute: async (name) => (name === "mcp__docs__lookup" ? "DOC-CONTENT-XYZ" : undefined),
      effectOf: (name) => (name === "mcp__docs__lookup" ? "network_read" : undefined),
    });
    const result = await runOnce(runtime, catalog, "mcp__docs__lookup", { topic: "vitest" });
    const exec = result.toolExecutions.find((t) => t.toolName === "mcp__docs__lookup");
    expect(exec?.success).toBe(true);
    expect(exec?.output).toContain("DOC-CONTENT-XYZ");
  });

  it("an executor returning undefined falls through to customToolExecutor, then to unknown-tool handling", async () => {
    const { runtime, catalog } = buildRuntime({
      definitions: [BROWSER_STATE_DEF],
      execute: async () => undefined,
    });
    catalog.register(new ExternalToolProvider([{ toolName: "browser_state", args: { sessionId: "s-9" } }]));
    const result = await runtime.executeAgentRun({
      runId: "run-fallthrough",
      agentId: "coder",
      role: "coder",
      goal: "fallthrough check",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: ALL_PERMISSIONS,
      customToolExecutor: async (name) => (name === "browser_state" ? "CUSTOM-EXECUTOR-RESULT" : undefined),
    });
    const exec = result.toolExecutions.find((t) => t.toolName === "browser_state");
    expect(exec?.output).toContain("CUSTOM-EXECUTOR-RESULT");
  });

  it("read-only subagent roles cannot execute mutating external tools even with network granted", async () => {
    let executorCalled = false;
    const { runtime, catalog } = buildRuntime({
      definitions: [BROWSER_SUBMIT_DEF],
      execute: async () => { executorCalled = true; return "COMMITTED"; },
    });
    catalog.register(new ExternalToolProvider([{ toolName: "browser_submit", args: { target: { selector: "form" } } }]));
    const result = await runtime.executeAgentRun({
      runId: "run-explorer-submit",
      agentId: "explorer",
      role: "explorer",
      goal: "explorer attempts external commit",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: ALL_PERMISSIONS,
    });
    expect(executorCalled).toBe(false);
    const exec = result.toolExecutions.find((t) => t.toolName === "browser_submit");
    expect(exec?.success).toBe(false);
    expect(exec?.error).toBe(ERROR_CODES.TOOL_PERMISSION_DENIED);
  });

  it("publication authority invariant: no agent-facing publish/push/PR tool exists in the registry", async () => {
    // Single-publication-authority is structural: agents can never initiate push/PR — only the
    // explicit delivery→publication bridge route can, and it rejects client-supplied remote
    // identity. If a tool named like a publication action ever appears, this test fails and
    // forces a security review of the wiring that registered it.
    const { createToolBroker } = await import("@codeforge/tools");
    const broker = createToolBroker();
    const names = broker.getRegistry().all().map((t) => t.name);
    expect(names.filter((n) => /publish|push|pull_request|pr_create|merge|deploy|release/i.test(n))).toEqual([]);
    expect(names.filter((n) => n.startsWith("browser_") || n.startsWith("mcp__"))).toEqual([]);
  });

  it("ForgeGreen replays duplicate external reads within one state window and invalidates after a state-changing tool", async () => {
    let callCount = 0;
    const navDef: ToolDefinition = {
      name: "browser_navigate",
      description: "Navigate the governed browser",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      requiredPermission: "network",
      readOnly: false,
      executionClass: "network",
    };
    const { runtime, catalog } = buildRuntime({
      definitions: [BROWSER_STATE_DEF, navDef],
      execute: async (name) => {
        callCount++;
        return name === "browser_navigate" ? "NAVIGATED" : `SNAPSHOT-${callCount}`;
      },
    });
    catalog.register(new ExternalToolProvider([
      { toolName: "browser_state", args: { sessionId: "s-1" } },
      { toolName: "browser_state", args: { sessionId: "s-1" } },
      { toolName: "browser_navigate", args: { url: "https://example.com/next" } },
      { toolName: "browser_state", args: { sessionId: "s-1" } },
    ]));
    const result = await runtime.executeAgentRun({
      runId: "run-forgegreen-dedup",
      agentId: "coder",
      role: "coder",
      goal: "exercise duplicate suppression on external reads",
      workspaceId: "ws-1",
      workspacePath: tmpDir,
      permissions: ALL_PERMISSIONS,
    });
    // Three real executions: read, navigate, read. The middle read was replayed.
    expect(callCount).toBe(3);
    const reads = result.toolExecutions.filter((t) => t.toolName === "browser_state");
    const suppressed = result.toolExecutions.length === 0
      ? result.toolExecutions
      : reads;
    expect(suppressed.length).toBeGreaterThanOrEqual(1);
    // The suppressed call never reached the executor — only the post-navigation re-read did.
    const blockedEvents = eventStore.getAll({ types: ["tool.execution_blocked"] })
      .filter((e) => JSON.stringify(e.payload).includes("forgegreen_duplicate_suppressed"));
    expect(blockedEvents.length).toBe(1);
  });

  it("secrets in external tool output are redacted before reaching the record and the model", async () => {
    const { runtime, catalog } = buildRuntime({
      definitions: [BROWSER_STATE_DEF],
      execute: async () => "page html: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234 tail",
    });
    const result = await runOnce(runtime, catalog, "browser_state", { sessionId: "s-1" });
    const exec = result.toolExecutions.find((t) => t.toolName === "browser_state");
    expect(exec?.success).toBe(true);
    expect(exec?.output).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234");
    expect(exec?.output).toContain("[REDACTED");
  });
});

describe("R22 plugin bridge — extension commands as governed tools", () => {
  const stubHost = (overrides?: Partial<PluginToolHost>): PluginToolHost & { calls: { ext: string; cmd: string; args: unknown[] }[] } => {
    const calls: { ext: string; cmd: string; args: unknown[] }[] = [];
    return {
      calls,
      list: () => [
        {
          id: "acme.hello",
          enabled: true,
          status: "active",
          permissions: ["commands:register", "settings:write"],
          commands: [{ id: "hello.sayHi", title: "Say hi" }],
        },
        {
          id: "acme.disabled",
          enabled: false,
          status: "installed",
          permissions: ["commands:register"],
          commands: [{ id: "acme.disabled.nope", title: "Must not be bridged" }],
        },
        {
          id: "acme.errored",
          enabled: true,
          status: "error",
          permissions: ["commands:register"],
          commands: [{ id: "acme.errored.nope", title: "Must not be bridged" }],
        },
      ],
      runCommand: async (extensionId, commandId, args) => {
        calls.push({ ext: extensionId, cmd: commandId, args });
        return { ok: true, result: `ran ${commandId}` };
      },
      ...overrides,
    };
  };

  it("bridges contributed commands of active extensions under plugin__ with sanitized names", () => {
    const surface = createExternalToolSurface({}, { pluginHost: stubHost() });
    const names = surface.definitions.map((d) => d.name);
    expect(names).toContain("plugin__acme-hello__hello-sayHi");
    expect(names.some((n) => n.includes("disabled") || n.includes("errored"))).toBe(false);
    const def = surface.definitions.find((d) => d.name === "plugin__acme-hello__hello-sayHi");
    expect(def?.requiredPermission).toBe("write");
    expect(def?.readOnly).toBe(false);
    expect(def?.executionClass).toBe("write");
  });

  it("dispatches a bridged command to the host with the args array forwarded", async () => {
    const host = stubHost();
    const surface = createExternalToolSurface({}, { pluginHost: host });
    const out = await surface.execute("plugin__acme-hello__hello-sayHi", { args: ["x", 2] });
    expect(out).toBe("ran hello.sayHi");
    expect(host.calls).toEqual([{ ext: "acme.hello", cmd: "hello.sayHi", args: ["x", 2] }]);
  });

  it("surfaces a command failure as an Error result, and rejects unregistered tool names", async () => {
    const host = stubHost({
      runCommand: async () => ({ ok: false, error: "handler exploded" }),
    });
    const surface = createExternalToolSurface({}, { pluginHost: host });
    expect(await surface.execute("plugin__acme-hello__hello-sayHi", {})).toBe("Error: handler exploded");
    await expect(surface.execute("plugin__acme-ghost__nope", {})).rejects.toThrow(/not registered/);
  });

  it("exposeCommands:false disables bridging even with a host injected", () => {
    const surface = createExternalToolSurface(
      { plugins: { exposeCommands: false } },
      { pluginHost: stubHost() },
    );
    expect(surface.definitions).toEqual([]);
  });

  it("plugin tools execute through the runtime chain — namespace guard accepts plugin__", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-plugin-test-"));
    const persistence = createSessionPersistence();
    const eventStore = new EventStore();
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "test-model" }));
    try {
      const host = stubHost();
      const surface = createExternalToolSurface({}, { pluginHost: host });
      const catalog = new InMemoryProviderCatalog();
      const runtime = createAgentRuntime({
        sessionId: "plugin-session",
        eventStore,
        persistence,
        firewall,
        providerCatalog: catalog,
        workspacePath: tmpDir,
        externalTools: surface,
      });
      catalog.register(new ExternalToolProvider([{ toolName: "plugin__acme-hello__hello-sayHi", args: { args: ["hi"] } }]));
      const result = await runtime.executeAgentRun({
        runId: "run-plugin-cmd",
        agentId: "coder",
        role: "coder",
        goal: "invoke an extension command",
        workspaceId: "ws-1",
        workspacePath: tmpDir,
        permissions: { read: true, search: true, write: true, executeCommand: true, network: false },
      });
      expect(host.calls).toEqual([{ ext: "acme.hello", cmd: "hello.sayHi", args: ["hi"] }]);
      const exec = result.toolExecutions.find((t) => t.toolName === "plugin__acme-hello__hello-sayHi");
      expect(exec?.success).toBe(true);
      expect(exec?.output).toContain("ran hello.sayHi");
    } finally {
      persistence.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("read-only roles are denied plugin commands — write-gated at the broker", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-plugin-ro-test-"));
    const persistence = createSessionPersistence();
    const eventStore = new EventStore();
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "test-model" }));
    try {
      const host = stubHost();
      const surface = createExternalToolSurface({}, { pluginHost: host });
      const catalog = new InMemoryProviderCatalog();
      const runtime = createAgentRuntime({
        sessionId: "plugin-ro-session",
        eventStore,
        persistence,
        firewall,
        providerCatalog: catalog,
        workspacePath: tmpDir,
        externalTools: surface,
      });
      catalog.register(new ExternalToolProvider([{ toolName: "plugin__acme-hello__hello-sayHi", args: {} }]));
      const result = await runtime.executeAgentRun({
        runId: "run-plugin-ro",
        agentId: "explorer",
        role: "explorer",
        goal: "explorer attempts an extension command",
        workspaceId: "ws-1",
        workspacePath: tmpDir,
        permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      });
      expect(host.calls).toEqual([]);
      const exec = result.toolExecutions.find((t) => t.toolName === "plugin__acme-hello__hello-sayHi");
      expect(exec?.success).toBe(false);
      expect(exec?.error).toBe(ERROR_CODES.TOOL_PERMISSION_DENIED);
    } finally {
      persistence.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
