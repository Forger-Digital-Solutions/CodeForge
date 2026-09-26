// R45 Explorer forensics — §5/§6. Drives scripted explorer runs through the production
// executeAgentRun path and classifies every traced tool call against ground truth:
//   NECESSARY | USEFUL | DUPLICATE | SERIALIZED_BUT_BATCHABLE | LOW_INFORMATION | RECOVERY
// Behavior arms model real free-model patterns: packet-reliant, serial navigator, batcher,
// wanderer, re-reader. Emits docs/evidence/r45-normal-topology/R45-EXPLORER-FORENSICS.json.
//
//   node scripts/r45-explorer-forensics.mjs [outFile]
process.env.CODEFORGE_ALLOW_TEST_PROVIDERS ??= "1";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeZero, createGenericFreeRecord } from "../packages/forge-zero/dist/index.js";
import { InMemoryProviderCatalog } from "../packages/providers/dist/index.js";
import { EventStore, createSessionPersistence } from "../packages/sessions/dist/index.js";
import { createAgentRuntime } from "../packages/server/dist/index.js";

const OUT = process.argv[2] ?? "docs/evidence/r45-normal-topology/R45-EXPLORER-FORENSICS.json";

class ScriptedProvider {
  constructor(providerId, responses) {
    this.providerId = providerId;
    this.isTestProvider = true;
    this.requests = [];
    this.responses = responses;
    this.callCount = 0;
  }
  async listModels() {
    return [{ modelId: "scripted-free", displayName: "s", isFree: true, providerId: this.providerId, freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat() { throw new Error("Use streamChat"); }
  async *streamChat(req) {
    this.requests.push(req);
    const handler = this.responses[this.callCount] ?? this.responses[this.responses.length - 1];
    this.callCount++;
    yield* handler(req);
  }
}
const toolCall = (id, name, args) => async function* () {
  yield { type: "tool_call_started", toolCallId: id, toolName: name };
  yield { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) };
  yield { type: "usage", usage: { inputTokens: 40, outputTokens: 15 } };
  yield { type: "finish", finishReason: "tool_calls" };
};
const batchCall = (calls) => async function* () {
  for (const c of calls) {
    yield { type: "tool_call_started", toolCallId: c.id, toolName: c.name };
    yield { type: "tool_call_completed", toolCallId: c.id, toolName: c.name, arguments: JSON.stringify(c.args) };
  }
  yield { type: "usage", usage: { inputTokens: 60, outputTokens: 20 } };
  yield { type: "finish", finishReason: "tool_calls" };
};
const textTurn = (text) => async function* () {
  yield { type: "text_delta", delta: text };
  yield { type: "usage", usage: { inputTokens: 30, outputTokens: 10 } };
  yield { type: "finish", finishReason: "stop" };
};
const RO = { read: true, search: true, write: false, executeCommand: false, network: false };
const EXPLORER_JSON = JSON.stringify({
  summary: "Evidence located.", findings: [], evidence: [{ kind: "file", ref: "src/a.mjs" }],
});

// ---------- fixtures with ground-truth relevant file sets ----------
const FIXTURES = [
  {
    id: "four-file-bug",
    goal: "The test `node tests/report.test.mjs` fails: totals come out wrong. Find the root cause in normalize.",
    relevant: ["src/normalize.mjs", "src/report.mjs", "tests/report.test.mjs"],
    files: {
      "src/normalize.mjs": "export function normalize(rows) { return rows.filter(r => r.amount >= 0); }\n",
      "src/report.mjs": "import { normalize } from './normalize.mjs';\nexport function totals(rows) { return { count: normalize(rows).length }; }\n",
      "src/util.mjs": "export const pad = (s) => s;\n",
      "tests/report.test.mjs": "import { totals } from '../src/report.mjs';\nconsole.log(totals([]));\n",
    },
  },
  {
    id: "cross-ref-rename",
    goal: "Rename exported function authenticate to verifyCredentials across src/auth.mjs, its re-export in src/index.mjs, and callers in src/login.mjs and src/admin.mjs.",
    relevant: ["src/auth.mjs", "src/index.mjs", "src/login.mjs", "src/admin.mjs"],
    files: {
      "src/auth.mjs": "export function authenticate(u, p) { return u === 'a'; }\n",
      "src/index.mjs": "export { authenticate } from './auth.mjs';\n",
      "src/login.mjs": "import { authenticate } from './auth.mjs';\nexport const login = authenticate;\n",
      "src/admin.mjs": "import { authenticate } from './auth.mjs';\nexport const gate = authenticate;\n",
      "src/meta.mjs": "export const AUTH_EXPORTS = ['authenticate'];\n",
      "src/unused1.mjs": "export const a = 1;\n",
      "src/unused2.mjs": "export const b = 2;\n",
      "src/unused3.mjs": "export const c = 3;\n",
    },
  },
  {
    id: "false-positive-name",
    goal: "Fix the rounding defect so totals sum correctly. The bug is a rounding call, not in a file named after bugs.",
    relevant: ["src/money.mjs", "tests/money.test.mjs"],
    files: {
      "src/bug.mjs": "export const FIXME = 'not the real bug';\n",
      "src/money.mjs": "export function round(x) { return Math.floor(x); }\nexport function total(xs) { return xs.reduce((a, x) => a + round(x), 0); }\n",
      "src/other.mjs": "export const z = 9;\n",
      "tests/money.test.mjs": "import { total } from '../src/money.mjs';\nconsole.log(total([1.5]));\n",
    },
  },
];

// ---------- behavior arms ----------
const readSeq = (paths) => paths.map((p, i) => toolCall(`t${i}`, "read_file", { path: p }));
const ARMS = [
  { id: "packet", responses: (f) => [textTurn(EXPLORER_JSON)], note: "answers from the orientation packet on turn 1" },
  { id: "serial", responses: (f) => [...readSeq(f.relevant), textTurn(EXPLORER_JSON)], note: "R44 pattern: one read per turn" },
  { id: "batch", responses: (f) => [batchCall(f.relevant.map((p, i) => ({ id: `t${i}`, name: "read_file", args: { path: p } }))), textTurn(EXPLORER_JSON)], note: "all reads in one turn" },
  { id: "wander", responses: (f) => [toolCall("w", "list_files", { path: "." }), ...readSeq(["README.md", ...f.relevant]), textTurn(EXPLORER_JSON)], note: "navigates before reading" },
  { id: "reread", responses: (f) => [...readSeq([f.relevant[0], f.relevant[0], ...f.relevant.slice(1)]), textTurn(EXPLORER_JSON)], note: "re-reads a file it already has" },
];

// ---------- classifier ----------
const READ_ONLY = new Set(["read_file", "list_files", "search_files", "repo_search", "repo_symbol", "repo_references", "repo_dependencies", "repo_tests", "repo_context"]);
function classify(trace, relevant) {
  const rel = new Set(relevant);
  const seen = new Map();
  const classes = [];
  const readCalls = trace.flatMap((t) => t.calls.filter((c) => READ_ONLY.has(c.tool)).map((c) => ({ ...c, turn: t.turn, batchSize: t.batchSize })));
  for (const turn of trace) {
    for (const call of turn.calls) {
      const key = `${call.tool}:${call.target ?? ""}`;
      let cls;
      if (call.outcome === "denied") cls = "denied";
      else if (call.outcome === "suppressed") cls = "duplicate_suppressed";
      else if (call.outcome === "failed" || (call.bytes ?? 1) < 24) cls = "low_information";
      else if (seen.has(key)) cls = seen.get(key).failed ? "recovery" : "duplicate";
      else if (call.target && rel.has(call.target)) cls = "necessary";
      else if (!READ_ONLY.has(call.tool)) cls = "other";
      else cls = "useful";
      classes.push({ turn: turn.turn, tool: call.tool, target: call.target, outcome: call.outcome, class: cls, batchSize: turn.batchSize });
      seen.set(key, { failed: call.outcome === "failed" });
    }
  }
  // serialized-but-batchable: read-only calls in separate batch-1 turns where every target was
  // already discoverable (it appears in `relevant` or was listable) — i.e. no dependency on
  // the previous call's result. A read of a file named by the orientation packet qualifies.
  const singleReads = classes.filter((c) => c.batchSize === 1 && READ_ONLY.has(c.tool) && c.outcome === "success" && c.target);
  for (let i = 1; i < singleReads.length; i++) {
    const c = singleReads[i];
    if (rel.has(c.target) && c.class !== "duplicate") c.class = "serialized_but_batchable";
  }
  return classes;
}

// ---------- runner ----------
const results = [];
for (const fixture of FIXTURES) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `r45-forensics-${fixture.id}-`));
  for (const [rel, content] of Object.entries(fixture.files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  for (const arm of ARMS) {
    const persistence = createSessionPersistence();
    const eventStore = new EventStore();
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "free-model-1" }));
    const catalog = new InMemoryProviderCatalog();
    const provider = new ScriptedProvider("test-provider", arm.responses(fixture));
    catalog.register(provider);
    const runtime = createAgentRuntime({ sessionId: `r45-${fixture.id}-${arm.id}`, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: dir });
    const result = await runtime.executeAgentRun({
      runId: `run-${fixture.id}-${arm.id}`, agentId: "explorer", role: "explorer",
      goal: fixture.goal, workspaceId: "ws", workspacePath: dir,
      permissions: RO, structuredOutput: "explorer",
    });
    const trace = result.contextMetrics?.toolTrace ?? [];
    const calls = classify(trace, fixture.relevant);
    const byClass = {};
    for (const c of calls) byClass[c.class] = (byClass[c.class] ?? 0) + 1;
    const filesRead = new Set(calls.filter((c) => c.tool === "read_file" && c.outcome === "success").map((c) => c.target));
    const relevantRead = fixture.relevant.filter((p) => filesRead.has(p));
    const briefMeta = result.contextMetrics?.explorationBrief ?? null;
    const briefPaths = new Set(briefMeta?.candidatePaths ?? []);
    const briefHits = fixture.relevant.filter((p) => briefPaths.has(p));
    results.push({
      fixture: fixture.id, arm: arm.id, status: result.status,
      turns: result.usage.requestCount, toolCalls: calls.length,
      adaptiveBudget: result.contextMetrics?.adaptiveTurnBudget ?? null,
      brief: briefMeta,
      briefRecall: fixture.relevant.length ? briefHits.length / fixture.relevant.length : 1,
      classes: byClass,
      relevantFilesRead: relevantRead.length, relevantTotal: fixture.relevant.length,
      recall: fixture.relevant.length ? relevantRead.length / fixture.relevant.length : 1,
      trace: calls,
    });
    console.log(`${fixture.id}/${arm.id}: ${result.status} turns=${result.usage.requestCount} calls=${calls.length} readRecall=${relevantRead.length}/${fixture.relevant.length} briefRecall=${briefHits.length}/${fixture.relevant.length} classes=${JSON.stringify(byClass)} budget=${result.contextMetrics?.adaptiveTurnBudget ? `${result.contextMetrics.adaptiveTurnBudget.original}->${result.contextMetrics.adaptiveTurnBudget.applied}` : "full"}`);
  }
  await fs.rm(dir, { recursive: true, force: true });
}

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify({ at: new Date().toISOString(), fixtures: FIXTURES.map((f) => ({ id: f.id, relevant: f.relevant })), results }, null, 2) + "\n");
console.log(`\nwrote ${OUT}`);
