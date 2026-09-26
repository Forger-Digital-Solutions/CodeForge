// R39 ForgeGreen live A/B corpus driver (multi-provider).
// Runs real engineering tasks through the production autonomous orchestrator with real
// verified-free providers (openrouter / groq / mistral), alternating baseline vs ForgeGreen
// arms. Every call + billed usage is captured from the real adapters. No secrets are logged.
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

const OUT = process.argv[2] ?? "docs/evidence/r39-multi/forgegreen-corpus.json";
const ONLY = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const ARMS = ["baseline", "green"];

// ---- task fixtures: small real repos, one task each -------------------------
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
];

// ---- providers ---------------------------------------------------------------
const callLog = [];
const wrap = (adapter) => {
  const real = adapter;
  const probe = {
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
  return probe;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r39-${task.id}-`));
  for (const [rel, content] of Object.entries(task.files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=r39@dev", "-c", "user.name=r39", "commit", "-qm", "init"], { cwd: dir });
  return dir;
};

const results = [];
for (const [i, task] of TASKS.entries()) {
  if (ONLY && !ONLY.has(task.id)) continue;
  const order = i % 2 === 0 ? ARMS : [...ARMS].reverse(); // alternate to reduce order bias
  const pair = { task: task.id, cls: task.cls, arms: {} };
  for (const arm of order) {
    const repoDir = makeRepo(task);
    const sessionId = `r39-${task.id}-${arm}`;
    const persistence = createSessionPersistence({ dbPath: path.join(os.tmpdir(), `${sessionId}.db`) });
    await persistence.init();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), `r39-wt-${task.id}-${arm}-`));
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeDir });
    await workspaceService.init();
    const agentRuntime = createAgentRuntime({
      sessionId, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: repoDir,
      efficiencyControls: arm === "green"
        ? { duplicateSuppression: true, toolOutputCompression: true, supersededCompaction: true }
        : { duplicateSuppression: false, toolOutputCompression: false, supersededCompaction: false },
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
    const armRec = {
      arm,
      status: result.status,
      topology: result.topology?.plan?.topology ?? result.topology ?? null,
      counters: result.counters ?? null,
      wallMs: Math.round(wallMs),
      calls: calls.length,
      inTokens: calls.reduce((a, c) => a + (c.usage?.inputTokens ?? 0), 0),
      outTokens: calls.reduce((a, c) => a + (c.usage?.outputTokens ?? 0), 0),
      errors: calls.filter((c) => !c.ok).length,
      providers: [...new Set(calls.map((c) => c.provider))],
      models: [...new Set(calls.map((c) => c.model))],
      errorKinds: calls.filter((c) => !c.ok).map((c) => c.error),
    };
    pair.arms[arm] = armRec;
    console.log(`${task.id} ${arm}: ${armRec.status} calls=${armRec.calls} in=${armRec.inTokens} out=${armRec.outTokens} wall=${(armRec.wallMs / 1000).toFixed(1)}s err=${armRec.errors} providers=${armRec.providers}`);
    try { await agentRuntime.close?.(); } catch {}
    try { await workspaceService.close?.(); } catch {}
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
  // pair classification
  const b = pair.arms.baseline, g = pair.arms.green;
  pair.outcome = !b || !g ? "INCOMPARABLE"
    : b.status === "completed" && g.status === "completed" ? "BOTH_PASS"
    : b.status === "completed" ? "BASELINE_PASS_GREEN_FAIL"
    : g.status === "completed" ? "BASELINE_FAIL_GREEN_PASS" : "BOTH_FAIL";
  if (pair.outcome === "BOTH_PASS" && b.calls > 0) {
    pair.vwm = { requests: +(b.calls / Math.max(1, g.calls)).toFixed(3), inTokens: +(b.inTokens / Math.max(1, g.inTokens)).toFixed(3) };
  }
  results.push(pair);
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), providers: adapters.map((a) => a.providerId), verifiedRoutes: verified.length, pairs: results, callLog }, null, 2));
}
console.log("done →", OUT);
