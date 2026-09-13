import type { ChatRequest, ChatResponse, StreamEvent, ToolDefinition } from "@codeforge/providers";
import type { FreeModelRecord, ModelQualificationReceipt, RoleQualificationResult, TestCaseResult } from "./types.js";
import type { EightBitRole } from "../types.js";

/**
 * Compact CodeForge qualification suite (R1 §10, §195).
 *
 * Three deterministic probes — tool-call correctness, patch/edit correctness, structured-output
 * compliance — that together cost ~3 requests and a few hundred tokens per route. Small enough to
 * run automatically when 8-Bit discovers a newly verified free route, strict enough that a model
 * which cannot emit a correct native tool call never becomes a PRIMARY_CODING_AGENT.
 *
 * Results are written as an ordinary {@link ModelQualificationReceipt} (suite version below) so
 * the existing persistence, expiry and display helpers apply unchanged.
 */
export const COMPACT_QUALIFICATION_SUITE_VERSION = "R1_FREE_CLOUD_COMPACT_V1";

export interface CompactQualificationAdapter {
  readonly providerId: string;
  chat?(req: ChatRequest): Promise<ChatResponse>;
  streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

export interface CompactQualificationOptions {
  timeoutMs?: number;
  now?: () => Date;
}

const READ_FILE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file from the repository. Returns its full contents.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Repository-relative path" } }, required: ["path"] },
  },
};

const EDIT_FILE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "edit_file",
    description: "Replace an exact text span in a file. oldText must match the file exactly.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
};

const SYSTEM = "You are CodeForge, an autonomous coding agent. Use the provided tools to act. Do not explain; call a tool.";

/** Output budget for one edit-probe turn (tool call arguments are small; see probeEdit). */
const EDIT_PROBE_MAX_TOKENS = 400;

const CALC_TS = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";

interface ToolCallObservation {
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  text: string;
  finishReason?: string;
  outputTokens?: number;
  error?: string;
  errorClass?: "bad_request" | "auth" | "rate_limited" | "other";
}

async function observe(adapter: CompactQualificationAdapter, req: ChatRequest, timeoutMs: number): Promise<ToolCallObservation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const calls: ToolCallObservation["toolCalls"] = [];
  let text = "";
  let finishReason: string | undefined;
  let outputTokens: number | undefined;
  try {
    for await (const ev of adapter.streamChat(req, controller.signal)) {
      if (ev.type === "text_delta") text += ev.delta;
      if (ev.type === "finish") finishReason = ev.finishReason;
      if (ev.type === "usage") outputTokens = ev.usage.outputTokens;
      if (ev.type === "tool_call_completed") {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(ev.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = { __malformed: ev.arguments };
        }
        calls.push({ name: ev.toolName, args });
      }
      if (ev.type === "error") return { toolCalls: calls, text, finishReason, outputTokens, error: ev.message, errorClass: classify(ev.message) };
    }
    return { toolCalls: calls, text, finishReason, outputTokens };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { toolCalls: calls, text, finishReason, outputTokens, error: message, errorClass: classify(message) };
  } finally {
    clearTimeout(timer);
  }
}

function classify(message: string): ToolCallObservation["errorClass"] {
  const m = message.toLowerCase();
  if (/\b401\b|\b403\b|unauthor|invalid api key/.test(m)) return "auth";
  if (/\b429\b|rate.?limit|quota/.test(m)) return "rate_limited";
  if (/\b400\b|bad request|unsupported|tool|function/.test(m)) return "bad_request";
  return "other";
}

function caseResult(caseId: string, category: string, passed: boolean, startedAt: number, opts: { hardFailure?: boolean; error?: string; details?: Record<string, unknown> } = {}): TestCaseResult {
  return {
    caseId,
    category,
    passed,
    hardFailure: opts.hardFailure === true,
    latencyMs: Date.now() - startedAt,
    retries: 0,
    details: opts.details,
    error: opts.error,
  };
}

/** Probe 1: a native tool call with the right tool and a sensible path argument. */
async function probeToolCall(adapter: CompactQualificationAdapter, modelId: string, timeoutMs: number): Promise<TestCaseResult> {
  const started = Date.now();
  const obs = await observe(
    adapter,
    {
      model: modelId,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: "Open src/calc.ts and report what it exports. Use the read_file tool." },
      ],
      tools: [READ_FILE_TOOL, EDIT_FILE_TOOL],
      toolChoice: "auto",
      temperature: 0,
      maxTokens: 200,
    },
    timeoutMs,
  );
  if (obs.error) {
    return caseResult("compact.tool_call", "tool_call", false, started, { hardFailure: obs.errorClass === "bad_request", error: obs.error.slice(0, 200) });
  }
  const call = obs.toolCalls.find((c) => c.name === "read_file");
  const path = typeof call?.args.path === "string" ? call.args.path : "";
  const passed = !!call && /(^|\/)src\/calc\.ts$/.test(path.replace(/\\/g, "/"));
  return caseResult("compact.tool_call", "tool_call", passed, started, { details: { toolCalls: obs.toolCalls.map((c) => c.name), path } });
}

/**
 * Probe 2: an exact-span edit that fixes the obvious bug. Runs a bounded mini agent loop (≤3 model
 * calls): a careful model that reads the file first gets the real tool result back, exactly as the
 * CodeForge loop would give it — reading before editing is correct behaviour, not a failure.
 */
async function probeEdit(adapter: CompactQualificationAdapter, modelId: string, timeoutMs: number, maxTokens = EDIT_PROBE_MAX_TOKENS): Promise<TestCaseResult> {
  const started = Date.now();
  const messages: ChatRequest["messages"] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: "src/calc.ts has a bug: the add function subtracts. Fix it so it returns a + b. Read the file if you need to, then use edit_file with an exact oldText." },
  ];
  let calls = 0;
  let lastToolNames: string[] = [];
  // Per-call shape only (tool names, finish reason, sizes): enough to tell a model that cannot
  // edit from a probe that starved it of output tokens, never the model's text.
  const turns: Array<{ toolCalls: string[]; finishReason?: string; textLength: number; outputTokens?: number }> = [];
  while (calls < 3) {
    calls++;
    const obs = await observe(adapter, { model: modelId, messages, tools: [READ_FILE_TOOL, EDIT_FILE_TOOL], toolChoice: "auto", temperature: 0, maxTokens }, timeoutMs);
    turns.push({ toolCalls: obs.toolCalls.map((c) => c.name), finishReason: obs.finishReason, textLength: obs.text.length, outputTokens: obs.outputTokens });
    if (obs.error) {
      return caseResult("compact.edit", "edit", false, started, { hardFailure: obs.errorClass === "bad_request", error: obs.error.slice(0, 200), details: { calls, turns } });
    }
    lastToolNames = obs.toolCalls.map((c) => c.name);
    const edit = obs.toolCalls.find((c) => c.name === "edit_file");
    if (edit) {
      const oldText = typeof edit.args.oldText === "string" ? edit.args.oldText : "";
      const newText = typeof edit.args.newText === "string" ? edit.args.newText : "";
      const path = typeof edit.args.path === "string" ? edit.args.path.replace(/\\/g, "/") : "";
      const passed = /src\/calc\.ts$/.test(path) && oldText.length > 0 && CALC_TS.includes(oldText) && oldText.includes("a - b") && newText.includes("a + b");
      return caseResult("compact.edit", "edit", passed, started, { details: { calls, path, oldTextMatches: oldText.length > 0 && CALC_TS.includes(oldText), oldTextHasBug: oldText.includes("a - b"), newTextOk: newText.includes("a + b"), turns } });
    }
    const read = obs.toolCalls.find((c) => c.name === "read_file");
    if (!read) break;
    // Feed the tool result back and let the model continue (same shape as the real loop).
    const callId = `call_${calls}`;
    messages.push({ role: "assistant", content: obs.text, toolCalls: [{ id: callId, type: "function", function: { name: "read_file", arguments: JSON.stringify(read.args) } }] });
    messages.push({ role: "tool", content: CALC_TS, toolCallId: callId });
  }
  return caseResult("compact.edit", "edit", false, started, { details: { calls, toolCalls: lastToolNames, turns } });
}

/** Diagnostic seam for certification harnesses: one edit-probe attempt (no retry) with its details. */
export async function probeCompactEditForDiagnostics(
  adapter: CompactQualificationAdapter,
  modelId: string,
  options: { timeoutMs?: number; maxTokens?: number } = {},
): Promise<TestCaseResult> {
  return probeEdit(adapter, modelId, options.timeoutMs ?? 45_000, options.maxTokens ?? EDIT_PROBE_MAX_TOKENS);
}

/** Probe 3: structured JSON output without tools. */
async function probeStructured(adapter: CompactQualificationAdapter, modelId: string, timeoutMs: number): Promise<TestCaseResult> {
  const started = Date.now();
  const obs = await observe(
    adapter,
    {
      model: modelId,
      messages: [
        { role: "system", content: "Respond with JSON only. No prose, no code fences." },
        { role: "user", content: 'Return a JSON object with keys "files" (array of strings) listing exactly ["src/calc.ts","test/calc.test.ts"] and "verified" (boolean true).' },
      ],
      temperature: 0,
      maxTokens: 120,
    },
    timeoutMs,
  );
  if (obs.error) return caseResult("compact.structured", "structured_output", false, started, { error: obs.error.slice(0, 200) });
  // Reasoning models may wrap the answer in prose; the first balanced JSON object is the answer.
  const parsed = firstJsonObject(obs.text) as { files?: unknown; verified?: unknown } | null;
  const passed = !!parsed && Array.isArray(parsed.files) && parsed.files.length === 2 && parsed.files[0] === "src/calc.ts" && parsed.verified === true;
  return caseResult("compact.structured", "structured_output", passed, started, { details: { textLength: obs.text.length, parsed: parsed !== null } });
}

function firstJsonObject(text: string): unknown | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function roleResult(role: EightBitRole, cases: TestCaseResult[], startedAt: string): RoleQualificationResult {
  const hard = cases.filter((c) => c.hardFailure).map((c) => c.caseId);
  const passedCount = cases.filter((c) => c.passed).length;
  const score = cases.length === 0 ? 0 : passedCount / cases.length;
  const status: RoleQualificationResult["status"] = hard.length > 0 ? "HARD_FAILURE" : score >= 0.99 ? "QUALIFIED" : score >= 0.5 ? "PROBATION" : "NOT_QUALIFIED";
  return { role, status, testCases: cases, hardFailures: hard, overallScore: score, startedAt, completedAt: new Date().toISOString() };
}

/**
 * Run the compact suite against one route and produce a receipt. Never throws for provider
 * errors — a route that cannot even answer records NOT_QUALIFIED/HARD_FAILURE with the reason.
 */
const TRANSIENT_RE = /\b429\b|rate.?limit|quota|\b401\b|\b403\b|\b5\d\d\b|timed? ?out|econnreset|fetch failed/i;

function isTransient(c: TestCaseResult): boolean {
  return !!c.error && TRANSIENT_RE.test(c.error);
}

/**
 * Free routes are shared, load-balanced pools whose upstream serving stack can differ between two
 * consecutive requests. One clean failure (a model answer without the expected tool call) earns a
 * single retry so a momentary upstream swap does not disqualify a capable model; two failures are
 * a real result. Provider errors are never retried here — they are transient and keep the route
 * pending for a later cycle.
 */
async function withRetry(run: () => Promise<TestCaseResult>): Promise<TestCaseResult> {
  const first = await run();
  if (first.passed || first.error || first.hardFailure) return first;
  const second = await run();
  return { ...second, retries: 1, details: { ...(second.details ?? {}), firstAttempt: first.details } };
}

export async function runCompactQualification(
  model: FreeModelRecord,
  adapter: CompactQualificationAdapter,
  options: CompactQualificationOptions = {},
): Promise<ModelQualificationReceipt> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const t0 = Date.now();

  const toolCase = await withRetry(() => probeToolCall(adapter, model.modelId, timeoutMs));
  // A rate-limited or auth-rejected first probe says nothing about the model; do not burn more.
  const abortEarly = isTransient(toolCase);
  const editCase = abortEarly ? caseResult("compact.edit", "edit", false, Date.now(), { error: "skipped: provider unavailable during qualification" }) : await withRetry(() => probeEdit(adapter, model.modelId, timeoutMs));
  const structuredCase = abortEarly || isTransient(editCase) ? caseResult("compact.structured", "structured_output", false, Date.now(), { error: "skipped: provider unavailable during qualification" }) : await probeStructured(adapter, model.modelId, timeoutMs);
  // Any provider-side interruption leaves the suite inconclusive: the receipt is marked transient
  // and the route stays pending rather than being scored on an answer it never gave.
  const transient = abortEarly || isTransient(editCase) || isTransient(structuredCase);

  const coder = roleResult("CODER", [toolCase, editCase], startedAt);
  const toolAgent = roleResult("TOOL_AGENT", [toolCase, editCase, structuredCase], startedAt);
  const analyst = roleResult("ANALYST", [structuredCase], startedAt);
  const roleResults: Record<string, RoleQualificationResult> = { CODER: coder, TOOL_AGENT: toolAgent, ANALYST: analyst };
  const hardFailureRoles = (Object.entries(roleResults) as Array<[EightBitRole, RoleQualificationResult]>).filter(([, r]) => r.status === "HARD_FAILURE").map(([role]) => role);

  const qualificationState: ModelQualificationReceipt["qualificationState"] = transient
    ? "NOT_QUALIFIED"
    : hardFailureRoles.length > 0
      ? "HARD_FAILURE"
      : coder.status === "QUALIFIED"
        ? "QUALIFIED"
        : coder.status === "PROBATION"
          ? "PROBATION"
          : "NOT_QUALIFIED";

  return {
    suiteVersion: COMPACT_QUALIFICATION_SUITE_VERSION,
    providerId: model.providerId,
    modelId: model.modelId,
    modelDisplayName: model.displayName,
    accessClass: model.accessClass ?? "UNKNOWN",
    freeStatus: model.freeStatus,
    roleResults,
    startedAt,
    completedAt: new Date().toISOString(),
    totalLatencyMs: Date.now() - t0,
    qualificationState,
    hardFailureRoles,
    metadata: { compact: true, requests: [toolCase, editCase, structuredCase].reduce((n, c) => n + (c.error?.startsWith("skipped") ? 0 : 1 + (c.retries ?? 0)), 0), transient },
  };
}
