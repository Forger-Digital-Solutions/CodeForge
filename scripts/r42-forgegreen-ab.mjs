// R42 ForgeGreen selective-policy paired A/B corpus.
// Same production autonomous orchestrator as r39-live-ab.mjs, but each arm keeps its own
// EventStore so the harvested `forgegreen.*` / `tool.execution_blocked` events record what the
// selective policy actually did per run — level, escalations, prevented replays, suppressions —
// the per-case data R39/R40 never persisted. Arms:
//   baseline       — all efficiency controls off (the certified disabled surface)
//   green          — production selective policy (all controls available; level resolved per run)
//   green-forced   — (opt-in via R42_ARMS) same controls but forgeGreenInitialLevel=FULL, so the
//                    corpus can price what CONSERVATIVE admission would have cost in savings.
// Real providers only; no secrets logged.
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

const OUT = process.argv[2] ?? "docs/evidence/r42-production-stress/R42-FORGEGREEN-AB.json";
const ONLY = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const ARMS = (process.env.R42_ARMS ?? "baseline,green").split(",");

// ---- task fixtures -----------------------------------------------------------
// The R39/R40 nine-task corpus plus three cases the regression analysis showed were
// unmeasured: a coordinated multi-file change (the worst R40 regression class), an
// exploration-heavy bug whose fix requires tracing across files, and a low-opportunity
// one-shot edit where suppression has almost nothing to act on.
const TASKS = [
  {
    id: "cfg-edit",
    cls: "tiny",
    goal: "Update src/config.mjs so MAX_RETRIES is 5 instead of 3. Do not change anything else.",
    files: {
      "src/config.mjs": "export const MAX_RETRIES = 3;\nexport const TIMEOUT_MS = 4000;\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"import('./src/config.mjs').then(m=>{if(m.MAX_RETRIES!==5)process.exit(1)})\""],
  },
  {
    id: "add-fn",
    cls: "small",
    goal: "Add and export a function `slugify` in src/strings.mjs that lowercases a string and replaces runs of non-alphanumeric characters with single hyphens, trimming leading/trailing hyphens.",
    files: {
      "src/strings.mjs": "export const join = (parts) => parts.join(' ');\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"import('./src/strings.mjs').then(m=>{if(m.slugify('  Hello,  World! ')!=='hello-world')process.exit(1)})\""],
  },
  {
    id: "bug-fix",
    cls: "small",
    goal: "Fix the off-by-one bug in src/pagination.mjs: paginate(items, page, size) must return the correct slice; page is 1-based. Add no new dependencies.",
    files: {
      "src/pagination.mjs": "export function paginate(items, page, size) {\n  return items.slice(page * size, page * size + size);\n}\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"import('./src/pagination.mjs').then(m=>{const r=m.paginate([1,2,3,4,5],2,2);if(r[0]!==3||r.length!==2)process.exit(1)})\""],
  },
  {
    id: "rename",
    cls: "tiny",
    goal: "Rename the exported function `fetchUser` to `getUser` in src/api.mjs and update its call site in src/main.mjs.",
    files: {
      "src/api.mjs": "export function fetchUser(id) { return { id };\n}\n",
      "src/main.mjs": "import { fetchUser } from './api.mjs';\nexport const user = fetchUser(1);\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"import('./src/main.mjs').then(m=>{if(m.user.id!==1)process.exit(1)})\""],
  },
  {
    id: "guard",
    cls: "small",
    goal: "In src/validate.mjs, validateAge(age) must throw a RangeError when age is negative or not an integer, and return age otherwise. It currently accepts negatives — fix it.",
    files: {
      "src/validate.mjs": "export function validateAge(age) {\n  return age;\n}\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"import('./src/validate.mjs').then(m=>{let threw=false;try{m.validateAge(-3)}catch(e){threw=e instanceof RangeError}if(!threw)process.exit(1);if(m.validateAge(30)!==30)process.exit(1)})\""],
  },
  {
    id: "sum",
    cls: "tiny",
    goal: "In src/math.mjs implement and export `sum(nums)` returning the sum of a number array, 0 for an empty array.",
    files: {
      "src/math.mjs": "export const product = (nums) => nums.reduce((a, b) => a * b, 1);\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"import('./src/math.mjs').then(m=>{if(m.sum([1,2,3])!==6||m.sum([])!==0)process.exit(1)})\""],
  },
  {
    id: "test-repair",
    cls: "small",
    goal: "The test in tests/calc.test.mjs fails because divide(a,b) throws on b=0 but the test expects it to return Infinity. Fix the implementation in src/calc.mjs (change divide to return Infinity when b is 0), not the test.",
    files: {
      "src/calc.mjs": "export function divide(a, b) { if (b === 0) throw new Error('div0'); return a / b; }\n",
      "tests/calc.test.mjs": "import assert from 'node:assert';\nimport { divide } from '../src/calc.mjs';\nassert.strictEqual(divide(1, 0), Infinity);\nconsole.log('ok');\n",
      "README.md": "# fixture\n",
    },
    verify: ["node tests/calc.test.mjs"],
  },
  {
    id: "multi-file",
    cls: "medium",
    goal: "Add a shared `log` helper in src/util.mjs that prefixes messages with '[app]'. Use it in src/a.mjs and src/b.mjs which currently call console.log directly with plain strings.",
    files: {
      "src/util.mjs": "export const VERSION = '1.0';\n",
      "src/a.mjs": "export function a() { console.log('starting a'); }\n",
      "src/b.mjs": "export function b() { console.log('starting b'); }\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const util=await import('./src/util.mjs');const a=await import('./src/a.mjs');const orig=console.log;let seen='';console.log=(m)=>{seen=m};a.a();console.log=orig;if(seen!=='[app] starting a')process.exit(1)\""],
  },
  {
    id: "refactor",
    cls: "small",
    goal: "Refactor src/users.mjs: extract the duplicated fullName computation (first + ' ' + last) into an exported helper `fullName` and use it in both exported functions. Keep behavior identical.",
    files: {
      "src/users.mjs": "export function greet(u) { return 'Hi ' + u.first + ' ' + u.last; }\nexport function label(u) { return u.first + ' ' + u.last + ' <'+u.id+'>'; }\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"import('./src/users.mjs').then(m=>{const u={first:'A',last:'B',id:'1'};if(m.greet(u)!=='Hi A B'||m.label(u)!=='A B <1>'||m.fullName(u)!=='A B')process.exit(1)})\""],
  },
  {
    id: "coordinated-api",
    cls: "medium",
    goal: "Create src/format.mjs exporting `fmt(n)` that formats a number with two decimals. Then update src/price.mjs and src/label.mjs so `price(x)` and `label(x)` both return strings built via fmt. price returns 'USD ' + fmt(x); label returns '#' + fmt(x).",
    files: {
      "src/price.mjs": "export function price(x) { return 'USD ' + x.toFixed(2); }\n",
      "src/label.mjs": "export function label(x) { return '#' + x.toFixed(2); }\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const p=await import('./src/price.mjs');const l=await import('./src/label.mjs');const f=await import('./src/format.mjs');if(p.price(1)!=='USD 1.00'||l.label(1)!=='#1.00'||f.fmt(2)!=='2.00')process.exit(1)\""],
  },
  {
    id: "exploration-bug",
    cls: "small",
    goal: "There is a bug somewhere in the request pipeline: src/handler.mjs calls src/validate.mjs's check(), which calls src/rules.mjs. The rule for 'age' must reject values under 18 but currently allows them. Find the bug and fix it in the right file.",
    files: {
      "src/handler.mjs": "import { check } from './validate.mjs';\nexport function handle(req) { return check(req); }\n",
      "src/validate.mjs": "import { RULES } from './rules.mjs';\nexport function check(req) { return RULES.every(r => r(req)); }\n",
      "src/rules.mjs": "export const RULES = [\n  (req) => req.name !== undefined,\n  (req) => req.age === undefined || req.age >= 0,\n];\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const h=await import('./src/handler.mjs');if(h.handle({name:'x',age:15})===true)process.exit(1);if(h.handle({name:'x',age:21})!==true)process.exit(1)\""],
  },
  {
    id: "one-shot-edit",
    cls: "tiny",
    goal: "In src/flag.mjs change ENABLED to false.",
    files: {
      "src/flag.mjs": "export const ENABLED = true;\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"import('./src/flag.mjs').then(m=>{if(m.ENABLED!==false)process.exit(1)})\""],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r42-${task.id}-`));
  for (const [rel, content] of Object.entries(task.files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=r42@dev", "-c", "user.name=r42", "commit", "-qm", "init"], { cwd: dir });
  return dir;
};

const GREENISH = /forgegreen|forge-green/i;
const harvestEvents = async (eventStore, persistence, sessionId) => {
  const all = eventStore.getAll();
  const summaries = all.filter((e) => e.type === "forgegreen.optimization_summary").map((e) => e.payload);
  const suppressed = all.filter((e) => e.type === "tool.execution_blocked" && GREENISH.test(e.payload?.reason ?? ""));
  const failovers = all.filter((e) => /failover|router/i.test(e.type));
  const verification = all.filter((e) => /verif|review/i.test(e.type));
  // Persisted FG-8/FG-9 receipts carry the measured savings the R39/R40 corpus never recorded.
  let receipts = { sustainability: [], optimizationDecisions: [], optimizationReceipts: [] };
  try {
    const items = await persistence.getWorkItems(sessionId);
    receipts.sustainability = items
      .filter((i) => i.kind === "forgegreen_sustainability_receipt")
      .map((i) => ({ tokensAvoided: i.tokensAvoided, duplicateActionsSuppressed: i.duplicateActionsSuppressed, toolOutputBytesAvoided: i.toolOutputBytesAvoided, measurementStatus: i.measurementStatus, fallbackUsed: i.fallbackUsed }));
    receipts.optimizationDecisions = items
      .filter((i) => i.kind === "forgegreen_optimization_decision")
      .map((i) => ({ kind: i.optimizationKind ?? i.kind, status: i.status, mode: i.mode }));
    receipts.optimizationReceipts = items
      .filter((i) => i.kind === "forgegreen_optimization_receipt")
      .map((i) => ({ quality: i.qualityResult, survivedValidation: i.survivedValidation, measuredDelta: i.measuredDelta }));
  } catch {}
  return {
    optimizationSummaries: summaries,
    duplicatesSuppressed: suppressed.filter((e) => e.payload?.reason === "forgegreen_duplicate_suppressed").length,
    suppressedTools: suppressed.map((e) => e.payload?.toolName),
    failoverEvents: failovers.length,
    verificationEvents: verification.length,
    runPolicies: summaries.map((s) => s.runPolicy).filter(Boolean),
    receipts,
    eventCount: all.length,
  };
};

const results = [];
for (const [i, task] of TASKS.entries()) {
  if (ONLY && !ONLY.has(task.id)) continue;
  const order = i % 2 === 0 ? ARMS : [...ARMS].reverse();
  const pair = { task: task.id, cls: task.cls, arms: {} };
  for (const arm of order) {
    const repoDir = makeRepo(task);
    const sessionId = `r42-${task.id}-${arm}`;
    const persistence = createSessionPersistence({ dbPath: path.join(os.tmpdir(), `${sessionId}.db`) });
    await persistence.init();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), `r42-wt-${task.id}-${arm}-`));
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
    const armRec = {
      arm,
      status: result.status,
      topology: result.topology?.plan?.topology ?? result.topology ?? null,
      counters: result.counters ?? null,
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
      green,
    };
    pair.arms[arm] = armRec;
    console.log(`${task.id} ${arm}: ${armRec.status} calls=${armRec.calls} in=${armRec.inTokens} out=${armRec.outTokens} wall=${(armRec.wallMs / 1000).toFixed(1)}s err=${armRec.errors} supp=${green.duplicatesSuppressed} policies=${green.runPolicies.map((p) => `${p.initialLevel}->${p.level}(esc:${p.escalations.length})`).join("|") || "none"}`);
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
