// R2 crash-recovery fixture: runs a REAL SubagentManager worker in a REAL child process and
// SIGKILLs itself at a deterministic point of the execution loop (inside the model stream or
// inside a real tool execution). The parent test then recovers against the same SQLite file from
// a fresh process's worth of state. Used only by packages/server/test/run-recovery.test.ts.
//
//   node run-recovery-worker.mjs <case> <dbPath> <repoDir>
//
// Cases:
//   kill-before-first-call   provider is killed before its first model response
//   kill-after-write         real write_file executes + observation is journaled, then crash
//   kill-readonly-unobserved list_files is killed mid-execution (record started, no observation)
//   kill-write-unobserved    write_file is killed mid-execution, before any bytes are written
//   kill-command-unobserved  run_command is killed mid-execution
process.env.NODE_ENV = "test";
process.env.CODEFORGE_ALLOW_TEST_PROVIDERS = "1";

import { createSessionPersistence, EventStore } from "@codeforge/sessions";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { createAgentRuntime, createSubagentManager, createWorkspaceEventAdapter } from "@codeforge/server";

const [, , testCase, dbPath, repoDir] = process.argv;

function crash() {
  process.kill(process.pid, "SIGKILL");
}

class RecoveryScriptedProvider {
  providerId = "codeforge";
  isTestProvider = true;

  async listModels() {
    return [{
      modelId: "free-model-1",
      displayName: "Free Model",
      isFree: true,
      freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }

  async chat() {
    throw new Error("Use streamChat");
  }

  async healthCheck() {
    return { status: "available" };
  }

  async *streamChat(req) {
    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    const isCoder = system.includes("CodeForge Coder");
    const isReviewer = system.includes("CodeForge Reviewer");
    const hasToolResult = req.messages.some((m) => m.role === "tool");

    if (isReviewer) {
      if (testCase === "kill-reviewer") crash();
      yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "Reviewer approved after recovery." }) };
      yield { type: "finish", finishReason: "stop" };
      return;
    }

    // R44's observed-state gate refuses writes to files the run never read — every write
    // path reads math.mjs on the first turn and writes on the second. `hasToolResult` is
    // kept for the resume-side provider's transcript shape; crash timing keys off the
    // tool-reply count so each case still dies at the same logical point.
    const toolReplies = req.messages.filter((m) => m.role === "tool").length;

    if (isCoder && toolReplies === 0) {
      if (testCase === "kill-before-first-call") crash();

      if (testCase === "kill-readonly-unobserved") {
        yield { type: "tool_call_started", toolCallId: "tc-list", toolName: "list_files" };
        yield { type: "tool_call_completed", toolCallId: "tc-list", toolName: "list_files", arguments: JSON.stringify({ path: "." }) };
        yield { type: "finish", finishReason: "tool_calls" };
        return;
      }

      if (testCase === "kill-command-unobserved") {
        yield { type: "tool_call_started", toolCallId: "tc-act", toolName: "run_command" };
        yield { type: "tool_call_completed", toolCallId: "tc-act", toolName: "run_command", arguments: JSON.stringify({ command: "echo RECOVERY_MUST_NOT_RUN_THIS" }) };
        yield { type: "finish", finishReason: "tool_calls" };
        return;
      }

      yield { type: "tool_call_started", toolCallId: "tc-read", toolName: "read_file" };
      yield { type: "tool_call_completed", toolCallId: "tc-read", toolName: "read_file", arguments: JSON.stringify({ path: "math.mjs" }) };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }

    if (isCoder && toolReplies === 1) {
      if (testCase === "kill-write-unobserved") {
        yield { type: "tool_call_started", toolCallId: "tc-act", toolName: "write_file" };
        yield { type: "tool_call_completed", toolCallId: "tc-act", toolName: "write_file", arguments: JSON.stringify({ path: "math.mjs", content: "RECOVERY_MUST_NOT_WRITE_THIS" }) };
        yield { type: "finish", finishReason: "tool_calls" };
        return;
      }

      if (testCase === "kill-readonly-unobserved" || testCase === "kill-command-unobserved") {
        yield { type: "text_delta", delta: "Fixed multiply." };
        yield { type: "finish", finishReason: "stop" };
        return;
      }

      yield { type: "tool_call_started", toolCallId: "tc-write", toolName: "write_file" };
      yield { type: "tool_call_completed", toolCallId: "tc-write", toolName: "write_file", arguments: JSON.stringify({ path: "math.mjs", content: "export function multiply(a, b) { return a * b; }\n" }) };
      yield { type: "finish", finishReason: "tool_calls" };
      return;
    }

    if (isCoder && hasToolResult) {
      if (testCase === "kill-after-write") crash();
      yield { type: "text_delta", delta: "Fixed multiply." };
      yield { type: "finish", finishReason: "stop" };
      return;
    }

    yield { type: "text_delta", delta: "Task completed." };
    yield { type: "finish", finishReason: "stop" };
  }
}

const persistence = createSessionPersistence({ dbPath });
await persistence.upsertSession({
  id: "recovery-session",
  title: "Recovery Session",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "running",
});
const eventStore = new EventStore();
const firewall = new ForgeZero();
firewall.register(createGenericFreeRecord());

const catalog = new InMemoryProviderCatalog();
catalog.register(new RecoveryScriptedProvider());

const runtime = createAgentRuntime({
  sessionId: "recovery-session",
  eventStore,
  persistence,
  firewall,
  providerCatalog: catalog,
  workspacePath: repoDir,
});
await runtime.init();

const manager = createSubagentManager({ persistence, agentRuntime: runtime, r1Enabled: true });
const adapter = createWorkspaceEventAdapter({ sessionId: "recovery-session", eventStore, persistence });

const crashToolExecutor = async (name) => {
  if (name === "list_files" && testCase === "kill-readonly-unobserved") crash();
  if (name === "write_file" && testCase === "kill-write-unobserved") crash();
  if (name === "run_command" && testCase === "kill-command-unobserved") crash();
  return undefined;
};

const result = await manager.spawnChildAgent({
  parentRunId: "parent-recovery",
  sessionId: "recovery-session",
  agentId: testCase === "kill-reviewer" ? "reviewer" : "coder",
  task: "Fix math.mjs so the failing test passes.",
  workspacePath: repoDir,
  adapter,
  customToolExecutor: crashToolExecutor,
});

process.stderr.write(`[fixture] case=${testCase} status=${result?.status} summary=${result?.summary}\n`);
process.exit(result?.status === "completed" ? 0 : 3);
