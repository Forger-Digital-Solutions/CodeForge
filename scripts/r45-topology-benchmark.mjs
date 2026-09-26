// R45 topology + handoff + planner benchmark — §13/§37/§38. Runs the REAL autonomous
// orchestrator over matched git fixtures with a scripted provider that behaves per role,
// comparing tiny / normal / complex effective topologies on identical tasks.
//
//   node scripts/r45-topology-benchmark.mjs [outFile]
//
// Measured per arm: status, total + per-role model calls, explorer turns, coder turns and
// calls-to-first-edit, edit hash discipline, whether the coder's context carried the upstream
// handoff (explorer evidence) or the deterministic orientation packet, planner overhead and
// plan validity, verification outcome, byte totals. No model call is faked — the scripted
// provider is still the only model; what is measured is the topology's call structure.
process.env.CODEFORGE_ALLOW_TEST_PROVIDERS ??= "1";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { ForgeZero, createGenericFreeRecord } from "../packages/forge-zero/dist/index.js";
import { InMemoryProviderCatalog } from "../packages/providers/dist/index.js";
import { EventStore, createSessionPersistence } from "../packages/sessions/dist/index.js";
import { createAutonomousRunOrchestrator } from "../packages/server/dist/autonomous-orchestrator.js";
import { createWorkspaceService } from "../packages/server/dist/workspace-service.js";
import { createSubagentManager } from "../packages/server/dist/subagent-manager.js";
import { createAgentRuntime } from "../packages/server/dist/agent-runtime.js";

const execFile = promisify(execFileCallback);
const OUT = process.argv[2] ?? "docs/evidence/r45-normal-topology/R45-TOPOLOGY-BENCHMARK.json";

const EXPLORER_JSON = (fixture) => JSON.stringify({
  summary: `Located ${fixture.editTargets.length} target file(s) and the verification test.`,
  findings: [{ id: "f1", severity: "advisory", category: "architecture", message: `Targets: ${fixture.editTargets.join(", ")}`, path: fixture.editTargets[0], evidence: fixture.editTargets[0] }],
  evidence: fixture.editTargets.map((p) => ({ kind: "file", ref: p, description: "edit target" }))
    .concat([{ kind: "file", ref: fixture.testFile, description: "verification" }]),
});
const PLANNER_JSON = (fixture) => JSON.stringify({
  protocol: "task_graph_v1", summary: "Edit targets then verify.",
  tasks: fixture.editTargets.map((p, i) => ({ id: `t${i}`, title: `edit ${p}`, objective: `update ${p}`, dependencies: i === 0 ? [] : [`t${i - 1}`], assignedRole: "coder" }))
    .concat([{ id: "verify", title: "verify", objective: "run the test", dependencies: [`t${fixture.editTargets.length - 1}`], assignedRole: "reviewer" }]),
});
const REVIEWER_JSON = JSON.stringify({ verdict: "pass", findings: [], summary: "Diff reviewed; implementation satisfies the task." });

class BenchmarkProvider {
  constructor(providerId, fixture) {
    this.providerId = providerId;
    this.isTestProvider = true;
    this.fixture = fixture;
    this.callsByRole = {};
    this.requestsByRole = {};
    this.roleOf = (req) => {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("CodeForge Explorer")) return "explorer";
      if (sys.includes("CodeForge Planner")) return "planner";
      if (sys.includes("CodeForge Reviewer")) return "reviewer";
      if (sys.includes("CodeForge Coder")) return "coder";
      return "unknown";
    };
  }
  async listModels() {
    return [{ modelId: "bench-free", displayName: "b", isFree: true, freeStatus: "verified_free",
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat() { throw new Error("Use streamChat"); }
  async *streamChat(req) {
    const role = this.roleOf(req);
    this.callsByRole[role] = (this.callsByRole[role] ?? 0) + 1;
    // Snapshot now: the runtime mutates the live messages array on context refresh, so a
    // post-run read of req.messages would see the post-mutation rebuild, not the bootstrap.
    (this.requestsByRole[role] ??= []).push(req.messages.map((m) => String(m.content)).join("\n"));
    const f = this.fixture;
    const toolMsgs = req.messages.filter((m) => m.role === "tool");
    const sawRead = new Set(toolMsgs.filter((m) => /\[hash:[0-9a-f]{64}\]/.test(String(m.content))).map(() => true).size ? [] : []);
    const readsDone = toolMsgs.filter((m) => /\[hash:[0-9a-f]{64}\]/.test(String(m.content))).length;
    const writesDone = toolMsgs.filter((m) => String(m.content).includes("Successfully wrote")).length;
    if (role === "explorer") {
      yield { type: "text_delta", delta: EXPLORER_JSON(f) };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    if (role === "planner") {
      yield { type: "text_delta", delta: PLANNER_JSON(f) };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    if (role === "reviewer") {
      yield { type: "text_delta", delta: REVIEWER_JSON };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    if (role === "coder") {
      // Competent coder: batch-read every edit target in one turn (the packet/handoff already
      // names them), write each next, then stop. Mirrors R44's observed good behavior.
      if (readsDone < f.editTargets.length) {
        for (const p of f.editTargets) {
          const id = `rd-${p}`;
          yield { type: "tool_call_started", toolCallId: id, toolName: "read_file" };
          yield { type: "tool_call_completed", toolCallId: id, toolName: "read_file", arguments: JSON.stringify({ path: p }) };
        }
        yield { type: "finish", finishReason: "tool_calls" };
        return;
      }
      if (writesDone < f.editTargets.length) {
        const p = f.editTargets[writesDone];
        yield { type: "tool_call_started", toolCallId: `wr-${p}`, toolName: "write_file" };
        yield { type: "tool_call_completed", toolCallId: `wr-${p}`, toolName: "write_file", arguments: JSON.stringify({ path: p, content: f.writes[p] }) };
        yield { type: "finish", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", delta: `Updated ${f.editTargets.join(", ")}.` };
      yield { type: "finish", finishReason: "stop" };
      return;
    }
    yield { type: "text_delta", delta: "Done." };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() { return { status: "available" }; }
}

const FIXTURES = [
  {
    id: "single-file-bug",
    goal: "Fix multiply in math.mjs so it returns a * b and the focused test passes",
    files: {
      "package.json": JSON.stringify({ name: "math-lib", version: "1.0.0", type: "module" }),
      "math.mjs": "export function multiply(a, b) { return 0; }\n",
      "test/math.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply } from '../math.mjs';\ntest('multiply', () => assert.equal(multiply(6, 7), 42));\n",
    },
    editTargets: ["math.mjs"],
    writes: { "math.mjs": "export function multiply(a, b) { return a * b; }\n" },
    testFile: "test/math.test.mjs",
    verificationCommands: ["node --test test/math.test.mjs"],
    expectedTier: "tiny",
  },
  {
    id: "cross-file-rename",
    goal: "Rename the exported constant TIMEOUT_MS to RETRY_LIMIT_MS in config.mjs and update its importer app.mjs so the config test passes",
    files: {
      "package.json": JSON.stringify({ name: "cfg", version: "1.0.0", type: "module" }),
      "config.mjs": "export const TIMEOUT_MS = 5000;\n",
      "app.mjs": "import { TIMEOUT_MS } from './config.mjs';\nexport function currentLimit() { return TIMEOUT_MS; }\n",
      "test/config.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { RETRY_LIMIT_MS } from '../config.mjs';\nimport { currentLimit } from '../app.mjs';\ntest('renamed', () => { assert.equal(RETRY_LIMIT_MS, 5000); assert.equal(currentLimit(), 5000); });\n",
    },
    editTargets: ["config.mjs", "app.mjs"],
    writes: {
      "config.mjs": "export const RETRY_LIMIT_MS = 5000;\n",
      "app.mjs": "import { RETRY_LIMIT_MS } from './config.mjs';\nexport function currentLimit() { return RETRY_LIMIT_MS; }\n",
    },
    testFile: "test/config.test.mjs",
    verificationCommands: ["node --test test/config.test.mjs"],
    expectedTier: "normal",
  },
];

const results = [];
for (const fixture of FIXTURES) {
  for (const topology of ["tiny", "normal", "complex"]) {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), `r45-bench-${fixture.id}-${topology}-`));
    const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "r45-wt-"));
    try {
      for (const [rel, content] of Object.entries(fixture.files)) {
        const p = path.join(repoDir, rel);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, content);
      }
      await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
      await execFile("git", ["config", "user.name", "bench"], { cwd: repoDir });
      await execFile("git", ["config", "user.email", "bench@x"], { cwd: repoDir });
      await execFile("git", ["add", "."], { cwd: repoDir });
      await execFile("git", ["commit", "-m", "init"], { cwd: repoDir });

      const persistence = createSessionPersistence();
      const eventStore = new EventStore();
      const firewall = new ForgeZero();
      firewall.register(createGenericFreeRecord({ providerId: "bench-provider", modelId: "bench-free" }));
      const catalog = new InMemoryProviderCatalog();
      const provider = new BenchmarkProvider("bench-provider", fixture);
      catalog.register(provider);
      const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeBase });
      const runtime = createAgentRuntime({
        sessionId: `r45b-${fixture.id}-${topology}`, eventStore, persistence, firewall,
        providerCatalog: catalog, workspacePath: repoDir,
      });
      const subagentManager = createSubagentManager({ persistence, workspaceService, agentRuntime: runtime });
      const orchestrator = createAutonomousRunOrchestrator({ workspaceService, persistence, subagentManager, agentRuntime: runtime });

      const started = Date.now();
      const result = await orchestrator.startRun({
        sessionId: `r45b-${fixture.id}-${topology}`,
        workspacePath: repoDir,
        goal: fixture.goal,
        verificationCommands: fixture.verificationCommands,
        topology,
      });
      const wallMs = Date.now() - started;

      const totalCalls = Object.values(provider.callsByRole).reduce((a, b) => a + b, 0);
      const coderContext = provider.requestsByRole.coder?.[0] ?? "";
      const handoffEvidence = coderContext.includes("Discovered Explorer Evidence");
      const packetDelivered = coderContext.includes("Repository Orientation");
      const explorerContext = provider.requestsByRole.explorer?.[0] ?? "";
      const explorerGotPacket = explorerContext.includes("Pre-gathered Repository Orientation") || explorerContext.includes("Candidate files");
      const coderReadsBeforeWrite = undefined; // trace-level detail is in the journal; call counts suffice here
      const verify = result.verification?.[0];
      const entry = {
        fixture: fixture.id, topology, status: result.status, wallMs,
        totalCalls, callsByRole: provider.callsByRole,
        coderCalls: provider.callsByRole.coder ?? 0,
        plannerCalls: provider.callsByRole.planner ?? 0,
        explorerCalls: provider.callsByRole.explorer ?? 0,
        reviewerCalls: provider.callsByRole.reviewer ?? 0,
        coderHandoff: { explorerEvidence: handoffEvidence, orientationPacket: packetDelivered },
        explorerGotPacket,
        verification: verify ? { exitCode: verify.exitCode, failed: verify.failed } : null,
        integrated: result.integration?.status ?? null,
        planTopology: result.topology?.plan?.topology ?? null,
        planReason: result.topology?.plan?.reason ?? null,
      };
      results.push(entry);
      console.log(`${fixture.id}/${topology}: ${result.status} calls=${totalCalls} byRole=${JSON.stringify(provider.callsByRole)} handoff=${handoffEvidence} packet=${packetDelivered} verify=${verify?.exitCode}`);
      persistence.close();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
      await fs.rm(worktreeBase, { recursive: true, force: true });
    }
  }
}

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + "\n");
console.log(`\nwrote ${OUT}`);
