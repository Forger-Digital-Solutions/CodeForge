// R41: real CodeForge orchestrator A/B on two locally verified engineering tasks.
// Production AgentRuntime/8-Bit routing, real catalog-proven free provider adapters.
// All rubric, fixture, selection and hard limits are frozen here before execution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createProviderCatalog, createOpenRouterAdapter, createMistralAdapter } from "../packages/providers/dist/index.js";
import { ForgeZero, createGenericFreeRecord } from "../packages/forge-zero/dist/index.js";
import { validateStructuredAgentResult } from "../packages/agent/dist/index.js";
import { createSessionPersistence, EventStore } from "../packages/sessions/dist/index.js";
import { createAgentRuntime, createAutonomousRunOrchestrator, createWorkspaceService } from "../packages/server/dist/index.js";

const OUT = process.argv[2] ?? "docs/evidence/r41-role-intelligence/R41-HETEROGENEOUS-AB.json";
const ONLY = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const TOPOLOGY = process.argv[4] ?? "fixed_r1";
if (!["normal", "fixed_r1"].includes(TOPOLOGY)) throw new Error("R41 only permits normal or fixed_r1 topology");
const preflight = JSON.parse(fs.readFileSync("docs/evidence/r41-role-intelligence/R41-LIVE-PREFLIGHT.json", "utf8"));
const r40 = JSON.parse(fs.readFileSync("docs/evidence/r40-free-intelligence/R40-LIVE-FREE-INVENTORY.json", "utf8"));
const profiles = JSON.parse(fs.readFileSync("docs/evidence/r41-role-intelligence/R41-ROLE-PROFILES.json", "utf8"));
const routes = profiles.routes.map(({ providerId, modelId }) => ({ providerId, modelId }));
for (const route of routes) {
  const entry = preflight.providers.find((p) => p.provider === route.providerId && p.httpStatus === 200)?.models?.find((m) => m.id === route.modelId);
  if (!entry || !r40.byProvider?.[route.providerId]?.includes(route.modelId)
    || route.providerId === "openrouter" && (!route.modelId.endsWith(":free") || Number(entry.pricing?.prompt) !== 0 || Number(entry.pricing?.completion) !== 0)) {
    throw new Error(`Fail closed: ${route.providerId}/${route.modelId} lacks current catalog + R40 free proof`);
  }
}
const TASKS = [
  {
    id: "bug-fix",
    goal: "Fix paginate(items, page, size) in src/pagination.mjs: page is 1-based and it must return the correct slice without adding dependencies.",
    files: {
      "src/pagination.mjs": "export function paginate(items, page, size) {\n  return items.slice(page * size, page * size + size);\n}\n",
      "tests/pagination.test.mjs": "import assert from 'node:assert/strict'; import {paginate} from '../src/pagination.mjs'; assert.deepEqual(paginate([1,2,3,4,5],2,2),[3,4]);\n",
      "README.md": "# Pagination fixture\n",
    },
    verify: ["node tests/pagination.test.mjs"],
    independent: async (root) => {
      const { paginate } = await import(pathToFileURL(path.join(root, "src/pagination.mjs")).href);
      return JSON.stringify([paginate([1, 2, 3, 4, 5], 1, 2), paginate([1, 2, 3, 4, 5], 2, 2), paginate([1, 2, 3, 4, 5], 3, 2)]) === "[[1,2],[3,4],[5]]";
    },
  },
  {
    id: "multi-file",
    goal: "Add a shared log helper in src/util.mjs that prefixes messages with '[app]'; use it in src/a.mjs and src/b.mjs instead of each direct console.log call. Keep both exports and behavior except the prefix.",
    files: {
      "src/util.mjs": "export const VERSION = '1.0';\n",
      "src/a.mjs": "export function a() { console.log('starting a'); }\n",
      "src/b.mjs": "export function b() { console.log('starting b'); }\n",
      "tests/log.test.mjs": "import assert from 'node:assert/strict'; import {a} from '../src/a.mjs'; import {b} from '../src/b.mjs'; let out=[]; const orig=console.log; console.log=(v)=>out.push(v); try{a();b()} finally{console.log=orig};assert.deepEqual(out,['[app] starting a','[app] starting b']);\n",
      "README.md": "# Logging fixture\n",
    },
    verify: ["node tests/log.test.mjs"],
    independent: async (root) => {
      const util = await import(pathToFileURL(path.join(root, "src/util.mjs")).href);
      const a = await import(pathToFileURL(path.join(root, "src/a.mjs")).href);
      const b = await import(pathToFileURL(path.join(root, "src/b.mjs")).href);
      const out = [];
      const original = console.log;
      console.log = (s) => out.push(s);
      try { a.a(); b.b(); } finally { console.log = original; }
      return typeof util.log === "function" && util.VERSION === "1.0" && JSON.stringify(out) === JSON.stringify(["[app] starting a", "[app] starting b"]);
    },
  },
];

const MAX_TOTAL_REQUESTS = 90;
const MAX_ARM_MS = 300_000;
const log = [];
const parked = new Set();
function roleOf(req) {
  const text = req.messages.filter((m) => m.role === "system").map((m) => m.content).join(" ");
  return /You are CodeForge Planner/i.test(text) ? "PLANNER"
    : /You are CodeForge Reviewer/i.test(text) ? "REVIEWER"
      : /You are CodeForge Coder/i.test(text) ? "CODER"
        : /You are CodeForge Explorer/i.test(text) ? "EXPLORER" : "UNKNOWN";
}
function wrap(real) {
  return {
    providerId: real.providerId, isTestProvider: false,
    listModels: () => real.listModels(), healthCheck: () => real.healthCheck(),
    chat: async (req) => {
      const started = performance.now();
      const entry = { providerId: real.providerId, modelId: req.model, role: roleOf(req), maxTokens: req.maxTokens, latencyMs: 0, toolCalls: 0, visibleChars: 0, finishReason: null, structuredError: null, errorCode: null, usage: null };
      log.push(entry);
      if (log.length > MAX_TOTAL_REQUESTS || parked.has(`${real.providerId}/${req.model}`)) throw new Error("R41_REQUEST_BOUND_OR_PARKED");
      try {
        const res = await real.chat(req);
        entry.usage = res.usage ?? null;
        if (entry.usage?.costUsd > 0) throw new Error("R41_POSITIVE_CHARGE_STOP");
        return res;
      } catch (e) {
        entry.errorCode = e?.code ?? "PROVIDER_ERROR";
        throw e;
      } finally { entry.latencyMs = Math.round(performance.now() - started); }
    },
    streamChat: async function* (req, signal) {
      const started = performance.now();
      const entry = { providerId: real.providerId, modelId: req.model, role: roleOf(req), maxTokens: req.maxTokens, latencyMs: 0, toolCalls: 0, visibleChars: 0, finishReason: null, structuredError: null, errorCode: null, usage: null };
      log.push(entry);
      if (log.length > MAX_TOTAL_REQUESTS || parked.has(`${real.providerId}/${req.model}`)) throw new Error("R41_REQUEST_BOUND_OR_PARKED");
      let visible = "";
      try {
        for await (const event of real.streamChat(req, signal)) {
          if (event.type === "text_delta") visible += event.delta;
          if (event.type === "usage") {
            entry.usage = event.usage;
            if (event.usage.costUsd > 0) throw new Error("R41_POSITIVE_CHARGE_STOP");
          }
          if (event.type === "tool_call_completed") entry.toolCalls++;
          if (event.type === "finish") entry.finishReason = event.finishReason;
          if (event.type === "error") {
            entry.errorCode = event.code;
            if (event.status === 429 || event.status === 402 || event.status === 403) parked.add(`${real.providerId}/${req.model}`);
          }
          yield event;
        }
      } catch (e) {
        entry.errorCode ??= e?.code ?? "PROVIDER_ERROR";
        throw e;
      } finally {
        entry.visibleChars = visible.length;
        if (["PLANNER", "REVIEWER"].includes(entry.role) && visible) {
          const verdict = validateStructuredAgentResult(entry.role.toLowerCase(), visible);
          entry.structuredError = verdict.success ? null : verdict.error.slice(0, 120);
        }
        entry.latencyMs = Math.round(performance.now() - started);
      }
    },
  };
}

const makeRepo = (task, arm) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `r41-${task.id}-${arm}-`));
  for (const [relative, content] of Object.entries(task.files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=r41@local.test", "-c", "user.name=CodeForge", "commit", "-qm", "fixture"], { cwd: root });
  return root;
};
const output = { at: new Date().toISOString(), profileSource: "R41-ROLE-PROFILES.json", zeroSpendBasis: "R40 verified free + R41 authenticated catalog ($0 per-token for OpenRouter); no Gemini or paid/BYOK route", maxTotalRequests: MAX_TOTAL_REQUESTS, maxArmMs: MAX_ARM_MS, topology: TOPOLOGY, pairs: [], calls: log };
for (const task of TASKS) {
  if (ONLY && !ONLY.has(task.id)) continue;
  const pair = { task: task.id, arms: {} };
  for (const arm of ["homogeneous", "heterogeneous"]) {
    const root = makeRepo(task, arm);
    const worktrees = fs.mkdtempSync(path.join(os.tmpdir(), `r41-wt-${task.id}-${arm}-`));
    const sessionId = `r41-${task.id}-${arm}-${Date.now()}`;
    const persistence = createSessionPersistence({ dbPath: path.join(os.tmpdir(), `${sessionId}.db`) });
    await persistence.init();
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktrees });
    await workspaceService.init();
    const firewall = new ForgeZero();
    const included = arm === "homogeneous" ? routes.filter((r) => r.providerId === "mistral") : routes;
    for (const route of included) {
      firewall.register(createGenericFreeRecord({
        providerId: route.providerId, modelId: route.modelId, displayName: route.modelId,
        contextWindow: 64_000,
        accessClass: route.providerId === "openrouter" ? "FREE_ROUTED" : "FREE_ALLOWANCE",
        authMode: "API_KEY",
        costProfile: { source: "R40 verified-free inventory + R41 live authenticated catalog; no paid fallback", isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, paidFallbackPossible: false, paidFallbackDisabled: true, freeTierVerifiedAt: preflight.at },
        benchmarkProfile: { coding: 80, toolCalling: 80, reasoning: 80, speed: 80, longContext: 80 },
      }));
    }
    const catalog = createProviderCatalog();
    if (included.some((r) => r.providerId === "mistral")) catalog.register(wrap(createMistralAdapter({ timeoutMs: 45_000 })));
    if (included.some((r) => r.providerId === "openrouter")) catalog.register(wrap(createOpenRouterAdapter({ timeoutMs: 45_000 })));
    const receipts = new Map(profiles.routes.map((r) => [`${r.providerId}/${r.modelId}`, r.receipt]));
    const allowed = new Set(included.map((r) => `${r.providerId}/${r.modelId}`));
    const hooks = arm === "heterogeneous" ? {
      isForgeAutoEligible: (provider, model) => allowed.has(`${provider}/${model}`) && !parked.has(`${provider}/${model}`),
      getQualificationReceipt: (provider, model) => receipts.get(`${provider}/${model}`),
      sameModelAlternates: () => [],
      canonicalIdOf: (provider, model) => `${provider}/${model}`,
      recordRouteFailure: (provider, model, reason) => { if (/RATE|QUOTA|PAYMENT|ACCESS/.test(reason)) parked.add(`${provider}/${model}`); },
      recordRouteSuccess: () => undefined,
      quotaRemaining: () => undefined,
      capacityRoutingAdvice: (provider, model) => parked.has(`${provider}/${model}`)
        ? { scoreAdjustment: -100, reasonCodes: ["KNOWN_CAPACITY_EXHAUSTED"] }
        : { scoreAdjustment: 0, reasonCodes: ["CAPACITY_UNOBSERVED"] },
    } : undefined;
    const eventStore = new EventStore();
    const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: root, ...(hooks ? { freeCloud: hooks } : {}) });
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService, persistence, agentRuntime: runtime, subagentsR1Enabled: true });
    const startIndex = log.length;
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAX_ARM_MS);
    let res;
    try {
      res = await orchestrator.startRun({ sessionId, workspacePath: root, goal: task.goal, verificationCommands: task.verify, topology: TOPOLOGY, signal: controller.signal });
    } catch (error) {
      res = { status: "error", summary: String(error?.code ?? error?.message ?? "error").slice(0, 120) };
    } finally { clearTimeout(timer); }
    let independent = false;
    try {
      const verifyRoot = res.status === "completed" ? root
        : res.integration?.worktreeId ? workspaceService.getWorkspace(res.integration.worktreeId)?.rootPath : undefined;
      if (verifyRoot) independent = await task.independent(verifyRoot);
    } catch { independent = false; }
    const calls = log.slice(startIndex);
    pair.arms[arm] = {
      status: res.status, independentlyVerified: independent,
      failureReason: res.status === "completed" ? null : String(res.integration?.reason ?? res.summary ?? "unknown").slice(0, 250),
      qualityEquivalentSuccess: res.status === "completed" && independent && Array.isArray(res.verification) && res.verification.length > 0 && res.verification.every((v) => v.exitCode === 0),
      wallMs: Math.round(performance.now() - started),
      requests: calls.length,
      inputTokens: calls.reduce((n, c) => n + (c.usage?.inputTokens ?? 0), 0),
      outputTokens: calls.reduce((n, c) => n + (c.usage?.outputTokens ?? 0), 0),
      reasoningTokens: calls.reduce((n, c) => n + (c.usage?.reasoningTokens ?? 0), 0),
      toolCalls: calls.reduce((n, c) => n + c.toolCalls, 0),
      providerSwitches: calls.reduce((n, c, i) => n + (i > 0 && c.providerId !== calls[i - 1].providerId ? 1 : 0), 0),
      roleRoutes: Object.fromEntries(["EXPLORER", "PLANNER", "CODER", "REVIEWER"].map((role) =>
        [role, [...new Set(calls.filter((c) => c.role === role).map((c) => `${c.providerId}/${c.modelId}`))]])),
      errorCodes: calls.filter((c) => c.errorCode).map((c) => c.errorCode),
      counters: res.counters ?? null,
      verification: res.verification?.map((v) => ({ command: v.command, exitCode: v.exitCode, timedOut: v.timedOut ?? false })) ?? [],
      reviewerFindings: res.review?.findings?.length ?? null,
      integration: res.integration?.status ?? null,
    };
    fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
    console.log(task.id, arm, pair.arms[arm].status, independent, calls.length, pair.arms[arm].roleRoutes);
    try { await runtime.close?.(); } catch {}
    try { await workspaceService.close?.(); } catch {}
    try { await persistence.close?.(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(worktrees, { recursive: true, force: true });
    if (log.length >= MAX_TOTAL_REQUESTS) break;
  }
  output.pairs.push(pair);
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  if (log.length >= MAX_TOTAL_REQUESTS) break;
}
