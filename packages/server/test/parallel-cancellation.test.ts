import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createParallelAutonomousRunOrchestrator } from "../src/parallel-orchestrator.js";
import type { ParallelEvent } from "../src/parallel-state.js";

const execFile = promisify(execFileCallback);

const ALPHA_FILE = "src/partial-a.ts";
const ALPHA_CONTENT = "export const partialAlpha = 'CF08G_DIRTY_ALPHA';\n";
const BETA_FILE = "src/partial-b.ts";
const BETA_CONTENT = "export const partialBeta = 'CF08G_COMMITTED_BETA';\n";

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise<T>((resolve) => { this.resolve = resolve; }); }
}

/** Releases every participant only once all of them have arrived: real simultaneity, no sleeps. */
class Barrier {
  private readonly arrived = new Set<string>();
  private readonly open = new Deferred();
  readonly reached: Promise<void>;
  constructor(private readonly size: number) { this.reached = this.open.promise; }
  async enter(id: string): Promise<void> {
    this.arrived.add(id);
    if (this.arrived.size >= this.size) this.open.resolve();
    await this.open.promise;
  }
  ids(): string[] { return [...this.arrived].sort(); }
}

class CancellationProvider implements ProviderAdapter {
  readonly providerId = "cf08g-cancellation";
  readonly isTestProvider = true;
  constructor(private readonly barrier: Barrier, private readonly holdAlpha: Deferred, private readonly alphaParked: Deferred) {}
  async listModels(): Promise<ProviderModel[]> { return [{ modelId: "free", displayName: "Free", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }]; }
  async chat(_request: ChatRequest): Promise<ChatResponse> { throw new Error("stream only"); }
  async healthCheck() { return { status: "available" as const }; }
  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const all = request.messages.map((message) => message.content).join("\n");
    if (system.includes("CodeForge Planner")) {
      yield { type: "text_delta", delta: JSON.stringify({
        id: "cf08g-cancellation", goal: "three independent partial modules", summary: "three independent writers",
        workstreams: [
          { id: "alpha", title: "Alpha", objective: "Create the alpha partial module", dependencies: [], expectedFiles: [ALPHA_FILE] },
          { id: "beta", title: "Beta", objective: "Create the beta partial module", dependencies: [], expectedFiles: [BETA_FILE] },
          { id: "gamma", title: "Gamma", objective: "Create the gamma partial module", dependencies: [], expectedFiles: ["src/partial-c.ts"] },
        ],
      }) };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    if (system.includes("CodeForge Reviewer")) {
      yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "isolated workstream approved" }) };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    if (system.includes("CodeForge Coder")) {
      const id = all.includes('"workstream":"alpha"') ? "alpha" : all.includes('"workstream":"beta"') ? "beta" : "gamma";
      if (!request.messages.some((message) => message.role === "tool")) {
        await this.barrier.enter(id);
        const target = id === "alpha" ? { path: ALPHA_FILE, content: ALPHA_CONTENT } : { path: BETA_FILE, content: BETA_CONTENT };
        yield { type: "tool_call_started", toolCallId: `write-${id}`, toolName: "write_file" };
        yield { type: "tool_call_completed", toolCallId: `write-${id}`, toolName: "write_file", arguments: JSON.stringify(target) };
        yield { type: "finish", finishReason: "tool_calls" }; return;
      }
      if (id === "alpha") { this.alphaParked.resolve(); await this.holdAlpha.promise; }
      yield { type: "text_delta", delta: `${id} implementation complete` };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    yield { type: "text_delta", delta: "done" };
    yield { type: "finish", finishReason: "stop" };
  }
}

describe("CF-08 parallel cancellation preserves autonomous results", () => {
  let repoDir: string; let worktreeDir: string; let persistence: ReturnType<typeof createSessionPersistence>;
  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf08g-cancel-repo-"));
    worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf08g-cancel-wt-"));
    persistence = createSessionPersistence();
    await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
    await execFile("git", ["config", "user.name", "CodeForge"], { cwd: repoDir });
    await execFile("git", ["config", "user.email", "codeforge@example.test"], { cwd: repoDir });
    await fs.mkdir(path.join(repoDir, "src"));
    await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ type: "module" }));
    await fs.writeFile(path.join(repoDir, "src", "base.ts"), "export const base = true;\n");
    await execFile("git", ["add", "."], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "base"], { cwd: repoDir });
  });
  // Fixture teardown only: the retention assertions all run while the test still owns the worktrees.
  afterEach(async () => { await persistence.close(); await fs.rm(repoDir, { recursive: true, force: true }); await fs.rm(worktreeDir, { recursive: true, force: true }); });

  it("retains dirty and committed autonomous work, releases leases, and is idempotent on a second cancel", async () => {
    const barrier = new Barrier(2);
    const holdAlpha = new Deferred();
    const alphaParked = new Deferred();
    const betaCompleted = new Deferred();
    const events: ParallelEvent[] = [];
    let runId = "";

    const catalog = new InMemoryProviderCatalog();
    catalog.register(new CancellationProvider(barrier, holdAlpha, alphaParked));
    const firewall = new ForgeZero(); firewall.register(createGenericFreeRecord());
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeDir });
    const runtime = createAgentRuntime({ sessionId: "cancel-session", eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: repoDir });
    const orchestrator = createParallelAutonomousRunOrchestrator({
      workspaceService, agentRuntime: runtime, persistence,
      onEvent: (event) => { events.push(event); runId = event.runId; if (event.type === "workstream.completed" && event.workstreamId === "beta") betaCompleted.resolve(); },
    });

    const pending = orchestrator.startRun({
      sessionId: "cancel-session", workspacePath: repoDir, goal: "Create three independent partial modules",
      budget: { maxParallelWorkstreams: 2, maxActiveCoders: 2, maxActiveReviewers: 2, maxTotalWorkstreams: 6, maxSynthesisRounds: 1, maxConflictRepairRounds: 2 },
    });

    // 1A — both Coders are genuinely active at the same instant, before any cancellation.
    await barrier.reached;
    expect(barrier.ids()).toEqual(["alpha", "beta"]);
    const dispatchedWhileActive = (await orchestrator.getRun(runId))!.dispatches;
    expect(dispatchedWhileActive.map((dispatch) => dispatch.workstreamId).sort()).toEqual(["alpha", "beta"]);
    expect(dispatchedWhileActive.every((dispatch) => dispatch.state === "active")).toBe(true);
    expect(new Set(dispatchedWhileActive.map((dispatch) => dispatch.worktreeId)).size).toBe(2);

    // 1B/1C — Coder A leaves uncommitted work parked; Coder B commits a useful result.
    await Promise.all([alphaParked.promise, betaCompleted.promise]);
    const before = await orchestrator.getRun(runId)!;
    const alphaDispatch = before.dispatches.find((dispatch) => dispatch.workstreamId === "alpha")!;
    const betaDispatch = before.dispatches.find((dispatch) => dispatch.workstreamId === "beta")!;
    const alphaPath = workspaceService.getWorkspace(alphaDispatch.worktreeId)!.rootPath;
    const alphaDirtyFile = path.join(alphaPath, ALPHA_FILE);
    expect(await fs.readFile(alphaDirtyFile, "utf8")).toBe(ALPHA_CONTENT);
    expect((await execFile("git", ["status", "--porcelain"], { cwd: alphaPath })).stdout).toContain("partial-a.ts");
    const betaBranch = betaDispatch.branch!;
    const betaCommit = (await execFile("git", ["rev-parse", betaBranch], { cwd: repoDir })).stdout.trim();
    expect(betaCommit).toMatch(/^[0-9a-f]{40}$/);

    // 1D — production cancellation of the parent run.
    expect(orchestrator.cancelRun(runId)).toBe(true);
    holdAlpha.resolve();
    const result = await pending;

    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("PARALLEL_RUN_CANCELLED");
    const cancelled = await orchestrator.getRun(runId)!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.workstreams.find((workstream) => workstream.workstreamId === "alpha")?.status).toBe("cancelled");
    expect(cancelled.workstreams.find((workstream) => workstream.workstreamId === "beta")?.status).toBe("completed");
    // No further workstream was dispatched once the parent was cancelled.
    expect(cancelled.dispatches.map((dispatch) => dispatch.workstreamId).sort()).toEqual(["alpha", "beta"]);
    expect(cancelled.workstreams.some((workstream) => workstream.workstreamId === "gamma")).toBe(false);
    expect(events.some((event) => event.type === "workstream.dispatched" && event.workstreamId === "gamma")).toBe(false);
    expect(cancelled.synthesis).toBeUndefined();

    // 1E — dirty autonomous work in Worktree A survives cancellation, classified retained_dirty.
    const alphaAfter = cancelled.dispatches.find((dispatch) => dispatch.workstreamId === "alpha")!;
    expect(alphaAfter.cleanup).toBe("retained_dirty");
    expect(alphaAfter.retainedPath).toBe(alphaPath);
    expect(await fs.readFile(alphaDirtyFile, "utf8")).toBe(ALPHA_CONTENT);
    expect(sha256(await fs.readFile(alphaDirtyFile, "utf8"))).toBe(sha256(ALPHA_CONTENT));
    expect((await execFile("git", ["status", "--porcelain"], { cwd: alphaPath })).stdout.trim()).not.toBe("");
    expect(workspaceService.getWorkspace(alphaDispatch.worktreeId)?.status).toBe("retained_dirty");

    // 1F — Workstream B's committed result survives cancellation on its retained branch.
    const betaAfter = cancelled.dispatches.find((dispatch) => dispatch.workstreamId === "beta")!;
    expect(betaAfter.branchPreserved).toBe(true);
    expect((await execFile("git", ["rev-parse", betaBranch], { cwd: repoDir })).stdout.trim()).toBe(betaCommit);
    expect((await execFile("git", ["show", `${betaBranch}:${BETA_FILE}`], { cwd: repoDir })).stdout).toBe(BETA_CONTENT);
    expect(cancelled.workstreams.find((workstream) => workstream.workstreamId === "beta")?.resultRevision).toBe(betaCommit);
    expect(cancelled.workstreams.find((workstream) => workstream.workstreamId === "beta")?.branch).toBe(betaBranch);

    // 1G — the write leases were genuinely released, proven by real reacquisition.
    const reacquiredAlpha = workspaceService.acquireLease(alphaDispatch.worktreeId, "cf08g-post-cancel", "write");
    const reacquiredTarget = workspaceService.acquireLease(cancelled.workspaceId, "cf08g-post-cancel", "write");
    expect(reacquiredAlpha.mode).toBe("write");
    expect(reacquiredTarget.mode).toBe("write");
    workspaceService.releaseLease(reacquiredAlpha.leaseId, "cf08g-post-cancel");
    workspaceService.releaseLease(reacquiredTarget.leaseId, "cf08g-post-cancel");

    // 1H — a second cancellation is a no-op: same terminal state, no second cleanup pass.
    const cleanupStamp = cancelled.cleanupCompletedAt;
    expect(cleanupStamp).toBeTruthy();
    expect(orchestrator.cancelRun(runId)).toBe(false);
    expect(orchestrator.cancelRun(runId)).toBe(false);
    const afterSecondCancel = await orchestrator.getRun(runId)!;
    expect(afterSecondCancel.status).toBe("cancelled");
    expect(afterSecondCancel.cleanupCompletedAt).toBe(cleanupStamp);
    expect(events.filter((event) => event.type === "parallel.cancellation.finalized")).toHaveLength(1);
    expect(await fs.readFile(alphaDirtyFile, "utf8")).toBe(ALPHA_CONTENT);
    expect((await execFile("git", ["rev-parse", betaBranch], { cwd: repoDir })).stdout.trim()).toBe(betaCommit);
    expect(workspaceService.getLeasesForWorkspace(alphaDispatch.worktreeId)).toEqual([]);
  }, 180_000);
});
