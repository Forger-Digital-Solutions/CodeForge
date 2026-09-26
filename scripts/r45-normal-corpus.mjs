// R45 live corpus — paced NORMAL-topology missions on verified-free providers only (§19-20).
// Serial execution, cooldown after observed rate-limit pressure, unique session ids,
// aborts early when supply is exhausted instead of burning the window.
//
// Harvests beyond R44 fields: journal telemetry's toolTrace, explorationBrief,
// adaptiveTurnBudget, routeWindows, routeFailovers — so agent efficiency and provider
// availability are separately attributable per §16/§18.
//
//   node scripts/r45-normal-corpus.mjs [out.json] [onlyIds,csv]
//   env: R45_TOPOLOGY=normal|adaptive (default normal)  R45_COOLDOWN_MS=120000
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { createProviderCatalog, createProviderAdapterById, createOpenRouterAdapter } from "../packages/providers/dist/index.js";
import { ForgeZero } from "../packages/forge-zero/dist/index.js";
import { createEightBitRuntime } from "../packages/eight-bit/dist/index.js";
import { createFreeModelCatalogRefresh } from "../packages/model-registry/dist/index.js";
import { createSessionPersistence, EventStore } from "../packages/sessions/dist/index.js";
import { createAgentRuntime, createAutonomousRunOrchestrator, createWorkspaceService } from "../packages/server/dist/index.js";

const OUT = process.argv[2] ?? "docs/evidence/r45-normal-topology/R45-LIVE-CORPUS.json";
const ONLY = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const TOPOLOGY = process.env.R45_TOPOLOGY ?? "normal";
const COOLDOWN_MS = Number(process.env.R45_COOLDOWN_MS ?? 120_000);

const TASKS = [
  {
    id: "r45-rename",
    kind: "rename",
    goal: "Rename the exported function `authenticate` to `verifyCredentials` everywhere: its definition in src/auth.mjs, the re-export in src/index.mjs, the call sites in src/login.mjs and src/admin.mjs, and the name listed in src/meta.mjs AUTH_EXPORTS. Keep behavior identical.",
    files: {
      "src/auth.mjs": "export function authenticate(user, pass) {\n  return user === 'admin' && pass === 's3cret';\n}\nexport const AUTH_VERSION = 1;\n",
      "src/index.mjs": "export { authenticate } from './auth.mjs';\nexport { AUTH_VERSION } from './auth.mjs';\n",
      "src/login.mjs": "import { authenticate } from './auth.mjs';\nexport function login(u, p) {\n  return authenticate(u, p) ? 'token' : null;\n}\n",
      "src/admin.mjs": "import { authenticate } from './auth.mjs';\nexport function gate(u, p) {\n  if (!authenticate(u, p)) throw new Error('denied');\n  return 'ok';\n}\n",
      "src/meta.mjs": "export const AUTH_EXPORTS = ['authenticate', 'AUTH_VERSION'];\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const a=await import('./src/auth.mjs');if(typeof a.verifyCredentials!=='function'||'authenticate' in a)process.exit(1);const l=await import('./src/login.mjs');if(l.login('admin','s3cret')!=='token')process.exit(2);const g=await import('./src/admin.mjs');if(g.gate('admin','s3cret')!=='ok')process.exit(3);const m=await import('./src/meta.mjs');if(!m.AUTH_EXPORTS.includes('verifyCredentials'))process.exit(4)\""],
  },
  {
    id: "r45-distributed-bug",
    kind: "distributed-bug",
    goal: "The test `node tests/report.test.mjs` fails: totals come out wrong. Find and fix the actual root cause (it is not where the symptom appears), then make the test pass.",
    files: {
      "src/normalize.mjs": "export function normalize(rows) {\n  return rows.filter((r) => r.amount >= 0).map((r) => ({ ...r, amount: Math.round(r.amount) }));\n}\n",
      "src/report.mjs": "import { normalize } from './normalize.mjs';\nexport function totals(rows) {\n  const clean = normalize(rows);\n  return { sum: clean.reduce((a, r) => a + r.amount, 0), count: clean.length };\n}\n",
      "tests/report.test.mjs": "import assert from 'node:assert';\nimport { totals } from '../src/report.mjs';\nconst r = totals([{ amount: 10 }, { amount: -3 }, { amount: 4.6 }]);\nassert.strictEqual(r.count, 3);\nassert.strictEqual(r.sum, 12);\nconsole.log('report ok');\n",
      "README.md": "# fixture\n",
    },
    verify: ["node tests/report.test.mjs"],
  },
  {
    id: "r45-feature",
    kind: "feature",
    goal: "Implement a sliding-window rate limiter: create src/limiter.mjs exporting `createLimiter(limit)` returning { allow(id) } where allow returns true for the first `limit` calls per id and false after. Integrate it in src/api.mjs: `request(id)` must call the shared limiter (limit 3) and throw a RangeError('rate limited') when denied, else return 'handled'. Update tests/api.test.mjs is already correct — do not modify it; make it pass.",
    files: {
      "src/api.mjs": "export function request(id) {\n  return 'handled';\n}\n",
      "tests/api.test.mjs": "import assert from 'node:assert';\nimport { request } from '../src/api.mjs';\nassert.strictEqual(request('u1'), 'handled');\nassert.strictEqual(request('u1'), 'handled');\nassert.strictEqual(request('u1'), 'handled');\nassert.throws(() => request('u1'), RangeError);\nassert.strictEqual(request('u2'), 'handled');\nconsole.log('api ok');\n",
      "README.md": "# fixture\n",
    },
    verify: ["node tests/api.test.mjs", "node -e \"const l=await import('./src/limiter.mjs');if(typeof l.createLimiter!=='function')process.exit(1);const x=l.createLimiter(2);if(!(x.allow('a')&&x.allow('a'))||x.allow('a'))process.exit(2)\""],
  },
  {
    id: "r45-schema",
    kind: "schema",
    goal: "Add a `priority` field end to end: src/schema.mjs `validateJob` must accept { title: string, priority?: 'low'|'high' } and default missing priority to 'low'; src/handler.mjs `enqueue(job)` must reject invalid jobs (throw TypeError) and store the validated job; src/client.mjs `submitJob(title, priority)` must pass priority through. Update tests/jobs.test.mjs is correct — make it pass.",
    files: {
      "src/schema.mjs": "export function validateJob(job) {\n  if (typeof job?.title !== 'string' || job.title.length === 0) return null;\n  return { title: job.title };\n}\n",
      "src/handler.mjs": "import { validateJob } from './schema.mjs';\nconst queue = [];\nexport function enqueue(job) {\n  queue.push(job);\n  return queue.length;\n}\nexport function peek() { return queue[0]; }\n",
      "src/client.mjs": "import { enqueue } from './handler.mjs';\nexport function submitJob(title) {\n  return enqueue({ title });\n}\n",
      "tests/jobs.test.mjs": "import assert from 'node:assert';\nimport { validateJob } from '../src/schema.mjs';\nimport { enqueue, peek } from '../src/handler.mjs';\nimport { submitJob } from '../src/client.mjs';\nassert.strictEqual(validateJob({ title: 'x' }).priority, 'low');\nassert.strictEqual(validateJob({ title: 'x', priority: 'high' }).priority, 'high');\nassert.strictEqual(validateJob({ title: 'x', priority: 'urgent' }), null);\nassert.throws(() => enqueue({ priority: 'high' }), TypeError);\nsubmitJob('job1', 'high');\nassert.strictEqual(peek().priority, 'high');\nconsole.log('jobs ok');\n",
      "README.md": "# fixture\n",
    },
    verify: ["node tests/jobs.test.mjs"],
  },
  {
    id: "r45-fail-repair",
    kind: "fail-repair",
    goal: "Implement `median(nums)` in src/stats.mjs returning the middle value for odd lengths and the mean of the two middle values for even lengths, then make `node tests/stats.test.mjs` pass.",
    files: {
      "src/stats.mjs": "export function median(nums) {\n  return nums[0];\n}\n",
      "tests/stats.test.mjs": "import assert from 'node:assert';\nimport { median } from '../src/stats.mjs';\nassert.strictEqual(median([3, 1, 2]), 2);\nassert.strictEqual(median([4, 1, 3, 2]), 2.5);\nconst input = [9, 5, 7];\nmedian(input);\nassert.deepStrictEqual(input, [9, 5, 7]);\nconsole.log('stats ok');\n",
      "README.md": "# fixture\n",
    },
    verify: ["node tests/stats.test.mjs"],
  },
];

// ---- providers ---------------------------------------------------------------
const callLog = [];
const wrap = (adapter) => ({
  providerId: adapter.providerId,
  isTestProvider: false,
  listModels: () => adapter.listModels(),
  healthCheck: () => adapter.healthCheck(),
  chat: async (req) => {
    const t = performance.now();
    try {
      const res = await adapter.chat(req);
      callLog.push({ provider: adapter.providerId, model: req.model, ms: performance.now() - t, usage: res.usage ?? null, ok: true });
      return res;
    } catch (e) {
      callLog.push({ provider: adapter.providerId, model: req.model, ms: performance.now() - t, error: e?.code ?? String(e?.message).slice(0, 80), ok: false });
      throw e;
    }
  },
  streamChat: async function* (req) {
    const t = performance.now();
    let usage = null;
    try {
      for await (const ev of adapter.streamChat(req)) {
        if (ev.type === "usage" && ev.usage) usage = ev.usage;
        yield ev;
      }
      callLog.push({ provider: adapter.providerId, model: req.model, ms: performance.now() - t, usage, ok: true });
    } catch (e) {
      callLog.push({ provider: adapter.providerId, model: req.model, ms: performance.now() - t, error: e?.code ?? String(e?.message).slice(0, 80), ok: false });
      throw e;
    }
  },
});

const catalog = createProviderCatalog();
const adapters = [createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" })];
for (const id of ["groq", "mistral"]) {
  const a = createProviderAdapterById(id);
  if (a) adapters.push(a);
}
for (const a of adapters) catalog.register(wrap(a));
console.log("providers:", adapters.map((a) => a.providerId).join(", "));

const firewall = new ForgeZero();
const eightBit = createEightBitRuntime({ firewall, persistence: { upsertWorkItem: async () => {}, getWorkItem: async () => null, deleteWorkItem: async () => {}, listWorkItems: async () => [], close: async () => {} } });
const refresh = createFreeModelCatalogRefresh({ firewall, eightBit, providerCatalog: catalog, maxAllowanceProbes: 2, requireCredentials: true });
const tR = performance.now();
const r = await refresh.refresh();
const verified = firewall.allModels().filter((m) => m.freeStatus === "verified_free");
console.log(`verified-free routes: ${verified.length} (${Math.round(performance.now() - tR)}ms), errors: ${r.errors.length}`);

const makeRepo = (task) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r45-${task.id}-`));
  for (const [rel, content] of Object.entries(task.files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=r45@dev", "-c", "user.name=r45", "commit", "-qm", "init"], { cwd: dir });
  return dir;
};

const GREENISH = /forgegreen|forge-green/i;
const harvest = async (eventStore, persistence, sessionId) => {
  const all = eventStore.getAll();
  const summaries = all.filter((e) => e.type === "forgegreen.optimization_summary").map((e) => e.payload);
  const suppressed = all.filter((e) => e.type === "tool.execution_blocked" && GREENISH.test(e.payload?.reason ?? ""));
  const turnFailures = all.filter((e) => e.type === "turn.failed").map((e) => ({ turnId: e.payload?.turnId, error: String(e.payload?.error ?? "").slice(0, 160) }));
  let journals = [];
  let receipts = { sustainability: [] };
  try {
    const items = await persistence.getWorkItems(sessionId);
    receipts.sustainability = items
      .filter((i) => i.kind === "forgegreen_sustainability_receipt")
      .map((i) => ({ tokensAvoided: i.tokensAvoided, duplicateActionsSuppressed: i.duplicateActionsSuppressed, suppressionEvidenceInvalidations: i.suppressionEvidenceInvalidations ?? 0, toolOutputBytesAvoided: i.toolOutputBytesAvoided }));
    journals = items
      .filter((i) => i.kind === "agent_run_journal")
      .map((i) => ({
        runId: i.runId, agentId: i.agentId, role: i.role, state: i.state,
        turnCount: i.turnCount, toolCallCount: i.toolCallCount,
        route: i.route ?? null,
        // R45 telemetry block
        toolTrace: i.telemetry?.toolTrace ?? null,
        explorationBrief: i.telemetry?.explorationBrief ?? null,
        adaptiveTurnBudget: i.telemetry?.adaptiveTurnBudget ?? null,
        routeWindows: i.telemetry?.routeWindows ?? null,
        routeFailovers: i.telemetry?.routeFailovers ?? null,
        editAttempts: i.telemetry?.editAttempts ?? [],
        structuredOutput: i.telemetry?.structuredOutput ?? null,
        stopReason: i.telemetry?.stopReason ?? null,
      }));
  } catch {}
  const editAttempts = journals.flatMap((j) => (j.editAttempts ?? []).map((a) => ({ ...a, role: j.role })));
  const explorerJournals = journals.filter((j) => j.role === "explorer");
  return {
    duplicatesSuppressed: suppressed.filter((e) => e.payload?.reason === "forgegreen_duplicate_suppressed").length,
    turnFailures,
    receipts,
    journals,
    explorer: explorerJournals.length ? {
      turns: explorerJournals.map((j) => j.turnCount),
      toolCalls: explorerJournals.map((j) => j.toolCallCount),
      brief: explorerJournals.map((j) => j.explorationBrief),
      adaptiveBudget: explorerJournals.map((j) => j.adaptiveTurnBudget),
      trace: explorerJournals.map((j) => j.toolTrace),
    } : null,
    routeWindows: journals.flatMap((j) => j.routeWindows ?? []),
    routeFailovers: journals.flatMap((j) => j.routeFailovers ?? []),
    firstEditQuality: {
      runsWithEdits: journals.filter((j) => (j.editAttempts?.length ?? 0) > 0).length,
      firstEditSucceeded: journals.filter((j) => j.editAttempts?.[0]?.outcome === "success").length,
      hashAutoAttached: editAttempts.filter((a) => a.hashAutoAttached).length,
      hashSupplied: editAttempts.filter((a) => a.expectedHashSupplied).length,
      failureClasses: editAttempts.reduce((m, a) => (a.failureClass ? { ...m, [a.failureClass]: (m[a.failureClass] ?? 0) + 1 } : m), {}),
    },
    eventCount: all.length,
  };
};

const results = [];
let sawRateLimits = false;
let consecutiveSupplyBlocked = 0;
for (const task of TASKS) {
  if (ONLY && !ONLY.has(task.id)) continue;
  if (consecutiveSupplyBlocked >= 2) {
    console.log(`supply exhausted — stopping corpus before ${task.id} (2 consecutive supply-blocked missions)`);
    break;
  }
  if (sawRateLimits) {
    console.log(`cooldown ${COOLDOWN_MS / 1000}s before ${task.id} (rate-limit pressure observed)`);
    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
    sawRateLimits = false;
  }
  const repoDir = makeRepo(task);
  const sessionId = `r45-${task.id}-${Date.now().toString(36)}`;
  const persistence = createSessionPersistence({ dbPath: path.join(os.tmpdir(), `${sessionId}.db`) });
  await persistence.init();
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), `r45-wt-${task.id}-`));
  const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeDir });
  await workspaceService.init();
  const eventStore = new EventStore();
  const agentRuntime = createAgentRuntime({
    sessionId, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: repoDir,
  });
  const orchestrator = createAutonomousRunOrchestrator({ workspaceService, persistence, agentRuntime, subagentsR1Enabled: true });
  const mark = callLog.length;
  const t0 = performance.now();
  let result;
  try {
    const runOpts = { sessionId, workspacePath: repoDir, goal: task.goal, verificationCommands: task.verify };
    if (TOPOLOGY === "adaptive") { if (process.env.R45_HINT) runOpts.complexityHint = process.env.R45_HINT; }
    else runOpts.topology = TOPOLOGY;
    result = await orchestrator.startRun(runOpts);
  } catch (e) {
    result = { status: "error", error: String(e?.message).slice(0, 200) };
  }
  const wallMs = performance.now() - t0;
  const calls = callLog.slice(mark);
  const harvested = await harvest(eventStore, persistence, sessionId);
  sawRateLimits = calls.length === 0
    || calls.some((c) => !c.ok)
    || harvested.turnFailures.some((f) => /RATE_LIMIT|UNAVAILABLE|429/i.test(f.error ?? ""));
  const supplyBlocked = calls.length === 0 || calls.every((c) => !c.ok);
  consecutiveSupplyBlocked = supplyBlocked ? consecutiveSupplyBlocked + 1 : 0;
  const rec = {
    task: task.id, kind: task.kind,
    topology: result.topology?.plan?.topology ?? result.topology ?? TOPOLOGY,
    status: result.status,
    counters: result.counters ?? null,
    changedFiles: result.changedFiles ?? null,
    verification: (result.verification ?? []).map((v) => ({ command: v.command, exitCode: v.exitCode, passed: v.exitCode === 0 && v.failed === 0 })),
    review: result.review ? { passed: result.review.passed, findings: result.review.findings?.length ?? 0 } : null,
    completion: result.completion ? { verdict: result.completion.verdict ?? result.completion.status ?? null } : null,
    wallMs: Math.round(wallMs),
    calls: calls.length,
    inTokens: calls.reduce((a, c) => a + (c.usage?.inputTokens ?? 0), 0),
    outTokens: calls.reduce((a, c) => a + (c.usage?.outputTokens ?? 0), 0),
    errors: calls.filter((c) => !c.ok).length,
    providers: [...new Set(calls.map((c) => c.provider))],
    models: [...new Set(calls.map((c) => c.model))],
    errorKinds: calls.filter((c) => !c.ok).map((c) => c.error),
    supplyBlocked,
    harvested,
  };
  results.push(rec);
  console.log(`${task.id}: ${rec.status} calls=${rec.calls} in=${rec.inTokens} wall=${(wallMs / 1000).toFixed(1)}s err=${rec.errors} supp=${harvested.duplicatesSuppressed} explorerTurns=${harvested.explorer?.turns ?? "-"} brief=${harvested.explorer?.brief?.[0]?.candidateFiles ?? "-"} budget=${harvested.explorer?.adaptiveBudget?.[0] ? `${harvested.explorer.adaptiveBudget[0].original}->${harvested.explorer.adaptiveBudget[0].applied}` : "-"} firstEditOk=${harvested.firstEditQuality.firstEditSucceeded}/${harvested.firstEditQuality.runsWithEdits}`);
  try { await agentRuntime.close?.(); } catch {}
  try { await workspaceService.close?.(); } catch {}
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), topology: TOPOLOGY, providers: adapters.map((a) => a.providerId), verifiedRoutes: verified.length, missions: results, callLog }, null, 2));
}
console.log("done →", OUT);
