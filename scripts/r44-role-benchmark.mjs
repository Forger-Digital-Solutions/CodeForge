// R44 subagent role-level benchmark — deterministic scripted-provider arms that measure
// each topology role in isolation through the production executeAgentRun path.
// §8: Explorer / Planner / Coder / Reviewer quality signals, not one opaque success score.
//
//   node scripts/r44-role-benchmark.mjs [outDir]
//
// Each arm scripts the realistic model behavior for its role, runs the real runtime loop
// (tool broker, edit-state gate, structured validation, budgets), then records the role's
// measurable output: turns, tool calls, editAttempts (hash supply/auto-attach/outcome),
// structuredOutput repairs/rejections, context metrics, and role-specific quality checks.
process.env.CODEFORGE_ALLOW_TEST_PROVIDERS ??= "1";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ForgeZero, createGenericFreeRecord } from "../packages/forge-zero/dist/index.js";
import { InMemoryProviderCatalog } from "../packages/providers/dist/index.js";
import { EventStore, createSessionPersistence } from "../packages/sessions/dist/index.js";
import { createAgentRuntime } from "../packages/server/dist/index.js";

const OUT_DIR = process.argv[2] ?? "docs/evidence/r44-role-benchmark";

// ---------- scripted provider ----------
class ScriptedProvider {
  constructor(providerId, responses) {
    this.providerId = providerId;
    this.isTestProvider = true;
    this.requests = [];
    this.responses = responses;
    this.callCount = 0;
  }
  async listModels() {
    return [{
      modelId: "scripted-free", displayName: "Scripted Free Model", isFree: true,
      providerId: this.providerId, accessClass: "FREE", freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }];
  }
  async chat() { throw new Error("Use streamChat"); }
  async *streamChat(req) {
    this.requests.push(req);
    const handler = this.responses[this.callCount] ?? this.responses[this.responses.length - 1];
    this.callCount++;
    if (!handler) {
      yield { type: "text_delta", delta: "Done." };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    yield* handler(req);
  }
}
const toolCall = (id, name, args) => async function* () {
  yield { type: "tool_call_started", toolCallId: id, toolName: name };
  yield { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) };
  yield { type: "usage", usage: { inputTokens: 40, outputTokens: 15 } };
  yield { type: "finish", finishReason: "tool_calls" };
};
const textTurn = (text) => async function* () {
  yield { type: "text_delta", delta: text };
  yield { type: "usage", usage: { inputTokens: 30, outputTokens: 10 } };
  yield { type: "finish", finishReason: "stop" };
};

const RW = { read: true, search: true, write: true, executeCommand: true, network: false };
const RO = { read: true, search: true, write: false, executeCommand: false, network: false };
const REVIEWER = { read: true, search: true, write: false, executeCommand: false, network: false };

// ---------- fixtures ----------
const seed = async (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
};

// ---------- arms ----------
const ARMS = [
  {
    id: "explorer-discovery",
    role: "explorer",
    permissions: RO,
    goal: "Find the entry point and the files that import src/lib.mjs.",
    files: {
      "src/index.mjs": "import { run } from './lib.mjs';\nrun();\n",
      "src/lib.mjs": "export function run() { return 1; }\n",
      "src/other.mjs": "export const o = 0;\n",
      "README.md": "# f\n",
    },
    responses: [
      toolCall("t1", "list_files", { path: "." }),
      toolCall("t2", "read_file", { path: "src/index.mjs" }),
      toolCall("t3", "read_file", { path: "src/lib.mjs" }),
      textTurn(JSON.stringify({
        summary: "Entry point src/index.mjs imports and calls lib.run().",
        findings: [{ id: "f1", severity: "advisory", category: "architecture", message: "src/index.mjs is the entry point", path: "src/index.mjs", evidence: "src/index.mjs imports lib.mjs" }],
        evidence: [{ kind: "file", ref: "src/index.mjs", description: "imports lib.mjs" }],
      })),
    ],
    structuredOutput: "explorer",
    checks: [
      ["returns structured explorer findings with evidence", (r) => r.structuredData?.findings?.length >= 1],
      ["completes within the 10-turn budget without hitting it", (r) => r.usage.requestCount <= 6],
      ["makes zero write attempts", (r) => (r.contextMetrics?.editAttempts ?? []).length === 0],
    ],
  },
  {
    id: "planner-task-graph",
    role: "planner",
    permissions: RO,
    goal: "Plan adding a priority field to the job schema, handler, and client.",
    files: {
      "src/schema.mjs": "export function validateJob(j) { return j; }\n",
      "src/handler.mjs": "export function enqueue(j) { return 1; }\n",
      "src/client.mjs": "export function submitJob(t) { return t; }\n",
    },
    responses: [
      toolCall("t1", "read_file", { path: "src/schema.mjs" }),
      toolCall("t2", "read_file", { path: "src/handler.mjs" }),
      textTurn(JSON.stringify({
        protocol: "task_graph_v1", summary: "Add priority through schema→handler→client.",
        tasks: [
          { id: "t1", title: "schema", objective: "extend validateJob", dependencies: [], assignedRole: "coder" },
          { id: "t2", title: "handler", objective: "store validated job", dependencies: ["t1"], assignedRole: "coder" },
          { id: "t3", title: "client", objective: "pass priority", dependencies: ["t2"], assignedRole: "coder" },
        ],
      })),
    ],
    structuredOutput: "planner",
    checks: [
      ["emits a parseable task graph", (r) => Array.isArray(r.structuredData?.tasks)],
      ["graph is acyclic and ordered", (r) => (r.structuredData?.tasks ?? []).length === 3],
      ["references real files before planning", (r) => r.usage.toolCount >= 2],
    ],
  },
  {
    id: "coder-first-edit",
    role: "coder",
    permissions: RW,
    goal: "Fix add() to return a + b.",
    files: { "src/calc.ts": "export function add(a: number, b: number) { return a - b; }\n" },
    responses: [
      toolCall("t1", "read_file", { path: "src/calc.ts" }),
      toolCall("t2", "edit_file", { path: "src/calc.ts", oldText: "return a - b;", newText: "return a + b;" }),
      toolCall("t3", "run_command", { command: "node -e \"const m=await import('./src/calc.ts')\"" }),
      textTurn("Fixed and verified."),
    ],
    checks: [
      ["first edit succeeds — read→hash auto-attach→edit in one pass", (r) => {
        const a = r.contextMetrics?.editAttempts?.[0];
        return a?.outcome === "success" && a.hashAutoAttached === true;
      }],
      ["no redundant rereads before the successful edit", (r) => r.usage.requestCount <= 4],
      ["exactly one mutation attempt total", (r) => (r.contextMetrics?.editAttempts ?? []).length === 1],
    ],
  },
  {
    id: "coder-stale-recovery",
    role: "coder",
    permissions: RW,
    goal: "Update mode flag.",
    files: { "src/state.ts": "export const mode = 'a';\n" },
    mutateBetween: "src/state.ts",
    responses: [
      toolCall("t1", "read_file", { path: "src/state.ts" }),
      toolCall("t2", "edit_file", { path: "src/state.ts", oldText: "'a'", newText: "'b'" }),
      toolCall("t3", "read_file", { path: "src/state.ts" }),
      toolCall("t4", "edit_file", { path: "src/state.ts", oldText: "'externally-changed'", newText: "'b'" }),
      textTurn("Recovered after external mutation."),
    ],
    checks: [
      ["stale hash fails closed with CONTEXT_EVIDENCE_STALE", (r) =>
        r.contextMetrics?.editAttempts?.[0]?.failureClass === "stale_hash"],
      ["recovery edit succeeds after the reread", (r) =>
        r.contextMetrics?.editAttempts?.[1]?.outcome === "success"],
    ],
  },
  {
    id: "reviewer-fenced-verdict",
    role: "reviewer",
    permissions: REVIEWER,
    goal: "Review the change in src/impl.ts.",
    files: {
      "src/impl.ts": "export function check(x: number) { return x > 0; }\n",
      "diff.patch": "@@ check\n+export function check(x) { return x > 0; }\n",
    },
    responses: [
      toolCall("t1", "read_file", { path: "src/impl.ts" }),
      textTurn("Here is my review.\n```json\n{\"verdict\":\"pass\",\"summary\":\"Change is correct\",\"findings\":[]}\n```"),
    ],
    structuredOutput: "reviewer",
    checks: [
      ["fenced JSON is recovered by bounded repair, not rejected", (r) => r.structuredData?.verdict === "pass"],
      ["the applied repair strategy is recorded", (r) =>
        (r.contextMetrics?.structuredOutput?.repairStrategies ?? []).length > 0],
    ],
  },
  {
    id: "reviewer-invalid-blocks",
    role: "reviewer",
    permissions: REVIEWER,
    goal: "Review the change in src/impl.ts.",
    files: { "src/impl.ts": "export const x = 1;\n" },
    responses: [
      textTurn("This looks mostly fine, I'd approve it honestly."),
      textTurn("Still looks fine to me, ship it."),
    ],
    structuredOutput: "reviewer",
    checks: [
      ["prose verdicts never become valid structured output", (r) => r.structuredData === undefined],
      ["exhaustion reports AGENT_INVALID_STRUCTURED_OUTPUT", (r) =>
        r.contextMetrics?.structuredOutput?.exhausted === true && r.status !== "completed"],
    ],
  },
];

// ---------- runner ----------
const results = [];
const checksOut = [];
for (const arm of ARMS) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `cf-r44-role-${arm.id}-`));
  const persistence = createSessionPersistence();
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord({ providerId: "bench-provider", modelId: "scripted-free" }));
  const catalog = new InMemoryProviderCatalog();
  const provider = new ScriptedProvider("bench-provider", arm.responses);
  catalog.register(provider);
  await seed(tmpDir, arm.files);
  const runtime = createAgentRuntime({ sessionId: `r44-role-${arm.id}`, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: tmpDir });

  if (arm.mutateBetween) {
    const target = path.join(tmpDir, arm.mutateBetween);
    const orig = arm.responses[1];
    arm.responses[1] = async function* (req) {
      await writeFile(target, "export const mode = 'externally-changed';\n");
      yield* orig(req);
    };
  }

  let result;
  try {
    result = await runtime.executeAgentRun({
      runId: `run-${arm.id}`, agentId: arm.role, role: arm.role, goal: arm.goal,
      workspaceId: "ws", workspacePath: tmpDir, permissions: arm.permissions,
      structuredOutput: arm.structuredOutput,
    });
  } catch (e) {
    result = { status: "error", error: String(e?.message).slice(0, 200) };
  }

  const cm = result.contextMetrics ?? {};
  const rec = {
    id: arm.id, role: arm.role, status: result.status, stopReason: result.stopReason,
    usage: result.usage ?? null,
    editAttempts: cm.editAttempts ?? [],
    structuredOutput: cm.structuredOutput ?? null,
    contextBytes: cm.contextBytes ?? null,
    filesChanged: result.filesChanged ?? [],
  };
  for (const [name, fn] of arm.checks) {
    let pass = false;
    try { pass = !!fn(result); } catch { pass = false; }
    checksOut.push({ arm: arm.id, role: arm.role, name, pass });
    console.log(`${pass ? "PASS" : "FAIL"} ${arm.id} :: ${name}`);
  }
  results.push(rec);
  persistence.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

const failed = checksOut.filter((c) => !c.pass);
await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, "R44-SUBAGENT-ROLE-BENCHMARK.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  evidenceClass: "deterministic scripted-provider arms through production executeAgentRun",
  arms: results, checks: checksOut,
  totals: { pass: checksOut.length - failed.length, fail: failed.length },
}, null, 2));
console.log(`R44 role benchmark: ${checksOut.length - failed.length}/${checksOut.length} checks pass → ${OUT_DIR}`);
process.exit(failed.length ? 1 : 0);
