import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ProviderAdapter, type StreamEvent } from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { ERROR_CODES } from "@codeforge/agent";
import { createAgentRuntime } from "../src/agent-runtime.js";

describe("R73 bounded native cwd repair", () => {
  it.runIf(process.platform === "win32")("retains the one real edit and tests it after the model explicitly corrects unsupported cwd", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "r73-cwd-recovery-"));
    await fs.writeFile(path.join(workspace, "source.mjs"), "export const limit = 4;\n");
    await fs.writeFile(path.join(workspace, "source.test.mjs"), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { limit } from './source.mjs'; test('correct boundary', () => assert.equal(limit, 3));\n");
    const requests: ChatRequest[] = [];
    const calls = [
      { name: "read_file", args: { path: "source.mjs" } },
      { name: "edit_file", args: { path: "source.mjs", oldText: "limit = 4", newText: "limit = 3" } },
      { name: "run_command", args: { command: "node --test source.test.mjs", cwd: "/workspace/coder-forge" } },
      { name: "run_command", args: { command: "node --test source.test.mjs", cwd: "." } },
    ];
    const provider: ProviderAdapter = {
      providerId: "cwd-provider", isTestProvider: true, listModels: async () => [], healthCheck: async () => ({ status: "available" }), chat: async () => { throw new Error("stream only"); },
      streamChat: async function* (request): AsyncIterable<StreamEvent> {
        const call = calls[requests.length];
        requests.push(request);
        if (call) {
          yield { type: "tool_call_completed", toolCallId: `call-${requests.length}`, toolName: call.name, arguments: JSON.stringify(call.args) };
          yield { type: "finish", finishReason: "tool_calls" };
        } else {
          yield { type: "text_delta", delta: "Implemented the boundary fix; the actual test passed." };
          yield { type: "finish", finishReason: "stop" };
        }
      },
    };
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: provider.providerId, modelId: "cwd-model" }));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const runtime = createAgentRuntime({ sessionId: "cwd-session", eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: workspace });
    try {
      const result = await runtime.executeAgentRun({ runId: "cwd-run", agentId: "coder", role: "coder", goal: "Limit must equal three", workspaceId: "isolated", workspacePath: workspace,
        permissions: { read: true, search: true, write: true, executeCommand: true, network: false }, executionBudget: { maxModelTurns: 6, maxToolCalls: 8, maxContextTokens: 32_000 } });
      expect(result.status).toBe("completed");
      expect(requests).toHaveLength(5);
      expect(requests[3]?.messages.some((message) => message.role === "tool" && message.content.includes("Omit cwd"))).toBe(true);
      const commands = result.toolExecutions.filter((execution) => execution.toolName === "run_command");
      expect(commands[0]).toMatchObject({ success: false, error: ERROR_CODES.TOOL_ARGUMENT_INVALID });
      expect(commands[1]).toMatchObject({ success: true });
      expect(commands[1]?.output).toContain("Exit code: 0");
      expect(commands[1]?.output).toContain("pass 1");
      expect(result.toolExecutions.filter((execution) => execution.toolName === "edit_file")).toHaveLength(1);
      expect(result.filesChanged).toEqual(["source.mjs"]);
      expect(await fs.readFile(path.join(workspace, "source.mjs"), "utf8")).toBe("export const limit = 3;\n");
    } finally { await runtime.shutdown(); await persistence.close(); await fs.rm(workspace, { recursive: true, force: true }); }
  });
});
