import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { EventStore, SessionPersistence, createSessionPersistence } from "@codeforge/sessions";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createParallelAutonomousRunOrchestrator } from "../src/parallel-orchestrator.js";
import { ParallelRunStore, type ParallelEvent } from "../src/parallel-state.js";

const execFile = promisify(execFileCallback);
const git = async (cwd: string, args: string[]) => (await execFile("git", args, { cwd })).stdout.trim();

const SESSION_ID = "recovery-session";
const WORKSTREAM_FILES: Record<string, string> = { alpha: "src/alpha.mjs", bravo: "src/bravo.mjs", charlie: "src/charlie.mjs" };

class RecoveryProvider implements ProviderAdapter {
  readonly providerId = "cf08g-recovery";
  readonly isTestProvider = true;
  async listModels(): Promise<ProviderModel[]> { return [{ modelId: "free", displayName: "Free", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }]; }
  async chat(_request: ChatRequest): Promise<ChatResponse> { throw new Error("stream only"); }
  async healthCheck() { return { status: "available" as const }; }
  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const all = request.messages.map((message) => message.content).join("\n");
    if (system.includes("CodeForge Planner")) {
      yield { type: "text_delta", delta: JSON.stringify({
        id: "cf08g-recovery", goal: "three non-conflicting modules", summary: "three independent modules",
        workstreams: Object.entries(WORKSTREAM_FILES).map(([id, file]) => ({ id, title: id, objective: `Implement the ${id} module`, dependencies: [], expectedFiles: [file] })),
        globalVerificationCommands: ["node --test test/synthesis.test.mjs"],
      }) };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    if (system.includes("CodeForge Reviewer")) {
      yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "module approved" }) };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    if (system.includes("CodeForge Coder")) {
      const id = Object.keys(WORKSTREAM_FILES).find((candidate) => all.includes(`"workstream":"${candidate}"`)) ?? "alpha";
      if (!request.messages.some((message) => message.role === "tool")) {
        yield { type: "tool_call_started", toolCallId: `write-${id}`, toolName: "write_file" };
        yield { type: "tool_call_completed", toolCallId: `write-${id}`, toolName: "write_file", arguments: JSON.stringify({ path: WORKSTREAM_FILES[id], content: `export const ${id} = '${id}';\n` }) };
        yield { type: "finish", finishReason: "tool_calls" }; return;
      }
      yield { type: "text_delta", delta: `${id} complete` };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    yield { type: "text_delta", delta: "done" };
    yield { type: "finish", finishReason: "stop" };
  }
}

/**
 * Faithful process-death fixture: the durable store stops accepting writes at the first
 * synthesis inclusion event, exactly as a killed process would, so the row left behind is
 * written entirely by production code.
 */
function crashAtFirstSynthesisStep(real: SessionPersistence): SessionPersistence {
  let tripped = false;
  const writes = new Set(["upsertWorkItem", "appendEvent", "upsertSession", "upsertTurn"]);
  const terminated = () => new Error("PROCESS_TERMINATED: durable store unavailable");
  return new Proxy(real, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== "function") return value;
      const name = String(property);
      return (...args: unknown[]) => {
        if (name === "appendEvent" && (args[0] as { type?: string } | undefined)?.type === "synthesis.workstream_added") { tripped = true; throw terminated(); }
        if (tripped && writes.has(name)) throw terminated();
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describe("CF-08 restart-during-synthesis idempotency", () => {
  let repoDir: string; let worktreeDir: string; let stateDir: string; let dbPath: string;
  let live: SessionPersistence | undefined;

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf08g-recovery-repo-"));
    worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf08g-recovery-wt-"));
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf08g-recovery-db-"));
    dbPath = path.join(stateDir, "codeforge.sqlite");
    await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
    await execFile("git", ["config", "user.name", "CodeForge"], { cwd: repoDir });
    await execFile("git", ["config", "user.email", "codeforge@example.test"], { cwd: repoDir });
    await fs.mkdir(path.join(repoDir, "src")); await fs.mkdir(path.join(repoDir, "test"));
    await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ type: "module" }));
    await fs.writeFile(path.join(repoDir, "test", "synthesis.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { alpha } from '../src/alpha.mjs'; import { bravo } from '../src/bravo.mjs'; import { charlie } from '../src/charlie.mjs'; test('synthesis', () => assert.deepEqual([alpha, bravo, charlie], ['alpha', 'bravo', 'charlie']));\n");
    await execFile("git", ["add", "."], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "base"], { cwd: repoDir });
  });

  afterEach(async () => {
    try { await live?.close(); } catch {}
    live = undefined;
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(worktreeDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function services(persistence: SessionPersistence, events?: ParallelEvent[]) {
    const catalog = new InMemoryProviderCatalog(); catalog.register(new RecoveryProvider());
    const firewall = new ForgeZero(); firewall.register(createGenericFreeRecord());
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeDir });
    const agentRuntime = createAgentRuntime({ sessionId: SESSION_ID, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: repoDir });
    const orchestrator = createParallelAutonomousRunOrchestrator({ workspaceService, agentRuntime, persistence, ...(events ? { onEvent: (event: ParallelEvent) => { events.push(event); } } : {}) });
    return { workspaceService, orchestrator };
  }

  /** Drives a real run until the process "dies" immediately after Workstream alpha is applied. */
  async function interruptDuringSynthesis(): Promise<{ runId: string; baseRevision: string; synthesisPath: string }> {
    const crashing = createSessionPersistence({ dbPath });
    const { orchestrator } = services(crashAtFirstSynthesisStep(crashing));
    await expect(orchestrator.startRun({ sessionId: SESSION_ID, workspacePath: repoDir, goal: "Implement three non-conflicting modules" })).rejects.toThrow(/PROCESS_TERMINATED/);
    const store = new ParallelRunStore(crashing);
    const runId = (await crashing.getWorkItemsByKind("parallel_run"))[0]!.id;
    const run = await store.get(runId)!;
    const synthesisWorkspaceService = createWorkspaceService({ persistence: crashing, worktreeParentDir: worktreeDir });
    await synthesisWorkspaceService.init();
    const synthesisPath = synthesisWorkspaceService.getWorkspace(run.synthesis!.worktreeId)!.rootPath;
    await crashing.close();
    return { runId, baseRevision: run.baseRevision, synthesisPath };
  }

  const countApplications = async (cwd: string, base: string, sourceRevision: string) =>
    (await git(cwd, ["log", "--format=%B", `${base}..HEAD`])).split(`(cherry picked from commit ${sourceRevision})`).length - 1;

  it("resumes synthesis in a fresh runtime without ever reapplying an already incorporated workstream", async () => {
    const { runId, baseRevision, synthesisPath } = await interruptDuringSynthesis();

    // 2D/2E — brand new services over the same durable database and repository.
    const events: ParallelEvent[] = [];
    live = createSessionPersistence({ dbPath });
    const { orchestrator: fresh } = services(live, events);
    const recovered = await fresh.getRun(runId)!;
    expect(recovered.status).toBe("synthesizing");
    expect(recovered.synthesis!.order).toEqual(["alpha", "bravo", "charlie"]);
    expect(recovered.synthesis!.included.map((included) => included.workstreamId)).toEqual(["alpha"]);
    const alphaSource = recovered.synthesis!.included[0]!.sourceRevision;
    const alphaSynthesisRevision = recovered.synthesis!.included[0]!.resultingRevision;
    expect(await git(synthesisPath, ["rev-parse", "HEAD"])).toBe(alphaSynthesisRevision);
    expect(await git(synthesisPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(recovered.synthesis!.branch);
    expect(await countApplications(synthesisPath, baseRevision, alphaSource)).toBe(1);

    // 2F/2G — resume: alpha is recognised as included, bravo and charlie are applied once each.
    const result = await fresh.resumeRun(runId);
    expect(result.status).toBe("completed");
    const resumedEvent = events.find((event) => event.type === "parallel.recovery.resumed");
    expect(resumedEvent?.payload).toMatchObject({ included: ["alpha"], pending: ["bravo", "charlie"] });

    const final = await fresh.getRun(runId)!;
    expect(final.synthesis!.included.map((included) => included.workstreamId)).toEqual(["alpha", "bravo", "charlie"]);
    expect(await countApplications(synthesisPath, baseRevision, alphaSource)).toBe(1);
    for (const included of final.synthesis!.included) expect(await countApplications(synthesisPath, baseRevision, included.sourceRevision)).toBe(1);
    expect((await git(synthesisPath, ["log", "--format=%s", `${baseRevision}..HEAD`])).split(/\r?\n/).filter(Boolean)).toHaveLength(3);
    expect(events.filter((event) => event.type === "synthesis.workstream_added").map((event) => event.workstreamId)).toEqual(["bravo", "charlie"]);
    expect(await git(synthesisPath, ["rev-parse", "HEAD"])).toBe(final.synthesis!.included[2]!.resultingRevision);

    // Global verification ran against the fully synthesized tree and the target was promoted once.
    expect(result.verification.every((verification) => verification.failed === 0)).toBe(true);
    expect(final.promotion?.status).toBe("integrated");
    for (const file of Object.values(WORKSTREAM_FILES)) expect(existsSync(path.join(repoDir, file))).toBe(true);
  }, 240_000);

  it("fails closed when the persisted synthesis revision no longer matches real Git", async () => {
    const { runId, baseRevision, synthesisPath } = await interruptDuringSynthesis();
    // An external actor rewrote the synthesis worktree underneath the durable inclusion record.
    await execFile("git", ["reset", "--hard", "HEAD~1"], { cwd: synthesisPath });
    expect(await git(synthesisPath, ["rev-parse", "HEAD"])).toBe(baseRevision);

    const events: ParallelEvent[] = [];
    live = createSessionPersistence({ dbPath });
    const { orchestrator: fresh } = services(live, events);
    const alphaSource = (await fresh.getRun(runId))!.synthesis!.included[0]!.sourceRevision;
    const result = await fresh.resumeRun(runId);

    expect(result).toMatchObject({ status: "blocked", error: "PARALLEL_RECOVERY_REVALIDATION_REQUIRED" });
    expect(events.find((event) => event.type === "parallel.recovery.revalidation_required")?.payload).toMatchObject({ reason: "SYNTHESIS_HEAD_DIVERGED" });
    // No blind reapplication, no reset, no silent repair of the inconsistent history.
    expect(await git(synthesisPath, ["rev-parse", "HEAD"])).toBe(baseRevision);
    expect(await countApplications(synthesisPath, baseRevision, alphaSource)).toBe(0);
    expect((await fresh.getRun(runId))!.synthesis!.included.map((included) => included.workstreamId)).toEqual(["alpha"]);
    expect(events.some((event) => event.type === "synthesis.workstream_added")).toBe(false);
    expect(existsSync(path.join(repoDir, WORKSTREAM_FILES.alpha!))).toBe(false);
  }, 240_000);

  it("fails closed when the persisted synthesis worktree is gone", async () => {
    const events: ParallelEvent[] = [];
    live = createSessionPersistence({ dbPath });
    const now = new Date().toISOString();
    live.upsertSession({ id: SESSION_ID, title: "missing worktree", createdAt: now, updatedAt: now, status: "running" });
    const store = new ParallelRunStore(live);
    store.save({
      kind: "parallel_run", id: "parallel-missing-worktree", sessionId: SESSION_ID, workspaceId: "ws-target", goal: "resume", status: "synthesizing",
      baseRevision: "base", workstreams: [], dispatches: [], contracts: [],
      synthesis: { workspaceId: "wt-missing", worktreeId: "wt-missing", branch: "codeforge/synthesis", order: ["alpha"], included: [], conflicts: [] },
      createdAt: now, updatedAt: now,
    });
    const { orchestrator: fresh } = services(live, events);
    const result = await fresh.resumeRun("parallel-missing-worktree");
    expect(result).toMatchObject({ status: "blocked", error: "PARALLEL_RECOVERY_REVALIDATION_REQUIRED" });
    expect(events.find((event) => event.type === "parallel.recovery.revalidation_required")?.payload).toMatchObject({ reason: "SYNTHESIS_WORKSPACE_UNKNOWN" });
    expect((await fresh.getRun("parallel-missing-worktree"))?.status).toBe("blocked");
  });
});
