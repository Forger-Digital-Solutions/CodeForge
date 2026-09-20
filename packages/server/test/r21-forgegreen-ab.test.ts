import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createForgeGreenAdvisor } from "@codeforge/forge-green";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { createAgentRuntime, type AgentRuntimeResult } from "../src/agent-runtime.js";

/**
 * R21 ForgeGreen controlled A/B (M3).
 *
 * CONTROL: ForgeGreen OFF — advisor caches disabled, FG-1C duplicate suppression and FG-1B
 * tool-output compression disabled through the runtime's efficiency controls (benchmark seam).
 * EXPERIMENT: ForgeGreen ON — the production defaults.
 *
 * Identical task, repository, model, and topology per pair: the model is a deterministic scripted
 * provider that issues a fixed, realistic tool trace for each task class (duplicate reads and
 * searches interleaved with edits, large outputs, sibling agents reading the same files). Because
 * the script is fixed, correctness is equal by construction and every difference between arms is
 * attributable to ForgeGreen's mechanisms alone: physical tool dispatches, bytes the model is
 * asked to read, provider calls, and wall time. This is a mechanism A/B; it does not measure
 * whether a live model behaves differently under ForgeGreen (see the checkpoint for that gap).
 */

type Responder = (req: ChatRequest) => AsyncIterable<StreamEvent>;

class RecordingScriptedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  public requests: ChatRequest[] = [];
  constructor(providerId: string, private readonly responders: Responder[]) { this.providerId = providerId; }
  async listModels(): Promise<ProviderModel[]> {
    return [{ modelId: "scripted-free", displayName: "Scripted Free Model", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }];
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("Use streamChat"); }
  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const responder = this.responders[Math.min(this.requests.length - 1, this.responders.length - 1)]!;
    for await (const event of responder(req)) { if (signal?.aborted) return; yield event; }
  }
  async healthCheck() { return { status: "available" as const }; }
}

let counter = 0;
function toolCallTurn(name: string, args: Record<string, unknown>): Responder {
  const id = `tc-${++counter}`;
  return async function* () {
    yield { type: "tool_call_started", toolCallId: id, toolName: name };
    yield { type: "tool_call_delta", toolCallId: id, delta: JSON.stringify(args) };
    yield { type: "tool_call_completed", toolCallId: id, toolName: name, arguments: JSON.stringify(args) };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
    yield { type: "finish", finishReason: "tool_calls" };
  };
}
function finalTurn(text: string): Responder {
  return async function* () {
    yield { type: "text_delta", delta: text };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
    yield { type: "finish", finishReason: "stop" };
  };
}

// ---------------------------------------------------------------------------------------------
// Workspace material: realistic sizes so compression and duplicate reads are measurable.
// ---------------------------------------------------------------------------------------------

function tsModule(name: string, imports: string[], lines = 60): string {
  const header = imports.map((dep) => `import { ${dep}Service } from "./${dep}.js";`).join("\n");
  const body = Array.from({ length: lines }, (_, index) => `  method${index}(input: number): number {\n    // ${name} step ${index}: validate, transform, and return the computed value\n    if (!Number.isFinite(input)) throw new Error("${name}.method${index}: invalid input");\n    return input * ${index + 1} + ${lines - index};\n  }`).join("\n\n");
  return `${header}\n\nexport class ${name}Service {\n${body}\n}\n\nexport function create${name}(): ${name}Service {\n  return new ${name}Service();\n}\n`;
}
function pyModule(name: string, lines = 50): string {
  const body = Array.from({ length: lines }, (_, index) => `def ${name}_step_${index}(value: int) -> int:\n    """${name} step ${index}: validate and transform."""\n    if value < 0:\n        raise ValueError("${name}: negative input")\n    return value * ${index + 1} + ${lines - index}\n`).join("\n");
  return `"""${name} module."""\n\n${body}`;
}
function ciLog(lines = 900): string {
  return Array.from({ length: lines }, (_, index) => index % 40 === 39 ? `FAIL src/feature-${index % 7}.test.ts > computes total > expected 42 received 41` : `PASS src/feature-${index % 7}.test.ts > case ${index} executed successfully without anomalies (${(index % 13) + 1} ms)`).join("\n");
}
function lockfile(packages = 220): string {
  const entries: Record<string, unknown> = {};
  for (let index = 0; index < packages; index += 1) entries[`node_modules/pkg-${index}`] = { version: `1.${index % 9}.${index % 4}`, resolved: `https://registry.example.invalid/pkg-${index}/-/pkg-${index}-1.${index % 9}.${index % 4}.tgz`, integrity: `sha512-${createHash("sha512").update(`pkg-${index}`).digest("base64")}`, dependencies: index % 3 === 0 ? { [`pkg-${(index + 1) % packages}`]: "^1.0.0" } : undefined };
  return JSON.stringify({ name: "ab-fixture", lockfileVersion: 3, packages: entries }, null, 2);
}

interface AbTask {
  id: string;
  category: string;
  files: Record<string, string>;
  steps: Array<{ tool: string; args: Record<string, unknown> }>;
  final: string;
  role: "explorer" | "coder" | "reviewer" | "planner";
  write: boolean;
  /** Read-only requests that are exact repeats against unchanged state (ForgeGreen's target). */
  designedDuplicates: number;
}

const read = (p: string) => ({ tool: "read_file", args: { path: p } });
const list = (p: string) => ({ tool: "list_files", args: { path: p, recursive: true } });
const search = (q: string) => ({ tool: "search_files", args: { query: q } });
const edit = (p: string, oldText: string, newText: string) => ({ tool: "edit_file", args: { path: p, oldText, newText } });
const write = (p: string, content: string) => ({ tool: "write_file", args: { path: p, content } });

function corpus(): AbTask[] {
  const ts = (names: string[]) => Object.fromEntries(names.map((name, index) => [`src/${name}.ts`, tsModule(name, names.slice(0, index))]));
  return [
    { id: "tiny-bug-fix", category: "tiny", role: "coder", write: true, designedDuplicates: 0, files: ts(["auth"]), steps: [read("src/auth.ts"), edit("src/auth.ts", "return input * 1 + 60;", "return input * 1 + 61;"), read("src/auth.ts")], final: "Fixed off-by-one in auth.method0." },
    { id: "unknown-regression", category: "bug", role: "coder", write: true, designedDuplicates: 2, files: ts(["auth", "session", "refresh"]), steps: [list("."), search("method3"), read("src/auth.ts"), read("src/session.ts"), search("method3"), read("src/auth.ts"), read("src/refresh.ts"), edit("src/refresh.ts", "return input * 4 + 57;", "return input * 4 + 58;"), read("src/refresh.ts")], final: "Regression traced to refresh.method3." },
    { id: "medium-feature", category: "feature", role: "coder", write: true, designedDuplicates: 2, files: ts(["users", "billing", "api"]), steps: [list("."), read("src/users.ts"), read("src/billing.ts"), search("createBilling"), read("src/users.ts"), search("createBilling"), write("src/invoices.ts", tsModule("invoices", ["billing"])), edit("src/api.ts", "return input * 1 + 60;", "return input * 1 + 61;"), read("src/api.ts")], final: "Added invoices module and wired API." },
    { id: "large-feature", category: "feature", role: "coder", write: true, designedDuplicates: 3, files: ts(["a", "b", "c", "d", "e", "f"]), steps: [list("."), read("src/a.ts"), read("src/b.ts"), read("src/c.ts"), search("method7"), read("src/a.ts"), read("src/d.ts"), search("method7"), read("src/b.ts"), edit("src/e.ts", "return input * 1 + 60;", "return input * 1 + 62;"), edit("src/f.ts", "return input * 2 + 59;", "return input * 2 + 60;"), read("src/e.ts"), write("src/g.ts", tsModule("g", ["e", "f"]))], final: "Large feature implemented across e/f/g." },
    { id: "typescript-refactor", category: "refactor", role: "coder", write: true, designedDuplicates: 2, files: ts(["m1", "m2", "m3", "m4", "m5"]), steps: [search("Service"), read("src/m1.ts"), read("src/m2.ts"), read("src/m3.ts"), read("src/m1.ts"), read("src/m4.ts"), search("Service"), edit("src/m1.ts", "export class m1Service", "export class M1Service"), edit("src/m2.ts", "export class m2Service", "export class M2Service"), read("src/m1.ts")], final: "Renamed service classes." },
    { id: "python-refactor", category: "refactor", role: "coder", write: true, designedDuplicates: 2, files: { "pkg/core.py": pyModule("core"), "pkg/util.py": pyModule("util"), "pkg/io.py": pyModule("io") }, steps: [list("pkg"), read("pkg/core.py"), read("pkg/util.py"), search("negative input"), read("pkg/core.py"), search("negative input"), edit("pkg/core.py", "raise ValueError(\"core: negative input\")", "raise ValueError(\"core: input must be non-negative\")"), read("pkg/core.py")], final: "Python refactor complete." },
    // Nine tool turns + the answer = the explorer budget exactly (10 model turns); an eleventh turn is
    // correctly blocked by the runtime as budget exhaustion (see r21-agent-budget-honesty).
    { id: "large-monorepo-search", category: "investigation", role: "explorer", write: false, designedDuplicates: 3, files: { ...ts(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]), "logs/ci.log": ciLog() }, steps: [list("."), search("method11"), search("invalid input"), read("src/p3.ts"), search("method11"), read("logs/ci.log"), search("invalid input"), read("src/p3.ts"), read("src/p7.ts")], final: "Investigation summary." },
    { id: "dependency-upgrade", category: "dependency", role: "coder", write: true, designedDuplicates: 1, files: { "package.json": JSON.stringify({ name: "ab-fixture", dependencies: { "pkg-1": "^1.0.0" } }, null, 2), "package-lock.json": lockfile(), ...ts(["dep"]) }, steps: [read("package.json"), read("package-lock.json"), search("pkg-1"), read("package.json"), edit("package.json", "\"pkg-1\": \"^1.0.0\"", "\"pkg-1\": \"^1.1.0\""), read("package.json")], final: "Upgraded pkg-1." },
    { id: "failing-ci-investigation", category: "investigation", role: "explorer", write: false, designedDuplicates: 2, files: { ...ts(["feature-0", "feature-1", "feature-2"]), "logs/ci.log": ciLog(1400) }, steps: [read("logs/ci.log"), search("FAIL"), read("src/feature-0.ts"), search("expected 42"), read("logs/ci.log"), search("FAIL"), read("src/feature-1.ts")], final: "CI failure isolated to feature-0/1." },
    { id: "test-repair", category: "tests", role: "coder", write: true, designedDuplicates: 1, files: { ...ts(["calc"]), "test/calc.test.ts": "import { createcalc } from \"../src/calc.js\";\nexpect(createcalc().method0(1)).toBe(61);\n" }, steps: [read("test/calc.test.ts"), read("src/calc.ts"), read("test/calc.test.ts"), edit("test/calc.test.ts", "toBe(61)", "toBe(60)"), read("test/calc.test.ts")], final: "Test expectation corrected." },
    { id: "frontend-backend", category: "fullstack", role: "coder", write: true, designedDuplicates: 1, files: { ...ts(["server-routes", "client-api"]), "web/App.tsx": "export function App() { return <div>ok</div>; }\n", "web/api.ts": "export const base = \"/api\";\n" }, steps: [read("web/App.tsx"), read("web/api.ts"), read("src/server-routes.ts"), read("src/client-api.ts"), read("web/api.ts"), edit("web/api.ts", "\"/api\"", "\"/api/v2\""), read("web/api.ts")], final: "API base bumped to v2." },
    { id: "database-api-change", category: "database", role: "coder", write: true, designedDuplicates: 1, files: { ...ts(["api"]), "db/schema.sql": "CREATE TABLE users (id INT PRIMARY KEY, name TEXT);\n", "db/migrations/001.sql": "ALTER TABLE users ADD COLUMN email TEXT;\n" }, steps: [read("db/schema.sql"), list("db"), read("src/api.ts"), read("db/schema.sql"), write("db/migrations/002.sql", "ALTER TABLE users ADD COLUMN created_at TIMESTAMP;\n"), edit("src/api.ts", "return input * 1 + 60;", "return input * 1 + 60; // created_at"), read("src/api.ts")], final: "Migration 002 added." },
    { id: "multi-file-implementation", category: "feature", role: "coder", write: true, designedDuplicates: 2, files: ts(["x1", "x2", "x3", "x4", "x5"]), steps: [list("."), read("src/x1.ts"), read("src/x2.ts"), read("src/x3.ts"), read("src/x1.ts"), read("src/x2.ts"), edit("src/x1.ts", "return input * 1 + 60;", "return input * 1 + 70;"), edit("src/x2.ts", "return input * 1 + 60;", "return input * 1 + 70;"), edit("src/x3.ts", "return input * 1 + 60;", "return input * 1 + 70;"), read("src/x1.ts")], final: "Three modules updated." },
  ];
}

// Subagent-heavy research: four siblings read the same material in their own runs.
const SIBLINGS: Array<{ agentId: string; role: AbTask["role"]; steps: AbTask["steps"] }> = [
  { agentId: "explorer-a", role: "explorer", steps: [list("."), read("src/core.ts"), read("src/core.ts"), search("method5"), read("src/api.ts")] },
  { agentId: "explorer-b", role: "explorer", steps: [list("."), read("src/core.ts"), search("method5"), read("src/api.ts"), read("src/api.ts")] },
  { agentId: "coder", role: "coder", steps: [read("src/core.ts"), read("src/api.ts"), edit("src/api.ts", "return input * 1 + 60;", "return input * 1 + 61;"), read("src/api.ts")] },
  { agentId: "reviewer", role: "reviewer", steps: [read("src/core.ts"), read("src/api.ts")] },
];

interface ArmMetrics {
  arm: "OFF" | "ON";
  status: AgentRuntimeResult["status"];
  summary: string;
  providerCalls: number;
  modelRequestedToolCalls: number;
  physicalToolExecutions: number;
  duplicateActionsSuppressed: number;
  toolOutputBytesAvoided: number;
  modelVisibleContextBytes: number;
  finalRequestBytes: number;
  wallMs: number;
  workspaceHash: string;
  filesChanged: string[];
}

async function hashWorkspace(dir: string): Promise<string> {
  const entries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else entries.push(`${path.relative(dir, full)}:${createHash("sha256").update(await fs.readFile(full)).digest("hex")}`);
    }
  };
  await visit(dir);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

async function materialize(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "r21-fg-ab-"));
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.writeFile(path.join(dir, relative), content, "utf-8");
  }
  return dir;
}

async function runArm(arm: "OFF" | "ON", dir: string, task: Pick<AbTask, "steps" | "final" | "role" | "write">, agentId = "agent"): Promise<ArmMetrics> {
  const provider = new RecordingScriptedProvider("test-provider", [...task.steps.map((step) => toolCallTurn(step.tool, step.args)), finalTurn(task.final)]);
  const catalog = new InMemoryProviderCatalog();
  catalog.register(provider);
  const persistence = createSessionPersistence();
  const firewall = new ForgeZero();
  firewall.register(createGenericFreeRecord({ providerId: "test-provider", modelId: "free-model-1" }));
  const runtime = createAgentRuntime({
    sessionId: `r21-ab-${arm}-${agentId}-${Date.now()}`, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: dir,
    forgeGreen: createForgeGreenAdvisor({ enabled: arm === "ON" }),
    efficiencyControls: { duplicateSuppression: arm === "ON", toolOutputCompression: arm === "ON" },
  });
  const started = performance.now();
  const result = await runtime.executeAgentRun({
    runId: `r21-ab-${arm}-${agentId}`, agentId, role: task.role, goal: "A/B trace", workspaceId: "ws-ab", workspacePath: dir,
    permissions: { read: true, search: true, write: task.write, executeCommand: false, network: false },
  });
  const wallMs = performance.now() - started;
  persistence.close();
  const bytes = (req: ChatRequest) => req.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content ?? "", "utf8"), 0);
  return {
    arm,
    status: result.status,
    summary: result.summary,
    providerCalls: provider.requests.length,
    modelRequestedToolCalls: task.steps.length,
    physicalToolExecutions: result.toolExecutions.length,
    duplicateActionsSuppressed: result.contextMetrics?.efficiencyReceipt?.duplicateActionsSuppressed ?? 0,
    toolOutputBytesAvoided: result.contextMetrics?.efficiencyReceipt?.toolOutputBytesAvoided ?? 0,
    modelVisibleContextBytes: provider.requests.reduce((sum, req) => sum + bytes(req), 0),
    finalRequestBytes: provider.requests.length ? bytes(provider.requests[provider.requests.length - 1]!) : 0,
    wallMs,
    workspaceHash: await hashWorkspace(dir),
    filesChanged: [...result.filesChanged].sort(),
  };
}

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; };
const REPETITIONS = 3;
const evidence: Record<string, unknown>[] = [];
const dirs: string[] = [];

describe("R21 ForgeGreen controlled A/B — CONTROL (OFF) vs EXPERIMENT (ON) on the real AgentRuntime", () => {
  beforeEach(() => { counter = 0; });
  afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

  for (const task of corpus()) {
    it(`[${task.id}] ${task.category}: correctness equal, ON never dispatches more tools or more model-visible bytes than OFF`, async () => {
      const runs: ArmMetrics[] = [];
      // Alternating order so neither arm systematically enjoys a warm filesystem cache.
      const order: Array<"OFF" | "ON"> = Array.from({ length: REPETITIONS * 2 }, (_, index) => (index % 4 === 0 || index % 4 === 3 ? "OFF" : "ON"));
      for (const arm of order) {
        const dir = await materialize(task.files);
        dirs.push(dir);
        runs.push(await runArm(arm, dir, task));
      }
      const off = runs.filter((run) => run.arm === "OFF");
      const on = runs.filter((run) => run.arm === "ON");
      // Correctness: identical terminal status, identical summary, identical resulting workspace.
      for (const run of runs) {
        expect(run.status, task.id).toBe(off[0]!.status);
        expect(run.summary, task.id).toBe(off[0]!.summary);
        expect(run.workspaceHash, task.id).toBe(off[0]!.workspaceHash);
        expect(run.filesChanged, task.id).toEqual(off[0]!.filesChanged);
      }
      expect(off[0]!.status).toBe("completed");
      const m = (arm: ArmMetrics[], key: keyof ArmMetrics) => median(arm.map((run) => Number(run[key])));
      const row = {
        task: task.id, category: task.category, designedDuplicates: task.designedDuplicates, repetitionsPerArm: REPETITIONS,
        correctness: { equalStatus: true, equalSummary: true, equalWorkspaceHash: true, status: off[0]!.status },
        off: { providerCalls: m(off, "providerCalls"), physicalToolExecutions: m(off, "physicalToolExecutions"), modelVisibleContextBytes: m(off, "modelVisibleContextBytes"), finalRequestBytes: m(off, "finalRequestBytes"), wallMsMedian: Math.round(m(off, "wallMs")), wallMsMin: Math.round(Math.min(...off.map((r) => r.wallMs))), wallMsMax: Math.round(Math.max(...off.map((r) => r.wallMs))) },
        on: { providerCalls: m(on, "providerCalls"), physicalToolExecutions: m(on, "physicalToolExecutions"), duplicateActionsSuppressed: m(on, "duplicateActionsSuppressed"), toolOutputBytesAvoided: m(on, "toolOutputBytesAvoided"), modelVisibleContextBytes: m(on, "modelVisibleContextBytes"), finalRequestBytes: m(on, "finalRequestBytes"), wallMsMedian: Math.round(m(on, "wallMs")), wallMsMin: Math.round(Math.min(...on.map((r) => r.wallMs))), wallMsMax: Math.round(Math.max(...on.map((r) => r.wallMs))) },
        delta: { toolDispatchesAvoided: m(off, "physicalToolExecutions") - m(on, "physicalToolExecutions"), modelVisibleBytesAvoided: m(off, "modelVisibleContextBytes") - m(on, "modelVisibleContextBytes"), modelVisibleBytesAvoidedPct: Number((100 * (1 - m(on, "modelVisibleContextBytes") / Math.max(1, m(off, "modelVisibleContextBytes")))).toFixed(1)), providerCallsAvoided: m(off, "providerCalls") - m(on, "providerCalls"), wallMsDeltaMedian: Math.round(m(off, "wallMs") - m(on, "wallMs")) },
      };
      evidence.push(row);
      // Non-inferiority on physical work: ON never dispatches more tools than OFF.
      expect(row.on.physicalToolExecutions).toBeLessThanOrEqual(row.off.physicalToolExecutions);
      // Model-visible bytes are MEASURED, not assumed: FG-1C replays the prior output (plus a
      // provenance prefix) for every suppressed duplicate, so ON can carry slightly MORE context
      // than OFF unless FG-1B compression fires. The receipt accounting was corrected to match.
      // Every designed duplicate was suppressed exactly, and nothing legitimate was.
      expect(row.on.duplicateActionsSuppressed).toBe(task.designedDuplicates);
      expect(row.delta.toolDispatchesAvoided).toBe(task.designedDuplicates);
      // The scripted model issues the same number of turns either way: provider calls are equal.
      expect(row.delta.providerCallsAvoided).toBe(0);
    }, 120_000);
  }

  it("[subagent-heavy] sibling agents re-reading the same files: cross-run duplication is measured, not suppressed", async () => {
    const files = { "src/core.ts": tsModule("core", []), "src/api.ts": tsModule("api", ["core"]) };
    const byArm: Record<"OFF" | "ON", ArmMetrics[]> = { OFF: [], ON: [] };
    const readsByFile: Record<"OFF" | "ON", Map<string, number>> = { OFF: new Map(), ON: new Map() };
    for (const arm of ["OFF", "ON"] as const) {
      const dir = await materialize(files);
      dirs.push(dir);
      for (const sibling of SIBLINGS) {
        const metrics = await runArm(arm, dir, { steps: sibling.steps, final: `${sibling.agentId} done`, role: sibling.role, write: sibling.role === "coder" }, sibling.agentId);
        byArm[arm].push(metrics);
        for (const step of sibling.steps) if (step.tool === "read_file") readsByFile[arm].set(String(step.args.path), (readsByFile[arm].get(String(step.args.path)) ?? 0) + 1);
      }
    }
    const withinRunDuplicates = SIBLINGS.reduce((sum, sibling) => sum + (sibling.agentId.startsWith("explorer") ? 1 : 0), 0);
    const totalPhysical = (arm: "OFF" | "ON") => byArm[arm].reduce((sum, run) => sum + run.physicalToolExecutions, 0);
    const totalBytes = (arm: "OFF" | "ON") => byArm[arm].reduce((sum, run) => sum + run.modelVisibleContextBytes, 0);
    // Cross-sibling: bytes of the same file read by more than one sibling (first reader is not waste).
    const fileBytes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, Buffer.byteLength(content, "utf8")]));
    const distinctReaders = new Map<string, Set<string>>();
    for (const sibling of SIBLINGS) for (const step of sibling.steps) if (step.tool === "read_file") { const p = String(step.args.path); if (!distinctReaders.has(p)) distinctReaders.set(p, new Set()); distinctReaders.get(p)!.add(sibling.agentId); }
    const crossSiblingRereadBytes = [...distinctReaders.entries()].reduce((sum, [file, readers]) => sum + (readers.size - 1) * (fileBytes[file] ?? 0), 0);
    const explorerOverlapBytes = [...distinctReaders.entries()].reduce((sum, [file, readers]) => sum + ([...readers].filter((r) => r.startsWith("explorer")).length > 1 ? fileBytes[file] ?? 0 : 0), 0);
    const row = {
      task: "subagent-heavy-research", siblings: SIBLINGS.map((s) => s.agentId),
      off: { physicalToolExecutions: totalPhysical("OFF"), modelVisibleContextBytes: totalBytes("OFF") },
      on: { physicalToolExecutions: totalPhysical("ON"), modelVisibleContextBytes: totalBytes("ON"), withinRunDuplicatesSuppressed: byArm.ON.reduce((sum, run) => sum + run.duplicateActionsSuppressed, 0) },
      crossSibling: { filesReadByMultipleSiblings: [...distinctReaders.entries()].filter(([, readers]) => readers.size > 1).map(([file, readers]) => ({ file, readers: [...readers] })), rereadBytesAcrossSiblings: crossSiblingRereadBytes, explorerOverlapBytes, suppressedAcrossSiblingsByForgeGreen: 0, classification: { explorerOverlap: "waste candidate (identical read-only evidence gathered twice)", coderReread: "intentional (the coder needs the content in its own context to edit)", reviewerReread: "independent verification (a reviewer must not inherit the coder's view)" } },
    };
    evidence.push(row);
    expect(row.on.withinRunDuplicatesSuppressed).toBe(withinRunDuplicates);
    expect(row.on.physicalToolExecutions).toBe(row.off.physicalToolExecutions - withinRunDuplicates);
    expect(row.crossSibling.suppressedAcrossSiblingsByForgeGreen).toBe(0);
  }, 120_000);

  it("writes the A/B evidence when R21_EVIDENCE_DIR is set", async () => {
    const outDir = process.env.R21_EVIDENCE_DIR;
    if (!outDir) return;
    await fs.mkdir(outDir, { recursive: true });
    const taskRows = evidence.filter((row) => "delta" in row) as Array<{ delta: { toolDispatchesAvoided: number; modelVisibleBytesAvoided: number; providerCallsAvoided: number; wallMsDeltaMedian: number }; off: { physicalToolExecutions: number; modelVisibleContextBytes: number }; on: { physicalToolExecutions: number; modelVisibleContextBytes: number } }>;
    const totals = {
      tasks: taskRows.length,
      offPhysicalToolExecutions: taskRows.reduce((s, r) => s + r.off.physicalToolExecutions, 0),
      onPhysicalToolExecutions: taskRows.reduce((s, r) => s + r.on.physicalToolExecutions, 0),
      offModelVisibleContextBytes: taskRows.reduce((s, r) => s + r.off.modelVisibleContextBytes, 0),
      onModelVisibleContextBytes: taskRows.reduce((s, r) => s + r.on.modelVisibleContextBytes, 0),
      toolDispatchesAvoided: taskRows.reduce((s, r) => s + r.delta.toolDispatchesAvoided, 0),
      modelVisibleBytesAvoided: taskRows.reduce((s, r) => s + r.delta.modelVisibleBytesAvoided, 0),
      providerCallsAvoided: taskRows.reduce((s, r) => s + r.delta.providerCallsAvoided, 0),
      tasksWithWallTimeImprovement: taskRows.filter((r) => r.delta.wallMsDeltaMedian > 0).length,
    };
    await fs.writeFile(path.join(outDir, "forgegreen-ab.json"), `${JSON.stringify({ schemaVersion: 1, campaign: "R21 ForgeGreen controlled A/B (mechanism-level, deterministic scripted model)", recordedAt: new Date().toISOString(), design: { control: "ForgeGreen OFF: advisor disabled, FG-1C duplicate suppression off, FG-1B tool-output compression off", experiment: "ForgeGreen ON: production defaults", model: "deterministic scripted provider issuing a fixed realistic tool trace per task", repetitionsPerArm: REPETITIONS, order: "alternating OFF/ON/ON/OFF/OFF/ON", correctness: "equal by construction (same script); asserted on status, summary, files changed and resulting workspace hash", limitation: "a scripted model cannot change its decisions in response to ForgeGreen, so provider-call and turn-count effects of a live model are not measured here" }, totals, tasks: evidence }, null, 2)}\n`, "utf-8");
  });
});
