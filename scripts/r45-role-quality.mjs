// R45 §32 role-quality feedback — proves that model-turn exhaustion feeds 8-Bit a
// `role_failed` observation (model-quality evidence), distinct from availability signals.
// Arm A: an explorer that wanders until the turn budget exhausts -> observation expected.
// Arm B: an explorer that answers from the packet on turn 1 -> no role_failed.
// Emits docs/evidence/r45-normal-topology/R45-ROLE-QUALITY.json.
//
//   node scripts/r45-role-quality.mjs [outFile]
process.env.CODEFORGE_ALLOW_TEST_PROVIDERS ??= "1";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeZero, createGenericFreeRecord } from "../packages/forge-zero/dist/index.js";
import { InMemoryProviderCatalog } from "../packages/providers/dist/index.js";
import { EventStore, createSessionPersistence } from "../packages/sessions/dist/index.js";
import { createAgentRuntime } from "../packages/server/dist/index.js";

const OUT = process.argv[2] ?? "docs/evidence/r45-normal-topology/R45-ROLE-QUALITY.json";

class ScriptedProvider {
  constructor(providerId, responses) {
    this.providerId = providerId;
    this.isTestProvider = true;
    this.responses = responses;
    this.callCount = 0;
  }
  async listModels() {
    return [{ modelId: "scripted-free", displayName: "s", isFree: true, providerId: this.providerId, freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat() { throw new Error("Use streamChat"); }
  async *streamChat(req) {
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
const textTurn = (text) => async function* () {
  yield { type: "text_delta", delta: text };
  yield { type: "usage", usage: { inputTokens: 30, outputTokens: 10 } };
  yield { type: "finish", finishReason: "stop" };
};
const RO = { read: true, search: true, write: false, executeCommand: false, network: false };
const EXPLORER_JSON = JSON.stringify({
  summary: "Evidence located.", findings: [], evidence: [{ kind: "file", ref: "src/normalize.mjs" }],
});

const FILES = {
  "src/normalize.mjs": "export function normalize(rows) { return rows.filter(r => r.amount >= 0); }\n",
  "src/report.mjs": "import { normalize } from './normalize.mjs';\nexport function totals(rows) { return { count: normalize(rows).length }; }\n",
  "src/util.mjs": "export const pad = (s) => s;\n",
  "tests/report.test.mjs": "import { totals } from '../src/report.mjs';\nconsole.log(totals([]));\n",
};
const GOAL = "The test `node tests/report.test.mjs` fails: totals come out wrong. Find the root cause in normalize.";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "r45-roleq-"));
for (const [rel, content] of Object.entries(FILES)) {
  const p = path.join(dir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

const arms = [
  {
    id: "wander-exhausts-budget",
    // Reads a different non-relevant file every turn; never produces the structured answer.
    responses: [
      toolCall("w1", "read_file", { path: "src/util.mjs" }),
      toolCall("w2", "repo_search", { query: "padding" }),
      toolCall("w3", "list_files", { path: "src" }),
      toolCall("w4", "read_file", { path: "src/util.mjs" }),
      toolCall("w5", "repo_search", { query: "unrelated" }),
    ],
  },
  {
    id: "packet-answers-immediately",
    responses: [textTurn(EXPLORER_JSON)],
  },
];

const results = [];
for (const arm of arms) {
  const persistence = createSessionPersistence();
  const eventStore = new EventStore();
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "free-model-1" }));
  const catalog = new InMemoryProviderCatalog();
  catalog.register(new ScriptedProvider("test-provider", arm.responses));
  const sessionId = `r45-roleq-${arm.id}`;
  const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath: dir });
  const result = await runtime.executeAgentRun({
    runId: `run-${arm.id}`, agentId: "explorer", role: "explorer",
    goal: GOAL, workspaceId: "ws", workspacePath: dir,
    permissions: RO, structuredOutput: "explorer",
    // Role observations attach to the routed route — without roleRouting the run uses a
    // caller-pinned selection and journalActiveRoute/8-Bit feedback never engage.
    roleRouting: true,
  });
  // Ledger writes queue behind the authority subscriber; give the pending chain a beat.
  let workItems = [];
  for (let i = 0; i < 20 && workItems.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    workItems = await persistence.getWorkItemsByKind("eight_bit_route_observation");
  }
  const observations = workItems.map((i) => i.observation);
  const roleFailed = observations.filter((o) => o?.kind === "role_outcome" && o?.outcome === "role_failed");
  results.push({
    arm: arm.id,
    status: result.status,
    error: result.error ?? null,
    turns: result.usage.requestCount,
    adaptiveBudget: result.contextMetrics?.adaptiveTurnBudget ?? null,
    observations: observations.length,
    roleFailedObservations: roleFailed,
    roleFailedCount: roleFailed.length,
  });
  console.log(`${arm.id}: ${result.status} turns=${result.usage.requestCount} roleFailed=${roleFailed.length} obs=${observations.length} err=${result.error ?? "-"}`);
}

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + "\n");
await fs.rm(dir, { recursive: true, force: true });
console.log(`\nwrote ${OUT}`);
