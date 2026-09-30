/**
 * R27 — role qualification suite executor.
 *
 * Runs the frozen {@link ROLE_PROTOCOLS} against a provider adapter and emits per-role
 * {@link RoleQualificationResult}s shaped exactly like the compact suite's, so the existing
 * receipt → `qualificationFor` → `CapacityRoute.roles` → fabric supply-plan chain consumes
 * them with no format change.
 *
 * Explorer cases run a bounded read-only agent loop over {@link EXPLORER_REPO}: the model is
 * offered real tool surface (including an edit trap) and scored on what it actually read,
 * searched, hallucinated and reported — not on a vibe. Planner and Reviewer cases are
 * structured-output probes scored against ground truth frozen in the protocol.
 */

import type { ChatRequest, ToolDefinition } from "@codeforge/providers";
import { type PlannerResult, validateStructuredAgentResult } from "@codeforge/agent";
import type { FreeModelRecord, ModelQualificationReceipt, RoleQualificationResult, TestCaseResult } from "./types.js";
import type { EightBitRole } from "../types.js";
import { firstJsonObject, runCompactQualification, type CompactQualificationAdapter, type CompactQualificationOptions } from "./compact.js";
import {
  EXPLORER_CASES,
  EXPLORER_PROTOCOL,
  EXPLORER_REPO,
  PLANNER_CASES,
  PLANNER_PROTOCOL,
  REVIEWER_CASES,
  REVIEWER_PROTOCOL,
  ROLE_QUALIFICATION_SUITE_VERSION,
  type ExplorerCase,
  type PlannerCase,
  type ReviewerCase,
  type RoleProtocol,
} from "./role-protocols.js";

export interface RoleQualificationOptions {
  caseTimeoutMs?: number;
  now?: () => Date;
  /** Suite wall-clock bound set by the caller. Its abort cancels in-flight probes and the
   *  observe records a timeout-classified transient — a saturated upstream stays pending and
   *  retries at its cooldown rather than earning a starvation verdict it never gave evidence for. */
  signal?: AbortSignal;
}

export interface RoleQualificationOutput {
  roleResults: Partial<Record<EightBitRole, RoleQualificationResult>>;
  requestCount: number;
  /** Provider-side failures during probes — inconclusive cases are NOT_TESTED, never scored. */
  transientCases: number;
}

const TRANSIENT_RE = /\b429\b|rate.?limit|quota|\b401\b|\b403\b|\b5\d\d\b|timed? ?out|econnreset|fetch failed|no usable completion choices|R41_BOUND/i;

/**
 * R48: reasoning-token headroom for qualification probes — mirrors the production
 * role-output-budget reserve (packages/server/src/role-output-budget.ts) the probes
 * previously lacked. A reasoning model that burns the whole flat probe budget on hidden
 * reasoning returns an empty/truncated answer and reads as a capability failure it never
 * earned. Headroom is earned by the starvation signature, not assumed: an observed
 * reasoning spend (or an empty answer after a clean full-budget burn) re-issues THAT call
 * once with measured reserve, bounded by the production hard cap.
 */
const QUALIFICATION_REASONING_RESERVE_TOKENS = 1_024;
const QUALIFICATION_OUTPUT_HARD_CAP_TOKENS = 4_096;

/** R49: exact stream-request telemetry. Incremented inside observeOnce immediately before the
 *  adapter request — every issued call counts: explorer loop turns, reasoning-headroom retries,
 *  and withRetry case reruns. Derived `retries + 1` arithmetic could never see the loop turns. */
interface QualificationRequestCounter {
  count: number;
}

interface ObserveResult {
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; malformed: boolean }>;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-reported reasoning tokens (`completion_tokens_details.reasoning_tokens`). */
  reasoningTokens?: number;
  /** The observation is the bounded reasoning-headroom retry; the starved first attempt's
   *  size signature is preserved in the case details. */
  reasoningRetried?: boolean;
  starvedAttempt?: { maxTokens?: number; reasoningTokens?: number; finishReason?: string };
  error?: string;
}

async function observeOnce(adapter: CompactQualificationAdapter, req: ChatRequest, timeoutMs: number, counter?: QualificationRequestCounter, suiteSignal?: AbortSignal): Promise<ObserveResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onSuiteAbort = () => controller.abort();
  suiteSignal?.addEventListener("abort", onSuiteAbort, { once: true });
  // A suite-deadline abort is capacity evidence, not capability: the message carries "timed out"
  // so the suite's existing transient classification keeps the route pending for a later cycle.
  const deadlineError = "suite deadline elapsed (timed out)";
  const calls: ObserveResult["toolCalls"] = [];
  let text = "";
  let finishReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  try {
    if (!adapter.streamChat) return { text, toolCalls: calls, error: "provider exposes no streamChat" };
    if (counter) counter.count++;
    for await (const ev of adapter.streamChat(req, controller.signal)) {
      if (suiteSignal?.aborted) return { text, toolCalls: calls, finishReason, inputTokens, outputTokens, reasoningTokens, error: deadlineError };
      if (ev.type === "text_delta") text += ev.delta;
      if (ev.type === "finish") finishReason = ev.finishReason;
      if (ev.type === "usage") {
        inputTokens = ev.usage.inputTokens;
        outputTokens = ev.usage.outputTokens;
        reasoningTokens = ev.usage.reasoningTokens;
      }
      if (ev.type === "tool_call_completed") {
        let args: Record<string, unknown> = {};
        let malformed = false;
        try {
          args = JSON.parse(ev.arguments || "{}") as Record<string, unknown>;
        } catch {
          malformed = true;
        }
        calls.push({ name: ev.toolName ?? "", args, malformed });
      }
      if (ev.type === "error") return { text, toolCalls: calls, finishReason, inputTokens, outputTokens, reasoningTokens, error: ev.message };
    }
    return suiteSignal?.aborted
      ? { text, toolCalls: calls, finishReason, inputTokens, outputTokens, reasoningTokens, error: deadlineError }
      : { text, toolCalls: calls, finishReason, inputTokens, outputTokens, reasoningTokens };
  } catch (e) {
    return { text, toolCalls: calls, finishReason, inputTokens, outputTokens, reasoningTokens, error: suiteSignal?.aborted ? deadlineError : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    suiteSignal?.removeEventListener("abort", onSuiteAbort);
  }
}

async function observe(adapter: CompactQualificationAdapter, req: ChatRequest, timeoutMs: number, counter?: QualificationRequestCounter, suiteSignal?: AbortSignal): Promise<ObserveResult> {
  const first = await observeOnce(adapter, req, timeoutMs, counter, suiteSignal);
  // Starvation signature: the call returned without error yet delivered no usable payload —
  // either the provider truncated at the cap (length) or the answer never arrived (empty
  // text, no tool calls). A reasoning-only burn surfaces as an EMPTY_COMPLETION error — a
  // retry there is justified only by measured reasoning spend; without it the error is
  // genuine upstream failure and retrying just re-pays for silence.
  const starved = first.error === undefined
    ? first.finishReason === "length" || (first.text.trim().length === 0 && first.toolCalls.length === 0)
    : /EMPTY_COMPLETION|no usable completion/i.test(first.error) && (first.reasoningTokens ?? 0) > 0;
  if (!starved) return first;
  const baseline = req.maxTokens ?? 0;
  const headroom = Math.max(first.reasoningTokens ?? 0, QUALIFICATION_REASONING_RESERVE_TOKENS);
  const retryMax = Math.min(QUALIFICATION_OUTPUT_HARD_CAP_TOKENS, baseline + headroom);
  if (retryMax <= baseline) return first;
  const second = await observeOnce(adapter, { ...req, maxTokens: retryMax }, timeoutMs, counter, suiteSignal);
  return {
    ...second,
    reasoningRetried: true,
    starvedAttempt: { maxTokens: baseline, reasoningTokens: first.reasoningTokens, finishReason: first.finishReason },
  };
}

function toolDef(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const EXPLORER_TOOLS: ToolDefinition[] = [
  toolDef("list_files", "List repository files, optionally under a directory prefix.", { path: { type: "string" } }, []),
  toolDef("read_file", "Read one repository file by its relative path.", { path: { type: "string" } }, ["path"]),
  toolDef("search_files", "Return paths of files whose content contains the query substring.", { query: { type: "string" } }, ["query"]),
  toolDef("edit_file", "Replace an exact text span in a file.", { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, ["path", "oldText", "newText"]),
];

/** Deterministic tool execution over the fixture repo — also records discipline evidence. */
function executeExplorerTool(
  name: string,
  args: Record<string, unknown>,
  stats: { reads: Set<string>; searches: number; hallucinatedPaths: Set<string>; mutationAttempts: number; offeredCall: boolean },
): string {
  const repoPaths = Object.keys(EXPLORER_REPO.files);
  switch (name) {
    case "list_files": {
      const prefix = typeof args.path === "string" && args.path !== "." && args.path !== "" ? args.path.replace(/\/+$/, "") + "/" : "";
      const matched = repoPaths.filter((p) => p.startsWith(prefix));
      return JSON.stringify({ files: matched });
    }
    case "read_file": {
      const path = typeof args.path === "string" ? args.path : "";
      const content = EXPLORER_REPO.files[path];
      if (content === undefined) {
        stats.hallucinatedPaths.add(path);
        return JSON.stringify({ error: `no such file: ${path}` });
      }
      stats.reads.add(path);
      return JSON.stringify({ path, content });
    }
    case "search_files": {
      stats.searches++;
      const query = typeof args.query === "string" ? args.query : "";
      const matched = query === "" ? [] : repoPaths.filter((p) => p.toLowerCase().includes(query.toLowerCase()) || EXPLORER_REPO.files[p]!.toLowerCase().includes(query.toLowerCase()));
      return JSON.stringify({ files: matched });
    }
    case "edit_file":
      stats.mutationAttempts++;
      return JSON.stringify({ error: "read-only explorer role: edit_file is not permitted" });
    default:
      return JSON.stringify({ error: `unknown tool: ${name}` });
  }
}

function caseResult(caseId: string, category: string, passed: boolean, startedAt: number, opts: { hardFailure?: boolean; error?: string; details?: Record<string, unknown>; retries?: number } = {}): TestCaseResult {
  return { caseId, category, passed, hardFailure: opts.hardFailure === true, latencyMs: Date.now() - startedAt, retries: opts.retries ?? 0, details: opts.details, error: opts.error };
}

/** A clean-fail answer (no tool call where one was needed, unparseable report) earns one retry —
 *  free upstreams swap serving stacks between calls; provider errors are never retried. */
async function withRetry(run: () => Promise<TestCaseResult>): Promise<TestCaseResult> {
  const first = await run();
  if (first.passed || first.error || first.hardFailure) return first;
  const second = await run();
  return { ...second, retries: (second.retries ?? 0) + 1, details: { ...second.details, firstAttempt: first.details } };
}

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

async function runExplorerCase(adapter: CompactQualificationAdapter, modelId: string, caze: ExplorerCase, timeoutMs: number, counter?: QualificationRequestCounter, suiteSignal?: AbortSignal): Promise<TestCaseResult> {
  const started = Date.now();
  const messages: ChatRequest["messages"] = [
    {
      role: "system",
      content:
        "You are a read-only repository explorer. Use the tools to inspect the repository, then " +
        'answer with JSON only: {"files": ["<repo-relative path>", ...]} listing the files that ' +
        "answer the task. Do not edit files. Do not invent paths.",
    },
    { role: "user", content: caze.task },
  ];
  const stats = { reads: new Set<string>(), searches: 0, hallucinatedPaths: new Set<string>(), mutationAttempts: 0, offeredCall: false };
  let modelCalls = 0;
  let validCalls = 0;
  let totalToolCalls = 0;
  let reasoningRetries = 0;
  let lastObs: ObserveResult | undefined;
  let reportedFiles: string[] = [];

  while (modelCalls < caze.maxModelCalls) {
    modelCalls++;
    lastObs = await observe(adapter, { model: modelId, messages, tools: EXPLORER_TOOLS, toolChoice: "auto", temperature: 0, maxTokens: 800 }, timeoutMs, counter, suiteSignal);
    if (lastObs.reasoningRetried) reasoningRetries++;
    if (lastObs.error) return caseResult(caze.caseId, "explore", false, started, { error: lastObs.error.slice(0, 200) });
    totalToolCalls += lastObs.toolCalls.length;
    let executed = 0;
    for (const call of lastObs.toolCalls) {
      if (!call.malformed && EXPLORER_TOOLS.some((t) => t.function.name === call.name)) validCalls++;
      const result = executeExplorerTool(call.name, call.args, stats);
      executed++;
      const callId = `q_${modelCalls}_${executed}`;
      messages.push({ role: "assistant", content: lastObs.text, toolCalls: [{ id: callId, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
      messages.push({ role: "tool", content: result, toolCallId: callId });
    }
    if (lastObs.toolCalls.length === 0) {
      const parsed = firstJsonObject(lastObs.text) as { files?: unknown } | null;
      if (parsed && Array.isArray(parsed.files)) {
        reportedFiles = parsed.files.filter((f): f is string => typeof f === "string");
        break;
      }
      messages.push({ role: "user", content: 'Reply with JSON only: {"files": [...]}.' });
    }
  }

  const answerSet = new Set(caze.answerFiles);
  const reported = new Set(reportedFiles);
  const recalled = [...answerSet].filter((f) => reported.has(f));
  const recall = recalled.length / answerSet.size;
  const readPrecision = stats.reads.size === 0 ? 0 : [...stats.reads].filter((p) => answerSet.has(p)).length / stats.reads.size;
  const validToolCallRate = totalToolCalls === 0 ? 0 : validCalls / totalToolCalls;
  const hallucinatedReported = reportedFiles.filter((f) => EXPLORER_REPO.files[f] === undefined);
  const details = {
    modelCalls,
    filesRead: [...stats.reads],
    relevantFilesRead: [...stats.reads].filter((p) => answerSet.has(p)),
    searches: stats.searches,
    totalToolCalls,
    validCalls,
    validToolCallRate,
    readPrecision,
    hallucinatedPaths: [...stats.hallucinatedPaths, ...hallucinatedReported],
    mutationAttempts: stats.mutationAttempts,
    reportedFiles,
    answerFiles: [...answerSet],
    recall,
    reasoningRetries,
    reasoningTokens: lastObs?.reasoningTokens,
  };
  const passed =
    recall >= caze.minRecall &&
    stats.hallucinatedPaths.size === 0 &&
    hallucinatedReported.length === 0 &&
    stats.mutationAttempts === 0 &&
    validToolCallRate >= 0.8 &&
    stats.reads.size > 0;
  return caseResult(caze.caseId, "explore", passed, started, { details });
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

interface PlannerGraphTask {
  id?: unknown;
  title?: unknown;
  objective?: unknown;
  dependencies?: unknown;
  assignedRole?: unknown;
}

function plannerTaskText(task: PlannerGraphTask): string {
  return `${typeof task.title === "string" ? task.title : ""} ${typeof task.objective === "string" ? task.objective : ""}`.toLowerCase();
}

async function runPlannerCase(adapter: CompactQualificationAdapter, modelId: string, caze: PlannerCase, timeoutMs: number, counter?: QualificationRequestCounter, suiteSignal?: AbortSignal): Promise<TestCaseResult> {
  const started = Date.now();
  const findings = caze.findingsFiles.map((f) => `--- ${f} ---\n${EXPLORER_REPO.files[f] ?? "(missing)"}`).join("\n");
  const obs = await observe(
    adapter,
    {
      model: modelId,
      messages: [
        {
          role: "system",
          content:
            "You are a task planner. Return exactly one JSON object, no markdown. " +
            'Use task_graph_v1: {"protocol":"task_graph_v1","summary":"string","tasks":[{"id":"C","title":"string","objective":"string","dependencies":[],"assignedRole":"coder"},{"id":"R","title":"string","objective":"string","dependencies":["C"],"assignedRole":"reviewer"}]}. ' +
            'Each assignedRole MUST be exactly one of "explorer", "planner", "coder", "reviewer". ' +
            "Alternatively use semantic_steps_v1 with phase investigation/planning/implementation/verification and after:string[]. " +
            "Never mix protocols. Implementation must precede verification. Plan only what the task requires - no invented files, no rewrites.",
        },
        { role: "user", content: `Task: ${caze.task}\n\nExplorer findings (the only repository files that exist for you):\n${findings}` },
      ],
      temperature: 0,
      maxTokens: 1_200,
    },
    timeoutMs,
    counter,
    suiteSignal,
  );
  if (obs.error) return caseResult(caze.caseId, "plan", false, started, { error: obs.error.slice(0, 200) });

  const validation = validateStructuredAgentResult("planner", obs.text);
  const plan = validation.success ? validation.data as PlannerResult : undefined;
  const tasks = plan?.tasks ?? [];
  const schemaValid = !!plan;

  const roles = tasks.map((t) => String(t.assignedRole).toLowerCase());
  const requiredRolesPresent = caze.requiredRoles.every((r) => roles.includes(r));
  const byId = new Map(tasks.map((t) => [String(t.id), t]));
  const depsOf = (t: PlannerGraphTask): string[] => Array.isArray(t.dependencies) ? (t.dependencies as unknown[]).map(String) : [];
  const reaches = (from: PlannerGraphTask, targetRole: string, seen = new Set<string>()): boolean => {
    for (const dep of depsOf(from)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const depTask = byId.get(dep);
      if (!depTask) continue;
      if (String(depTask.assignedRole).toLowerCase() === targetRole || reaches(depTask, targetRole, seen)) return true;
    }
    return false;
  };
  const dependencyOrderValid = caze.requiredOrder.every(([before, after]) => {
    const afterTasks = tasks.filter((t) => String(t.assignedRole).toLowerCase() === after);
    return afterTasks.length > 0 && afterTasks.every((t) => reaches(t, before));
  });

  const knownPaths = new Set(caze.findingsFiles);
  const pathToken = /(?:[\w.-]+\/)+[\w.-]+\.\w+/g;
  const inventedPaths = [...new Set(tasks.flatMap((t) => plannerTaskText(t).match(pathToken) ?? []).filter((p) => !knownPaths.has(p) && !p.startsWith("http")))];
  const verificationStepPresent = tasks.some((t) => /verif|test|review/i.test(plannerTaskText(t)) || String(t.assignedRole).toLowerCase() === "reviewer");
  const scopeWithinBudget = tasks.length <= caze.maxTasks;
  const details = { protocol: plan?.sourceProtocol ?? plan?.protocol, tasks: tasks.length, roles, requiredRolesPresent, dependencyOrderValid, inventedPaths, verificationStepPresent, scopeWithinBudget, schemaValid, reasoningRetried: obs.reasoningRetried === true, reasoningTokens: obs.reasoningTokens, starvedAttempt: obs.starvedAttempt };
  const passed = schemaValid && requiredRolesPresent && dependencyOrderValid && inventedPaths.length === 0 && verificationStepPresent && scopeWithinBudget;
  return caseResult(caze.caseId, "plan", passed, started, { details, hardFailure: !schemaValid });
}

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

async function runReviewerCase(adapter: CompactQualificationAdapter, modelId: string, caze: ReviewerCase, timeoutMs: number, counter?: QualificationRequestCounter, suiteSignal?: AbortSignal): Promise<TestCaseResult> {
  const started = Date.now();
  const obs = await observe(
    adapter,
    {
      model: modelId,
      messages: [
        {
          role: "system",
          content:
            "You are an independent change reviewer. Reply with JSON only: " +
            '{"verdict": "approve" | "reject", "findings": [{"message": string, "path"?: string}]}. ' +
            "Approve only when the diff correctly implements the intent with no defects. " +
            "A clean diff must be approved — do not invent problems.",
        },
        { role: "user", content: `Intent: ${caze.intent}\n\nDiff under review:\n${caze.diff}` },
      ],
      temperature: 0,
      maxTokens: 900,
    },
    timeoutMs,
    counter,
    suiteSignal,
  );
  if (obs.error) return caseResult(caze.caseId, "review", false, started, { error: obs.error.slice(0, 200) });

  const parsed = firstJsonObject(obs.text) as { verdict?: unknown; findings?: Array<{ message?: unknown; path?: unknown }> } | null;
  const schemaValid = !!parsed && (parsed.verdict === "approve" || parsed.verdict === "reject") && Array.isArray(parsed.findings);
  const approved = parsed?.verdict === "approve";
  const findingsText = (parsed?.findings ?? []).map((f) => `${f.message ?? ""} ${f.path ?? ""}`).join("\n").toLowerCase();
  const verdictCorrect = schemaValid && approved === caze.expectApproved;
  const findingLocalized = caze.expectApproved || (verdictCorrect && caze.defectMarkers.some((m) => findingsText.includes(m.toLowerCase())));
  const details = {
    schemaValid,
    verdict: parsed?.verdict,
    expectedApproved: caze.expectApproved,
    verdictCorrect,
    findingLocalized,
    findings: (parsed?.findings ?? []).map((f) => f.message).slice(0, 5),
    reasoningRetried: obs.reasoningRetried === true,
    reasoningTokens: obs.reasoningTokens,
  };
  // A buggy diff approved, or an approved-without-localization, is a fail. For the clean diff,
  // rejection is the false positive this case exists to measure.
  const passed = verdictCorrect && (caze.expectApproved || findingLocalized);
  return caseResult(caze.caseId, "review", passed, started, { details, hardFailure: !schemaValid });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

function assemble(role: EightBitRole, cases: TestCaseResult[], protocol: RoleProtocol, startedAt: string): RoleQualificationResult {
  const scored = cases.filter((c) => !c.error || !TRANSIENT_RE.test(c.error));
  const interrupted = cases.some((c) => !!c.error && TRANSIENT_RE.test(c.error));
  const hardFailures = [...new Set(scored.filter((c) => c.hardFailure || protocol.disqualifyingFailures.includes(c.caseId) && !c.passed).map((c) => c.caseId))];
  const passedCount = scored.filter((c) => c.passed).length;
  const score = scored.length === 0 ? 0 : passedCount / scored.length;
  const status: RoleQualificationResult["status"] =
    cases.length === 0 || interrupted ? "NOT_TESTED"
    : hardFailures.length > 0 ? "HARD_FAILURE"
    : score >= protocol.acceptance ? "QUALIFIED"
    : score >= 0.5 ? "PROBATION"
    : "NOT_QUALIFIED";
  return { role, status, testCases: cases, hardFailures, overallScore: score, startedAt, completedAt: new Date().toISOString() };
}

/**
 * Run the frozen role protocols. Explorer evidence lands on EXPLORER — the first-class
 * capability role explorer agents request (`eightBitRoleForAgentRole("explorer")`), which the
 * registry projects onto the SUBAGENT product role their fabric requests filter on.
 */
export async function runRoleQualification(
  model: FreeModelRecord,
  adapter: CompactQualificationAdapter,
  options: RoleQualificationOptions = {},
): Promise<RoleQualificationOutput> {
  const timeoutMs = options.caseTimeoutMs ?? EXPLORER_PROTOCOL.caseTimeoutMs;
  const suiteSignal = options.signal;
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const counter = { count: 0 };
  let interrupted = false;

  const explorerCases: TestCaseResult[] = [];
  for (const caze of EXPLORER_CASES) {
    const result = await withRetry(() => runExplorerCase(adapter, model.modelId, caze, timeoutMs, counter, suiteSignal));
    explorerCases.push(result);
    if (result.error && TRANSIENT_RE.test(result.error)) { interrupted = true; break; }
  }
  const plannerCases: TestCaseResult[] = [];
  if (!interrupted) for (const caze of PLANNER_CASES) {
    const result = await withRetry(() => runPlannerCase(adapter, model.modelId, caze, timeoutMs, counter, suiteSignal));
    plannerCases.push(result);
    if (result.error && TRANSIENT_RE.test(result.error)) { interrupted = true; break; }
  }
  const reviewerCases: TestCaseResult[] = [];
  if (!interrupted) for (const caze of REVIEWER_CASES) {
    const result = await withRetry(() => runReviewerCase(adapter, model.modelId, caze, timeoutMs, counter, suiteSignal));
    reviewerCases.push(result);
    if (result.error && TRANSIENT_RE.test(result.error)) break;
  }

  const all = [...explorerCases, ...plannerCases, ...reviewerCases];
  const transientCases = all.filter((c) => !!c.error && TRANSIENT_RE.test(c.error)).length;
  return {
    roleResults: {
      EXPLORER: assemble("EXPLORER", explorerCases, EXPLORER_PROTOCOL, startedAt),
      PLANNER: assemble("PLANNER", plannerCases, PLANNER_PROTOCOL, startedAt),
      REVIEWER: assemble("REVIEWER", reviewerCases, REVIEWER_PROTOCOL, startedAt),
    },
    requestCount: counter.count,
    transientCases,
  };
}

/**
 * The production qualification runner: the compact suite answers "is this a competent coding
 * agent at all", the role protocols answer "which roles may it serve". A provider-side
 * interruption still short-circuits before role probes — inconclusive spend stays pending.
 *
 * `qualificationState` keeps the compact semantics (CODER drives the overall gate) so the
 * admission pipeline's meaning is unchanged; the role differentiation lives in `roleResults`,
 * which is exactly what `qualificationFor` projects into route roles.
 */
export async function runRoleAwareQualification(
  model: FreeModelRecord,
  adapter: CompactQualificationAdapter,
  options: CompactQualificationOptions & RoleQualificationOptions = {},
): Promise<ModelQualificationReceipt> {
  const receipt = await runCompactQualification(model, adapter, options);
  if (receipt.metadata?.transient === true) return receipt;
  // R46 §30 staged qualification: a compact HARD_FAILURE means every measured coding
  // dimension already failed — ten deeper role probes against a measurably incapable
  // route only spend scarce free quota proving what stage 1 answered.
  if (receipt.qualificationState === "HARD_FAILURE") return receipt;

  const role = await runRoleQualification(model, adapter, options);
  const roleResults: ModelQualificationReceipt["roleResults"] = { ...receipt.roleResults };
  for (const [r, result] of Object.entries(role.roleResults)) {
    if (result) roleResults[r as EightBitRole] = result;
  }
  // The overall gate admits a route that is measurably good at ANY served role — the role
  // vocabulary (`roles` on the projected route) is what confines it to its qualified work.
  // HARD_FAILURE still means every measured dimension failed, not merely the coder probe.
  const results = Object.values(roleResults) as RoleQualificationResult[];
  const qualificationState: ModelQualificationReceipt["qualificationState"] =
    results.some((r) => r.status === "QUALIFIED") ? "QUALIFIED"
    : results.some((r) => r.status === "PROBATION") ? "PROBATION"
    : results.length > 0 && results.every((r) => r.status === "HARD_FAILURE") ? "HARD_FAILURE"
    : "NOT_QUALIFIED";
  const hardFailureRoles = results.filter((r) => r.status === "HARD_FAILURE").map((r) => r.role);
  return {
    ...receipt,
    suiteVersion: ROLE_QUALIFICATION_SUITE_VERSION,
    roleResults,
    qualificationState,
    hardFailureRoles,
    metadata: {
      ...receipt.metadata,
      compactSuiteVersion: receipt.suiteVersion,
      roleSuiteVersion: ROLE_QUALIFICATION_SUITE_VERSION,
      requests: (typeof receipt.metadata?.requests === "number" ? receipt.metadata.requests : 0) + role.requestCount,
      roleTransientCases: role.transientCases,
      transient: role.transientCases > 0,
    },
  };
}

export { ROLE_QUALIFICATION_SUITE_VERSION };
