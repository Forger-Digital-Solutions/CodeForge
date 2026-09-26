// R43 ForgeGreen suppression + multi-file paired A/B corpus.
// Same production autonomous orchestrator as r42-forgegreen-ab.mjs. Two task classes:
//   suppression — realistic work where identical read-only calls plausibly repeat in-run
//     (hub modules re-read across consumer edits, hash-refresh rereads before edit, a
//     >4KB file read that also exercises tool-output compression, a failing-test repair loop).
//   multifile — coordinated multi-file changes (Mission C): renames, contracts, impl+tests,
//     helper moves, signature changes, plus R42's two weakest cases re-measured.
// Arms: baseline (all controls off) | green (production selective policy). Optional
// green-forced (R43_ARMS=baseline,green,green-forced) prices FULL admission on coder runs.
// Harvests per-run: policy level/escalations/preventedReplays, suppressions, evidence
// denials, verification, review, failover, usage. Real providers only; no secrets logged.
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

const OUT = process.argv[2] ?? "docs/evidence/r43-green-suppression/R43-LIVE-SUPPRESSION.json";
const ONLY = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const ARMS = (process.env.R43_ARMS ?? "baseline,green").split(",");
const KIND = process.env.R43_KIND ? new Set(process.env.R43_KIND.split(",")) : null;

// A ~40KB generated module: large enough that read_file output crosses the 4KB
// compression threshold and any re-read is a real suppression opportunity.
const bigRows = Array.from({ length: 900 }, (_, i) =>
  `  { id: "ROW-${String(i).padStart(4, "0")}", flag: ${i % 7 === 0}, weight: ${(i * 13) % 97}, note: "generated fixture row ${i} with a medium-length descriptive note" },`
).join("\n");
const BIG_DATA = `export const ROWS = [\n${bigRows}\n];\nexport const ROW_COUNT = ${900};\n`;

const TASKS = [
  // ---------------- suppression-oriented --------------------------------------
  {
    id: "hub-consumers",
    kind: "suppression",
    cls: "medium",
    goal: "Add and export an `init()` function in src/store.mjs that returns 'ready'. Then update each consumer (src/a.mjs, src/b.mjs, src/c.mjs, src/d.mjs) to import init from './store.mjs' and call it inside their existing exported function, storing the result in a local variable.",
    files: {
      "src/store.mjs": "export const NAME = 'store';\nexport function register(k, v) { return { k, v }; }\n",
      "src/a.mjs": "import { register } from './store.mjs';\nexport function a() { return register('a', 1); }\n",
      "src/b.mjs": "import { register } from './store.mjs';\nexport function b() { return register('b', 2); }\n",
      "src/c.mjs": "import { register } from './store.mjs';\nexport function c() { return register('c', 3); }\n",
      "src/d.mjs": "import { register } from './store.mjs';\nexport function d() { return register('d', 4); }\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const s=await import('./src/store.mjs');const a=await import('./src/a.mjs');if(typeof s.init!=='function'||s.init()!=='ready')process.exit(1)\""],
  },
  {
    id: "big-data-edit",
    kind: "suppression",
    cls: "small",
    goal: "In src/data.mjs, find the row with id 'ROW-0420' and set its flag to true. Do not change any other row.",
    files: {
      "src/data.mjs": BIG_DATA,
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const m=await import('./src/data.mjs');const r=m.ROWS.find(r=>r.id==='ROW-0420');if(!r||r.flag!==true)process.exit(1);if(m.ROWS.length!==900)process.exit(1)\""],
  },
  {
    id: "meta-update",
    kind: "suppression",
    cls: "tiny",
    goal: "Update package.json: set version to '2.0.0' and add a 'description' field with value 'fixture app'. Read the file carefully before editing.",
    files: {
      "package.json": "{\n  \"name\": \"fixture-app\",\n  \"version\": \"1.0.0\",\n  \"main\": \"index.mjs\"\n}\n",
      "index.mjs": "export const ok = true;\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const fs=await import('node:fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(p.version!=='2.0.0'||p.description!=='fixture app')process.exit(1)\""],
  },
  {
    id: "repair-loop",
    kind: "suppression",
    cls: "small",
    goal: "Run the test `node tests/parse.test.mjs` — it fails. Fix the bug in src/parse.mjs so the test passes, then run the test again to confirm.",
    files: {
      "src/parse.mjs": "export function parsePair(s) {\n  const [k, v] = s.split('=');\n  return { key: k, value: v };\n}\n",
      "tests/parse.test.mjs": "import assert from 'node:assert';\nimport { parsePair } from '../src/parse.mjs';\nconst r = parsePair('color=blue');\nassert.strictEqual(r.key, 'color');\nassert.strictEqual(r.value, 'blue');\nconst empty = parsePair('');\nassert.strictEqual(empty.key, '');\nconsole.log('parse test ok');\n",
      "README.md": "# fixture\n",
    },
    verify: ["node tests/parse.test.mjs"],
  },
  {
    id: "search-inventory",
    kind: "suppression",
    cls: "small",
    goal: "Inventory the codebase: list the files in src/, read each exported symbol in src/lib.mjs, then update src/report.mjs so REPORT.files lists every file present under src/ and REPORT.count equals the number of exported functions in src/lib.mjs.",
    files: {
      "src/lib.mjs": "export function alpha() { return 1; }\nexport function beta() { return 2; }\nexport function gamma() { return 3; }\n",
      "src/extra.mjs": "export const UNUSED = 0;\n",
      "src/report.mjs": "export const REPORT = { files: [], count: 0 };\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const m=await import('./src/report.mjs');if(m.REPORT.count!==3)process.exit(1);if(!m.REPORT.files.includes('lib.mjs'))process.exit(1)\""],
  },
  {
    // 24-file exploration: the hub module is imported by most spokes, so mapping the
    // codebase naturally revisits it — the widest honest net for identical repeat reads.
    id: "wide-explore",
    kind: "suppression",
    cls: "medium",
    goal: "Write REPORT.md in the repo root containing: (1) the list of files under src/, (2) every file that imports from './store.mjs', (3) the exported symbol names in src/store.mjs. Investigate the actual files; do not guess.",
    files: Object.fromEntries([
      ["src/store.mjs", "export function register(k, v) { return { k, v }; }\nexport function lookup(k) { return k; }\nexport const STORE_NAME = 'central';\n"],
      ...Array.from({ length: 20 }, (_, i) => [
        `src/mod${String(i).padStart(2, "0")}.mjs`,
        i % 3 === 0
          ? `import { register, lookup } from './store.mjs';\nexport function m${i}() { return register('m${i}', ${i}); }\n`
          : `export function m${i}() { return ${i}; }\n`,
      ]),
      ["src/unrelated1.mjs", "export const U1 = 1;\n"],
      ["src/unrelated2.mjs", "export const U2 = 2;\n"],
      ["README.md", "# fixture\n"],
    ]),
    verify: ["node -e \"const fs=await import('node:fs');const t=fs.readFileSync('REPORT.md','utf8');if(!/store\\.mjs/.test(t))process.exit(1);if(!/mod00/.test(t))process.exit(2);if(!/register/.test(t))process.exit(3)\""],
  },
  // ---------------- multi-file coordinated (Mission C) ------------------------
  {
    id: "mf-rename",
    kind: "multifile",
    cls: "medium",
    goal: "Rename the exported function `connect` to `open` in src/net.mjs and update every call site: src/client.mjs, src/server.mjs, and src/pool.mjs. Keep behavior identical.",
    files: {
      "src/net.mjs": "export function connect(host) { return { host, state: 'open' }; }\n",
      "src/client.mjs": "import { connect } from './net.mjs';\nexport function startClient(h) { return connect(h).state; }\n",
      "src/server.mjs": "import { connect } from './net.mjs';\nexport function startServer(h) { return connect(h).host; }\n",
      "src/pool.mjs": "import { connect } from './net.mjs';\nexport function warm(h) { return [connect(h), connect(h)].length; }\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const n=await import('./src/net.mjs');if(typeof n.open!=='function')process.exit(1);const p=await import('./src/pool.mjs');if(p.warm('h')!==2)process.exit(1);const s=await import('./src/server.mjs');if(s.startServer('h')!=='h')process.exit(1)\""],
  },
  {
    id: "mf-contract",
    kind: "multifile",
    cls: "medium",
    goal: "Create src/contract.mjs exporting `validateInput(x)` which returns { ok: true, value: x.trim() } for non-empty strings and { ok: false } otherwise. Implement `process` in src/pipeline.mjs that uses validateInput and throws TypeError on invalid input. Update src/api.mjs so its `submit(text)` calls pipeline.process.",
    files: {
      "src/api.mjs": "export function submit(text) { return { submitted: text }; }\n",
      "src/pipeline.mjs": "export function process(x) { return x; }\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const c=await import('./src/contract.mjs');const p=await import('./src/pipeline.mjs');const a=await import('./src/api.mjs');if(c.validateInput('  hi ').value!=='hi')process.exit(1);let threw=false;try{p.process('')}catch(e){threw=e instanceof TypeError}if(!threw)process.exit(1)\""],
  },
  {
    id: "mf-impl-tests",
    kind: "multifile",
    cls: "medium",
    goal: "Implement `chunk(arr, n)` in src/arrays.mjs splitting an array into chunks of size n. Then update tests/arrays.test.mjs so its assertions match the implemented behavior: chunk([1,2,3,4,5],2) returns [[1,2],[3,4],[5]] and chunk([],3) returns [].",
    files: {
      "src/arrays.mjs": "export function chunk(arr, n) {\n  return arr;\n}\n",
      "tests/arrays.test.mjs": "import assert from 'node:assert';\nimport { chunk } from '../src/arrays.mjs';\nassert.deepStrictEqual(chunk([1,2,3,4,5],2), [[1,2],[3,4],[5]]);\nassert.deepStrictEqual(chunk([],3), []);\nconsole.log('arrays ok');\n",
      "README.md": "# fixture\n",
    },
    verify: ["node tests/arrays.test.mjs", "node -e \"const m=await import('./src/arrays.mjs');if(JSON.stringify(m.chunk([1,2,3],1))!=='[[1],[2],[3]]')process.exit(1)\""],
  },
  {
    id: "mf-move-helper",
    kind: "multifile",
    cls: "medium",
    goal: "Move the function `cap` from src/util.mjs to a new file src/text.mjs (export it there and remove it from util.mjs). Update the importers src/format.mjs and src/banner.mjs to import cap from './text.mjs'.",
    files: {
      "src/util.mjs": "export function cap(s) { return s[0].toUpperCase() + s.slice(1); }\nexport function lower(s) { return s.toLowerCase(); }\n",
      "src/format.mjs": "import { cap } from './util.mjs';\nexport function title(s) { return cap(s); }\n",
      "src/banner.mjs": "import { cap } from './util.mjs';\nexport function banner(s) { return '*** ' + cap(s) + ' ***'; }\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const t=await import('./src/text.mjs');const f=await import('./src/format.mjs');const b=await import('./src/banner.mjs');const u=await import('./src/util.mjs');if(t.cap('abc')!=='Abc'||f.title('x')!=='X'||b.banner('y')!=='*** Y ***')process.exit(1);if('cap' in u)process.exit(2)\""],
  },
  {
    id: "mf-dep-callsite",
    kind: "multifile",
    cls: "medium",
    goal: "Change `parse` in src/parser.mjs to accept a second options parameter `{ strict = false }`; in strict mode it must throw on empty input instead of returning null. Update the call sites in src/loader.mjs and src/cli.mjs to pass { strict: true }.",
    files: {
      "src/parser.mjs": "export function parse(input) {\n  if (!input) return null;\n  return { input };\n}\n",
      "src/loader.mjs": "import { parse } from './parser.mjs';\nexport function load(s) { return parse(s); }\n",
      "src/cli.mjs": "import { parse } from './parser.mjs';\nexport function run(s) { const r = parse(s); return r ? r.input : 'empty'; }\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const p=await import('./src/parser.mjs');let threw=false;try{p.parse('',{strict:true})}catch{threw=true}if(!threw)process.exit(1);if(p.parse('x')===null)process.exit(2);const l=await import('./src/loader.mjs');let t2=false;try{l.load('')}catch{t2=true}if(!t2)process.exit(3)\""],
  },
  {
    id: "multi-file",
    kind: "multifile",
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
    id: "coordinated-api",
    kind: "multifile",
    cls: "medium",
    goal: "Create src/format.mjs exporting `fmt(n)` that formats a number with two decimals. Then update src/price.mjs and src/label.mjs so `price(x)` and `label(x)` both return strings built via fmt. price returns 'USD ' + fmt(x); label returns '#' + fmt(x).",
    files: {
      "src/price.mjs": "export function price(x) { return 'USD ' + x.toFixed(2); }\n",
      "src/label.mjs": "export function label(x) { return '#' + x.toFixed(2); }\n",
      "README.md": "# fixture\n",
    },
    verify: ["node -e \"const p=await import('./src/price.mjs');const l=await import('./src/label.mjs');const f=await import('./src/format.mjs');if(p.price(1)!=='USD 1.00'||l.label(1)!=='#1.00'||f.fmt(2)!=='2.00')process.exit(1)\""],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r43-${task.id}-`));
  for (const [rel, content] of Object.entries(task.files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=r43@dev", "-c", "user.name=r43", "commit", "-qm", "init"], { cwd: dir });
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
  } catch {}
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
    eventCount: all.length,
  };
};

const results = [];
for (const [i, task] of TASKS.entries()) {
  if (ONLY && !ONLY.has(task.id)) continue;
  if (KIND && !KIND.has(task.kind)) continue;
  const order = i % 2 === 0 ? ARMS : [...ARMS].reverse();
  const pair = { task: task.id, kind: task.kind, cls: task.cls, arms: {} };
  for (const arm of order) {
    const repoDir = makeRepo(task);
    const sessionId = `r43-${task.id}-${arm}`;
    const persistence = createSessionPersistence({ dbPath: path.join(os.tmpdir(), `${sessionId}.db`) });
    await persistence.init();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), `r43-wt-${task.id}-${arm}-`));
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
    console.log(`${task.id} ${arm}: ${armRec.status} calls=${armRec.calls} in=${armRec.inTokens} out=${armRec.outTokens} wall=${(armRec.wallMs / 1000).toFixed(1)}s err=${armRec.errors} supp=${green.duplicatesSuppressed} deny=${green.suppressionDenials.length} prevented=${green.runPolicies.reduce((a, p) => a + p.preventedReplays, 0)} policies=${green.runPolicies.map((p) => `${p.initialLevel}->${p.level}(esc:${p.escalations.length})`).join("|") || "none"}`);
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
