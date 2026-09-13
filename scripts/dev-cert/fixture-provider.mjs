import crypto from "node:crypto";

/**
 * Fixture managed-free provider ("devpool") for the zero-setup R1 local certification rig.
 *
 * This is a SCRIPTED UPSTREAM MODEL, not a real LLM. It exists because a dev machine has no
 * legitimately shareable upstream free capacity (spec §77: personal/trial capacity must never be
 * pooled as CodeForge-managed Free). It enters the hosted pool through the REAL production path —
 * CloudProviderRegistry discovery, ForgeZero $0 verification, 8-Bit compact qualification,
 * legal-policy eligibility, per-user entitlement and the usage ledger — and it answers through the
 * real tool-call protocol so the real agent loop, ForgeVerify and the completion gate all execute.
 *
 * Script (driven by conversation state, generalizes to any small single-file task):
 *   1. no tool results yet        -> read_file on the path found in the user's message
 *   2. file read, no edit yet     -> edit_file replacing DEVPOOL_EDIT_OLD with DEVPOOL_EDIT_NEW
 *   3. edit applied               -> run_command with DEVPOOL_TEST_COMMAND
 *   4. command result observed    -> final summary text
 * Qualification probes (read src/calc.ts / fix a-b / structured JSON) are answered deterministically.
 */

export const FIXTURE_PROVIDER_ID = "devpool";
export const FIXTURE_MODEL_ID = "cert-coder";

const env = (name, fallback) => process.env[name]?.trim() || fallback;

const SCRIPT = {
  editOld: env("DEVPOOL_EDIT_OLD", "return a - b;"),
  editNew: env("DEVPOOL_EDIT_NEW", "return a + b;"),
  testCommand: env("DEVPOOL_TEST_COMMAND", "node test.js"),
};

function lastOf(messages, predicate) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (predicate(messages[i])) return messages[i];
  }
  return undefined;
}

function findPathInText(text) {
  const matches = text.match(/[\w.-]+(?:[\/\\][\w.-]+)+\.\w{1,4}|\b(?:src|lib|app|test)\/[\w./\\-]+\.\w{1,4}|\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|py|rs|go|java)\b/g);
  return matches?.[0]?.replace(/\\/g, "/") ?? null;
}

function isJsonOnlyRequest(messages) {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return /json only/i.test(system) && /"files"/.test(user);
}

function structuredAnswer() {
  return '{"files":["src/calc.ts","test/calc.test.ts"],"verified":true}';
}

function conversationState(messages) {
  const toolResults = messages.filter((m) => m.role === "tool");
  const readResults = toolResults.filter((m) => !/exit code|stdout|stderr/i.test(m.content) || /export function/.test(m.content));
  const commandResults = toolResults.filter((m) => /exit code|stdout/i.test(m.content));
  const edited = toolResults.some((m) => /edit|updated|replaced|applied/i.test(m.content) && !/failed|error/i.test(m.content));
  return {
    toolResultCount: toolResults.length,
    hasRead: readResults.length > 0 && !commandResults.some((c) => readResults.includes(c)),
    hasEdited: edited,
    hasCommandResult: commandResults.length > 0,
    lastToolContent: toolResults.at(-1)?.content ?? "",
  };
}

function decide(req) {
  const messages = req.messages ?? [];
  const userText = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  if (req.tools && req.tools.length > 0 && !isJsonOnlyRequest(messages)) {
    const state = conversationState(messages);

    if (state.hasCommandResult) {
      const failed = /\b(?:1|2)\s*;\s*exit code|failed|FAIL/i.test(state.lastToolContent);
      return {
        toolCall: failed
          ? { name: "run_command", args: { command: SCRIPT.testCommand } }
          : null,
        text: failed
          ? "The test run still fails; re-running once."
          : "Task complete. The defect is fixed, the affected file was edited with an exact span replacement, and the test suite passes. Changes are in the working tree for review.",
      };
    }

    if (state.hasEdited) {
      return { toolCall: { name: "run_command", args: { command: SCRIPT.testCommand } }, text: "" };
    }

    const targetPath = findPathInText(userText) || lastOf(messages, (m) => m.role === "assistant" && typeof m.content === "string")?.content || "src/calc.ts";

    if (!state.hasRead) {
      const readPath = /read_file/i.test(userText) || state.toolResultCount === 0 ? findPathInText(userText) ?? "src/calc.ts" : "src/calc.ts";
      return { toolCall: { name: "read_file", args: { path: readPath } }, text: "" };
    }

    if (state.lastToolContent.includes(SCRIPT.editOld) || /a - b|subtracts/i.test(state.lastToolContent) || /fix|bug/i.test(userText)) {
      const oldText = state.lastToolContent.includes(SCRIPT.editOld) ? SCRIPT.editOld : /a - b/.test(state.lastToolContent) ? "return a - b;" : SCRIPT.editOld;
      return { toolCall: { name: "edit_file", args: { path: targetPath, oldText, newText: SCRIPT.editNew } }, text: "" };
    }

    return { toolCall: { name: "edit_file", args: { path: targetPath, oldText: SCRIPT.editOld, newText: SCRIPT.editNew } }, text: "" };
  }

  if (isJsonOnlyRequest(messages)) {
    return { toolCall: null, text: structuredAnswer() };
  }

  const path = findPathInText(userText);
  if (req.tools && req.tools.length > 0 && path) {
    return { toolCall: { name: "read_file", args: { path } }, text: "" };
  }
  return { toolCall: null, text: "devpool fixture model: no scripted action for this request." };
}

export function createFixtureManagedAdapter() {
  return {
    providerId: FIXTURE_PROVIDER_ID,
    isTestProvider: false,
    async listModels() {
      return [
        {
          modelId: FIXTURE_MODEL_ID,
          displayName: "Cert Coder (devpool fixture)",
          contextWindow: 131_072,
          capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
          isFree: true,
          freeStatus: "verified_free",
        },
      ];
    },
    async *streamChat(req, signal) {
      const decision = decide(req);
      const started = Date.now();

      if (decision.toolCall) {
        const callId = `call_${crypto.randomBytes(6).toString("hex")}`;
        yield { type: "tool_call_started", toolCallId: callId, toolName: decision.toolCall.name };
        const args = JSON.stringify(decision.toolCall.args);
        yield { type: "tool_call_delta", toolCallId: callId, delta: args };
        yield { type: "tool_call_completed", toolCallId: callId, toolName: decision.toolCall.name, arguments: args };
        yield {
          type: "usage",
          usage: { inputTokens: 64, outputTokens: 24, totalTokens: 88, cachedInputTokens: 0, cacheWriteTokens: 0 },
        };
        yield { type: "finish", finishReason: "tool_calls" };
      } else {
        const text = decision.text;
        const chunkSize = 48;
        for (let i = 0; i < text.length; i += chunkSize) {
          if (signal?.aborted) throw new Error("Aborted");
          yield { type: "text_delta", delta: text.slice(i, i + chunkSize) };
        }
        yield {
          type: "usage",
          usage: { inputTokens: 48, outputTokens: Math.max(1, Math.ceil(text.length / 4)), totalTokens: 48 + Math.max(1, Math.ceil(text.length / 4)), cachedInputTokens: 0, cacheWriteTokens: 0 },
        };
        yield { type: "finish", finishReason: "stop" };
      }

      if (Date.now() - started < 0) throw new Error("unreachable");
    },
    async chat(req) {
      const decision = decide(req);
      const message = decision.toolCall
        ? {
            role: "assistant",
            content: "",
            toolCalls: [{ id: `call_${crypto.randomBytes(6).toString("hex")}`, type: "function", function: { name: decision.toolCall.name, arguments: JSON.stringify(decision.toolCall.args) } }],
          }
        : { role: "assistant", content: decision.text };
      return {
        id: `chatcmpl_${crypto.randomBytes(6).toString("hex")}`,
        model: req.model,
        choices: [{ index: 0, message, finishReason: decision.toolCall ? "tool_calls" : "stop" }],
        usage: { inputTokens: 48, outputTokens: 24, totalTokens: 72 },
      };
    },
    async healthCheck() {
      return { status: "available" };
    },
  };
}
