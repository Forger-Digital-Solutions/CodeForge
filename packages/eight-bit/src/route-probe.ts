import type { ChatRequest, ProviderAdapter, ToolDefinition } from "@codeforge/providers";
import { classifyFailure } from "./health.js";
import type { EightBitRouteHealthAuthority, NormalizedObservation, ProbeAdvice, ProbeAdviceInput } from "./route-health-authority.js";
import type { EightBitRole, FailureReason } from "./types.js";

/**
 * Production-shaped route probe (R23 §34, promoted from the bench script into the runtime).
 *
 * Bare probes proved non-predictive in R23 (5/5 clean bare probes minutes before a harness
 * collapse; 2/5 bare vs 0/2 production-shaped at 10:32Z): the shared NVIDIA worker queues heavy
 * agentic requests worse than a one-line ping. A probe therefore sends the real request shape —
 * the agent system prompt, the exact production tool schemas the caller passes in, a tool-result
 * turn, streaming, maxTokens 4096 — and the verdict is recorded as a normalized `probe_gate`
 * observation the health authority consumes directly. The probe never writes a file.
 */

export interface ProbeGateResult {
  providerId: string;
  modelId: string;
  recordedAt: string;
  n: number;
  served: number;
  verdict: "open" | "closed";
  probes: Array<{ startedAt: string; served: boolean; toolCalls: number; latencyMs: number; usage?: { inputTokens: number; outputTokens: number }; failure?: { reason: FailureReason; code?: string; status?: number; message: string } }>;
  observations: Array<Extract<NormalizedObservation, { kind: "probe_gate" }>>;
}

export interface ProbeGateOptions {
  /** Production tool schemas (the server exports `agentToolDefinitions()`); an empty list = no tools. */
  tools: ToolDefinition[];
  n?: number;
  spacingMs?: number;
  role?: EightBitRole;
  correlationId?: string;
  /** Test/clock seam. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Override the fixture-sized tool result (default ~6.5 KB of plausible source). */
  toolResultFixture?: string;
}

export const PROBE_SYSTEM_PROMPT =
  "You are CodeForge, an autonomous software engineering agent.\n\nYou help users with coding tasks by reading files, writing code, and executing commands.\n\nMake the smallest complete change, run verification appropriate to the risk, and stop using tools once the requirements and checks pass. Do not repeat successful reads, edits, or commands without new evidence.\n\nWork methodically and keep explanations concise and evidence-based.";

export function probeFixtureSource(): string {
  return Array.from({ length: 60 }, (_, i) => `export function helper${i}(a, b) {\n  // computes something for case ${i}\n  return (a * ${i}) + b - ${i % 7};\n}\n`).join("\n");
}

/** The exact request shape a probe sends (also used by tests / evidence to assert shape parity). */
export function productionShapedProbeRequest(modelId: string, tools: ToolDefinition[], fixture: string = probeFixtureSource()): ChatRequest {
  return {
    model: modelId,
    system: PROBE_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: "Task: `computeTotal` in src/cart.js returns the wrong sign for refunds. Fix it and run `npm test`. Only touch src/cart.js." },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/cart.js" }) } }] },
      { role: "tool", content: fixture, toolCallId: "call_1" },
      { role: "user", content: "Continue. Decide the next single tool call." },
    ],
    tools,
    maxTokens: 4096,
  };
}

export async function runProductionShapedProbeGate(adapter: ProviderAdapter, modelId: string, options: ProbeGateOptions): Promise<ProbeGateResult> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const n = Math.max(1, options.n ?? 2);
  const spacingMs = options.spacingMs ?? 8_000;
  const request = productionShapedProbeRequest(modelId, options.tools, options.toolResultFixture);
  const probes: ProbeGateResult["probes"] = [];
  const observations: ProbeGateResult["observations"] = [];
  for (let i = 0; i < n; i += 1) {
    if (i > 0) await sleep(spacingMs);
    const startedAt = now();
    const probe: ProbeGateResult["probes"][number] = { startedAt: new Date(startedAt).toISOString(), served: false, toolCalls: 0, latencyMs: 0 };
    try {
      for await (const event of adapter.streamChat(request, options.signal)) {
        if (event.type === "tool_call_completed") probe.toolCalls += 1;
        else if (event.type === "usage") probe.usage = { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens };
        else if (event.type === "error") {
          const error = Object.assign(new Error(event.message), { code: event.code, status: event.status });
          probe.failure = { reason: classifyFailure(error), code: event.code, status: event.status, message: String(event.message).slice(0, 300) };
          break;
        } else if (event.type === "finish") probe.served = probe.failure === undefined;
      }
    } catch (error) {
      const err = error as { code?: string; status?: number; message?: string };
      probe.failure = { reason: classifyFailure(error), code: err?.code, status: err?.status, message: String(err?.message ?? error).slice(0, 300) };
    }
    probe.latencyMs = now() - startedAt;
    probes.push(probe);
    observations.push({
      kind: "probe_gate",
      providerId: adapter.providerId,
      modelId,
      observedAt: new Date(startedAt).toISOString(),
      source: "probe",
      requestShape: "production",
      role: options.role,
      correlationId: options.correlationId,
      served: probe.served,
      latencyMs: probe.latencyMs,
      toolCalls: probe.toolCalls,
      failureReason: probe.failure?.reason,
      failureMessage: probe.failure?.message,
    });
  }
  const served = probes.filter((p) => p.served).length;
  return { providerId: adapter.providerId, modelId, recordedAt: new Date(now()).toISOString(), n, served, verdict: served === n ? "open" : "closed", probes, observations };
}

/**
 * Budgeted probe: consults the authority first (§9) and only spends when the advice says the
 * probe is worth it, then feeds the verdict back. Returns the advice when it declined.
 */
export async function probeRouteIfWorthwhile(
  authority: EightBitRouteHealthAuthority,
  adapter: ProviderAdapter,
  modelId: string,
  options: ProbeGateOptions & { advice?: ProbeAdviceInput; force?: boolean },
): Promise<{ probed: true; result: ProbeGateResult; advice: ProbeAdvice } | { probed: false; advice: ProbeAdvice }> {
  const advice = authority.probeAdvice(adapter.providerId, modelId, options.advice);
  if (!advice.shouldProbe && !options.force) return { probed: false, advice };
  const result = await runProductionShapedProbeGate(adapter, modelId, options);
  for (const observation of result.observations) authority.observe(observation);
  return { probed: true, result, advice };
}
