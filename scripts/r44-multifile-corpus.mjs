// R44 multi-file intelligence corpus.
// Seven task families (§3 A–G) run through the production autonomous orchestrator on real
// verified-free providers only. Arms: baseline (all efficiency controls off) | green
// (production selective policy). Optional green-forced via R44_ARMS.
//
// Harvests per arm (beyond R43 fields):
//   - agent_run_journal work items → per-role turn/tool counts, active route, and the R44
//     telemetry block (editAttempts[] with hash-supply/auto-attach/outcome/failureClass,
//     structuredOutput repairs/rejections/exhaustion) for first-edit-quality aggregation.
//   - repair cycles (counters.reviewRounds), verification results, review findings,
//     ForgeGreen suppression/denial/escalation receipts.
// Usage: node scripts/r44-multifile-corpus.mjs [out.json] [onlyIds,csv]
//   env: R44_ARMS=baseline,green  R44_KIND=rename,feature,...  Real providers only; no secrets.
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

const OUT = process.argv[2] ?? "docs/evidence/r44-multifile/R44-MULTIFILE-CORPUS.json";
const ONLY = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const ARMS = (process.env.R44_ARMS ?? "baseline,green").split(",");
const KIND = process.env.R44_KIND ? new Set(process.env.R44_KIND.split(",")) : null;

// Family G needs a diff that substantially exceeds the retired ~2KB reviewer slice.
const fillerLines = Array.from({ length: 120 }, (_, i) => `export const FILLER_${String(i).padStart(3, "0")} = ${i} * ${i + 3};`).join("\n");

const TASKS = [
  {
    // A. Cross-file rename/refactor — symbol renamed across impl, type surface, callsites, config.
    id: "r44-rename",
    kind: "rename",
    cls: "medium",
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
    // B. Feature implementation — new module + integration + error handling + tests.
    id: "r44-feature",
    kind: "feature",
    cls: "medium",
    goal: "Implement a sliding-window rate limiter: create src/limiter.mjs exporting `createLimiter(limit)` returning { allow(id) } where allow returns true for the first `limit` calls per id and false after. Integrate it in src/api.mjs: `request(id)` must call the shared limiter (limit 3) and throw a RangeError('rate limited') when denied, else return 'handled'. Update tests/api.test.mjs is already correct — do not modify it; make it pass.",
    files: {
      "src/api.mjs": "export function request(id) {\n  return 'handled';\n}\n",
      "tests/api.test.mjs": "import assert from 'node:assert';\nimport { request } from '../src/api.mjs';\nassert.strictEqual(request('u1'), 'handled');\nassert.strictEqual(request('u1'), 'handled');\nassert.strictEqual(request('u1'), 'handled');\nassert.throws(() => request('u1'), RangeError);\nassert.strictEqual(request('u2'), 'handled');\nconsole.log('api ok');\n",
      "README.md": "# fixture\n",
    },
    verify: ["node tests/api.test.mjs", "node -e \"const l=await import('./src/limiter.mjs');if(typeof l.createLimiter!=='function')process.exit(1);const x=l.createLimiter(2);if(!(x.allow('a')&&x.allow('a'))||x.allow('a'))process.exit(2)\""],
  },
  {
    // C. Distributed root cause — symptom in report, cause in normalize.
    id: "r44-distributed-bug",
    kind: "distributed-bug",
    cls: "medium",
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
    // D. API/schema propagation — new field flows through types → validate → handler → client.
    id: "r44-schema",
    kind: "schema",
    cls: "medium",
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
    // E. Behavioral refactor — same semantics, different topology.
    id: "r44-refactor",
    kind: "refactor",
    cls: "medium",
    goal: "Refactor the callback-chain in src/engine.mjs into an async/await `run()` while preserving exact semantics: steps run in order, each receives the previous result, and a failing step rejects with the same error. src/steps.mjs and src/runner.mjs must keep working — runner calls engine.run(). The test tests/engine.test.mjs must pass unchanged.",
    files: {
      "src/steps.mjs": "export const steps = [\n  async (x) => x + 1,\n  async (x) => x * 2,\n  async (x) => x - 3,\n];\n",
      "src/engine.mjs": "import { steps } from './steps.mjs';\nexport function run(initial) {\n  let p = Promise.resolve(initial);\n  for (const s of steps) p = p.then(s);\n  return p;\n}\n",
      "src/runner.mjs": "import { run } from './engine.mjs';\nexport async function execute(v) {\n  return await run(v);\n}\n",
      "tests/engine.test.mjs": "import assert from 'node:assert';\nimport { run } from '../src/engine.mjs';\nimport { execute } from '../src/runner.mjs';\nassert.strictEqual(await run(5), 9);\nassert.strictEqual(await execute(0), -1);\nconsole.log('engine ok');\n",
      "README.md": "# fixture\n",
    },
    verify: ["node tests/engine.test.mjs", "node -e \"const fs=await import('node:fs');const src=fs.readFileSync('src/engine.mjs','utf8');if(!/async/.test(src))process.exit(1)\""],
  },
  {
    // F. Failure-and-repair — the obvious implementation mutates input; verification catches it.
    id: "r44-fail-repair",
    kind: "fail-repair",
    cls: "medium",
    goal: "Implement `median(nums)` in src/stats.mjs returning the middle value for odd lengths and the mean of the two middle values for even lengths, then make `node tests/stats.test.mjs` pass.",
    files: {
      "src/stats.mjs": "export function median(nums) {\n  return nums[0];\n}\n",
      "tests/stats.test.mjs": "import assert from 'node:assert';\nimport { median } from '../src/stats.mjs';\nassert.strictEqual(median([3, 1, 2]), 2);\nassert.strictEqual(median([4, 1, 3, 2]), 2.5);\nconst input = [9, 5, 7];\nmedian(input);\nassert.deepStrictEqual(input, [9, 5, 7]);\nconsole.log('stats ok');\n",
      "README.md": "# fixture\n",
    },
    verify: ["node tests/stats.test.mjs"],
  },
  {
    // G. Large-diff review — coordinated change across many files plus a large generated module;
    // the total diff is far beyond the retired ~2KB reviewer slice.
    id: "r44-large-diff",
    kind: "large-diff",
    cls: "medium",
    goal: "Two coordinated changes: (1) in src/registry.mjs set DEFAULT_LIMIT from 50 to 5000, (2) add `export function describeRow(row) { return row.id + ':' + row.flag; }` to src/table.mjs and call it inside src/render.mjs's `render` for each row (join results with '\\n'). Do not change any FILLER constants.",
    files: {
      "src/registry.mjs": `export const DEFAULT_LIMIT = 50;\n${fillerLines}\n`,
      "src/table.mjs": "export const COLS = ['id', 'flag'];\n",
      "src/render.mjs": "import { COLS } from './table.mjs';\nexport function render(rows) {\n  return rows.map(() => COLS.join('|')).join('\\n');\n}\n",
      "src/data.mjs": "export const ROWS = [{ id: 'a', flag: true }];\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const r=await import('./src/registry.mjs');if(r.DEFAULT_LIMIT!==5000)process.exit(1);const t=await import('./src/table.mjs');if(t.describeRow({id:'a',flag:true})!=='a:true')process.exit(2);const w=await import('./src/render.mjs');const out=w.render([{id:'a',flag:true}]);if(!/a:true/.test(out))process.exit(3)\""],
  },
];

// ---- providers ---------------------------------------------------------------
const callLog = [];
const wrap = (adapter) => {
  const real = adapter;
  return {
    providerId: real.providerId,
    isTestProvider: false,
    listModels: () => real.listModels(),
    healthCheck: () => real.healthCheck(),
    chat: async (req) => {
      const t = performance.now();
      try {
        const res = await real.chat(req);
        callLog.push({ provider: real.providerId, model: req.model, ms: performance.now() - t, usage: res.usage ?? null, ok: true });
        return res;
      } catch (e) {
        callLog.push({ provider: real.providerId, model: req.model, ms: performance.now() - t, error: e?.code ?? String(e?.message).slice(0, 80), ok: false });
        throw e;
      }
    },
    streamChat: async function* (req) {
      const t = performance.now();
      let usage = null;
      try {
        for await (const ev of real.streamChat(req)) {
          if (ev.type === "usage" && ev.usage) usage = ev.usage;
          yield ev;
        }
        callLog.push({ provider: real.providerId, model: req.model, ms: performance.now() - t, usage, ok: true });
      } catch (e) {
        callLog.push({ provider: real.providerId, model: req.model, ms: performance.now() - t, error: e?.code ?? String(e?.message).slice(0, 80), ok: false });
        throw e;
      }
    },
  };
};

const catalog = createProviderCatalog();
const adapters = [createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" })];
for (const id of ["groq", "mistral"]) {
  const a = createProviderAdapterById(id);
  if (a) adapters.push(a);
}
for (const a of adapters) catalog.register(wrap(a));
console.log("providers:", adapters.map((a) => a.providerId).join(", "));

// ---- ForgeZero verified-free inventory ---------------------------------------
const firewall = new ForgeZero();
const eightBit = createEightBitRuntime({ firewall, persistence: { upsertWorkItem: async () => {}, getWorkItem: async () => null, deleteWorkItem: async () => {}, listWorkItems: async () => [], close: async () => {} } });
const refresh = createFreeModelCatalogRefresh({ firewall, eightBit, providerCatalog: catalog, maxAllowanceProbes: 2, requireCredentials: true });
const tR = performance.now();
const r = await refresh.refresh();
const verified = firewall.allModels().filter((m) => m.freeStatus === "verified_free");
console.log(`verified-free routes: ${verified.length} (${Math.round(performance.now() - tR)}ms), errors: ${r.errors.length}`);

// ---- runner -------------------------------------------------------------------
const makeRepo = (task) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r44-${task.id}-`));
  for (const [rel, content] of Object.entries(task.files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=r44@dev", "-c", "user.name=r44", "commit", "-qm", "init"], { cwd: dir });
  return dir;
};

const GREENISH = /forgegreen|forge-green/i;
const harvestEvents = async (eventStore, persistence, sessionId) => {
  const all = eventStore.getAll();
  const summaries = all.filter((e) => e.type === "forgegreen.optimization_summary").map((e) => e.payload);
  const suppressed = all.filter((e) => e.type === "tool.execution_blocked" && GREENISH.test(e.payload?.reason ?? ""));
  const toolFailures = all.filter((e) => e.type === "tool.execution_failed").map((e) => ({ tool: e.payload?.toolName, error: e.payload?.error }));
  const loopBlocks = all.filter((e) => e.type === "tool.execution_blocked" && /LOOP|NO_PROGRESS/i.test(e.payload?.reason ?? "")).map((e) => ({ tool: e.payload?.toolName, reason: e.payload?.reason }));
  const turnFailures = all.filter((e) => e.type === "turn.failed").map((e) => ({ turnId: e.payload?.turnId, error: String(e.payload?.error ?? "").slice(0, 160) }));
  const failovers = all.filter((e) => /failover|router/i.test(e.type));
  const verification = all.filter((e) => /verif|review/i.test(e.type));
  let receipts = { sustainability: [], optimizationDecisions: [], optimizationReceipts: [] };
  let journals = [];
  try {
    const items = await persistence.getWorkItems(sessionId);
    receipts.sustainability = items
      .filter((i) => i.kind === "forgegreen_sustainability_receipt")
      .map((i) => ({ tokensAvoided: i.tokensAvoided, duplicateActionsSuppressed: i.duplicateActionsSuppressed, suppressionEvidenceInvalidations: i.suppressionEvidenceInvalidations ?? 0, toolOutputBytesAvoided: i.toolOutputBytesAvoided, measurementStatus: i.measurementStatus, fallbackUsed: i.fallbackUsed }));
    receipts.optimizationDecisions = items
      .filter((i) => i.kind === "forgegreen_optimization_decision")
      .map((i) => ({ kind: i.optimizationKind ?? i.kind, status: i.status, mode: i.mode }));
    receipts.optimizationReceipts = items
      .filter((i) => i.kind === "forgegreen_optimization_receipt")
      .map((i) => ({ quality: i.qualityResult, survivedValidation: i.survivedValidation, measuredDelta: i.measuredDelta }));
    journals = items
      .filter((i) => i.kind === "agent_run_journal")
      .map((i) => ({
        runId: i.runId, agentId: i.agentId, role: i.role, state: i.state,
        turnCount: i.turnCount, toolCallCount: i.toolCallCount, writeCallCount: i.writeCallCount,
        route: i.route ?? null,
        telemetry: i.telemetry ?? null,
      }));
  } catch {}
  const editAttempts = journals.flatMap((j) => (j.telemetry?.editAttempts ?? []).map((a) => ({ ...a, role: j.role })));
  const firstEdits = journals.filter((j) => (j.telemetry?.editAttempts?.length ?? 0) > 0).map((j) => j.telemetry.editAttempts[0]);
  return {
    optimizationSummaries: summaries,
    duplicatesSuppressed: suppressed.filter((e) => e.payload?.reason === "forgegreen_duplicate_suppressed").length,
    suppressedTools: suppressed.map((e) => e.payload?.toolName),
    suppressionDenials: summaries.flatMap((s) => s.suppressionDenials ?? []),
    failoverEvents: failovers.length,
    verificationEvents: verification.length,
    toolFailures,
    loopBlocks,
    turnFailures,
    runPolicies: summaries.map((s) => s.runPolicy).filter(Boolean),
    receipts,
    journals,
    firstEditQuality: {
      runsWithEdits: firstEdits.length,
      firstEditSucceeded: firstEdits.filter((a) => a.outcome === "success").length,
      firstEditDenied: firstEdits.filter((a) => a.outcome === "denied").length,
      hashAutoAttached: editAttempts.filter((a) => a.hashAutoAttached).length,
      hashSupplied: editAttempts.filter((a) => a.expectedHashSupplied).length,
      failureClasses: editAttempts.reduce((m, a) => (a.failureClass ? { ...m, [a.failureClass]: (m[a.failureClass] ?? 0) + 1 } : m), {}),
    },
    eventCount: all.length,
  };
};

const results = [];
const COOLDOWN_MS = Number(process.env.R44_COOLDOWN_MS ?? 90_000);
let lastArmSawRateLimits = false;
for (const [i, task] of TASKS.entries()) {
  if (ONLY && !ONLY.has(task.id)) continue;
  if (KIND && !KIND.has(task.kind)) continue;
  const order = i % 2 === 0 ? ARMS : [...ARMS].reverse();
  const pair = { task: task.id, kind: task.kind, cls: task.cls, arms: {} };
  for (const arm of order) {
    // Route health is shared across arms (as in production). Deciding into a parked window
    // yields instant PROVIDER_UNAVAILABLE blocks — pace after observed rate-limit pressure
    // so each arm runs against supply that has had a chance to recover.
    if (lastArmSawRateLimits) {
      console.log(`cooldown ${COOLDOWN_MS / 1000}s before ${task.id}/${arm} (rate-limit pressure observed)`);
      await new Promise((r) => setTimeout(r, COOLDOWN_MS));
      lastArmSawRateLimits = false;
    }
    const repoDir = makeRepo(task);
    const sessionId = `r44-${task.id}-${arm}`;
    const persistence = createSessionPersistence({ dbPath: path.join(os.tmpdir(), `${sessionId}.db`) });
    await persistence.init();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), `r44-wt-${task.id}-${arm}-`));
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeDir });
    await workspaceService.init();
    const eventStore = new EventStore();
    const agentRuntime = createAgentRuntime({
      sessionId, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: repoDir,
      efficiencyControls: arm === "baseline"
        ? { duplicateSuppression: false, toolOutputCompression: false, supersededCompaction: false }
        : { duplicateSuppression: true, toolOutputCompression: true, supersededCompaction: true },
      ...(arm === "green-forced" ? { forgeGreenInitialLevel: "FULL" } : {}),
    });
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService, persistence, agentRuntime, subagentsR1Enabled: true });
    const mark = callLog.length;
    const t0 = performance.now();
    let result;
    try {
      result = await orchestrator.startRun({ sessionId, workspacePath: repoDir, goal: task.goal, verificationCommands: task.verify, topology: "normal" });
    } catch (e) {
      result = { status: "error", error: String(e?.message).slice(0, 200) };
    }
    const wallMs = performance.now() - t0;
    const calls = callLog.slice(mark);
    const green = await harvestEvents(eventStore, persistence, sessionId);
    lastArmSawRateLimits = calls.length === 0
      || calls.some((c) => !c.ok)
      || green.turnFailures.some((f) => /RATE_LIMIT|UNAVAILABLE|429/i.test(f.error ?? ""));
    const armRec = {
      arm,
      status: result.status,
      topology: result.topology?.plan?.topology ?? result.topology ?? null,
      counters: result.counters ?? null,
      changedFiles: result.changedFiles ?? null,
      verification: (result.verification ?? []).map((v) => ({ command: v.command, exitCode: v.exitCode, passed: v.exitCode === 0 && v.failed === 0, testSignal: v.testSignal ?? null })),
      review: result.review ? { passed: result.review.passed, findings: result.review.findings?.length ?? 0 } : null,
      completion: result.completion ? { verdict: result.completion.verdict ?? result.completion.status ?? null } : null,
      wallMs: Math.round(wallMs),
      calls: calls.length,
      inTokens: calls.reduce((a, c) => a + (c.usage?.inputTokens ?? 0), 0),
      outTokens: calls.reduce((a, c) => a + (c.usage?.outputTokens ?? 0), 0),
      reasoningTokens: calls.reduce((a, c) => a + (c.usage?.reasoningTokens ?? 0), 0),
      errors: calls.filter((c) => !c.ok).length,
      providers: [...new Set(calls.map((c) => c.provider))],
      models: [...new Set(calls.map((c) => c.model))],
      errorKinds: calls.filter((c) => !c.ok).map((c) => c.error),
      // §4: separate system failure from provider failure — supplyBlocked means the arm never
      // reached real work (no calls, or only rate-limit/unavailability errors).
      supplyBlocked: calls.length === 0 || calls.every((c) => !c.ok),
      green,
    };
    pair.arms[arm] = armRec;
    console.log(`${task.id} ${arm}: ${armRec.status} calls=${armRec.calls} in=${armRec.inTokens} out=${armRec.outTokens} wall=${(armRec.wallMs / 1000).toFixed(1)}s err=${armRec.errors} supp=${green.duplicatesSuppressed} deny=${green.suppressionDenials.length} edits=${green.firstEditQuality.runsWithEdits} first-ok=${green.firstEditQuality.firstEditSucceeded} auto=${green.firstEditQuality.hashAutoAttached} policies=${green.runPolicies.map((p) => `${p.initialLevel}->${p.level}(esc:${p.escalations.length})`).join("|") || "none"}`);
    try { await agentRuntime.close?.(); } catch {}
    try { await workspaceService.close?.(); } catch {}
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
  const b = pair.arms.baseline;
  const g = pair.arms.green ?? pair.arms["green-forced"];
  pair.outcome = !b || !g ? "INCOMPARABLE"
    : b.status === "completed" && g.status === "completed" ? "BOTH_PASS"
    : b.status === "completed" ? "BASELINE_PASS_GREEN_FAIL"
    : g.status === "completed" ? "BASELINE_FAIL_GREEN_PASS" : "BOTH_FAIL";
  if (pair.outcome === "BOTH_PASS" && b.calls > 0) {
    pair.vwm = { requests: +(b.calls / Math.max(1, g.calls)).toFixed(3), inTokens: +(b.inTokens / Math.max(1, g.inTokens)).toFixed(3) };
  }
  results.push(pair);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), arms: ARMS, providers: adapters.map((a) => a.providerId), verifiedRoutes: verified.length, pairs: results, callLog }, null, 2));
}
console.log("done →", OUT);
