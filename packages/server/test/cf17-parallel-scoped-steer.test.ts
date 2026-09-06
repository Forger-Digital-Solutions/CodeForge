import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCallback);
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ProviderAdapter, type ProviderModel, type ChatRequest, type StreamEvent } from "@codeforge/providers";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createParallelAutonomousRunOrchestrator } from "../src/parallel-orchestrator.js";

// CF-17 scoped parallel steering: a steer targeted at workstream alpha must hold/replan alpha,
// leave beta untouched, be consumed durably exactly once, and survive a process restart with its
// scope binding intact.

const ALPHA_FILE = "src/partial-a.ts";
const BETA_FILE = "src/partial-b.ts";
const STEER_MESSAGE = "use the revised behavior for alpha";
const SESSION_ID = "cf17-scoped";
const RUN_ID = "cf17-scoped-run";

interface CapturedRequest { id: string; role: "coder" | "reviewer" | "other"; content: string }

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise<T>((resolve) => { this.resolve = resolve; }); }
}

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

class ScopedSteerProvider implements ProviderAdapter {
  readonly providerId = "cf17-scoped-steer";
  readonly isTestProvider = true;
  readonly captures: CapturedRequest[] = [];
  constructor(
    private readonly barrier: Barrier,
    private readonly holdAlphaText: Deferred,
    private readonly alphaReplanned: Deferred,
  ) {}
  async listModels(): Promise<ProviderModel[]> { return [{ modelId: "free", displayName: "Free", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }]; }
  async chat(): Promise<never> { throw new Error("stream only"); }
  async healthCheck() { return { status: "available" as const }; }
  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const all = request.messages.map((message) => message.content).join("\n");
    if (system.includes("CodeForge Planner")) {
      yield { type: "text_delta", delta: JSON.stringify({
        id: "cf17-scoped-steer", goal: "two independent modules", summary: "two independent writers",
        workstreams: [
          { id: "alpha", title: "Alpha", objective: "Create the alpha partial module", dependencies: [], expectedFiles: [ALPHA_FILE] },
          { id: "beta", title: "Beta", objective: "Create the beta partial module", dependencies: [], expectedFiles: [BETA_FILE] },
        ],
      }) };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    if (system.includes("CodeForge Reviewer")) {
      yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "isolated workstream approved" }) };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    if (system.includes("CodeForge Coder")) {
      const id = all.includes('"workstream":"alpha"') ? "alpha" : "beta";
      const role = "coder" as const;
      const firstRound = !request.messages.some((message) => message.role === "tool");
      if (firstRound) {
        await this.barrier.enter(id);
        const target = id === "alpha" ? { path: ALPHA_FILE, content: "export const alpha = true;\n" } : { path: BETA_FILE, content: "export const beta = true;\n" };
        yield { type: "tool_call_started", toolCallId: `write-${id}`, toolName: "write_file" };
        yield { type: "tool_call_completed", toolCallId: `write-${id}`, toolName: "write_file", arguments: JSON.stringify(target) };
        yield { type: "finish", finishReason: "tool_calls" }; return;
      }
      this.captures.push({ id, role, content: all });
      if (id === "alpha") {
        const steered = all.includes("[User Steering Instruction]");
        if (steered) this.alphaReplanned.resolve();
        else await this.holdAlphaText.promise;
      }
      yield { type: "text_delta", delta: `${id} implementation complete` };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    yield { type: "text_delta", delta: "done" };
    yield { type: "finish", finishReason: "stop" };
  }
}

describe("CF-17 scoped parallel steering", () => {
  let repoDir: string; let worktreeDir: string; let persistence: ISessionPersistence;
  let cleanupDirs: string[] = [];

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf17-scoped-repo-"));
    worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf17-scoped-wt-"));
    persistence = createSessionPersistence();
    await persistence.init();
    await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
    await execFile("git", ["config", "user.name", "CodeForge"], { cwd: repoDir });
    await execFile("git", ["config", "user.email", "codeforge@example.test"], { cwd: repoDir });
    await fs.mkdir(path.join(repoDir, "src"));
    await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ type: "module" }));
    await execFile("git", ["add", "."], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "base"], { cwd: repoDir });
    const headCheck = await execFile("git", ["rev-parse", "HEAD"], { cwd: repoDir });
  });

  afterEach(async () => {
    await persistence.close();
    for (const dir of [repoDir, worktreeDir, ...cleanupDirs]) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
    cleanupDirs = [];
  });

  function makeOrchestrator(provider: ScopedSteerProvider, events: Array<{ type: string; workstreamId?: string }>): ReturnType<typeof createParallelAutonomousRunOrchestrator> {
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeDir });
    const catalog = new InMemoryProviderCatalog(); catalog.register(provider);
    const firewall = new ForgeZero(); firewall.register(createGenericFreeRecord());
    const runtime = createAgentRuntime({ sessionId: SESSION_ID, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: repoDir });
    return createParallelAutonomousRunOrchestrator({ workspaceService, agentRuntime: runtime, persistence, onEvent: (event) => { events.push({ type: event.type, ...(event.workstreamId ? { workstreamId: event.workstreamId } : {}) }); } });
  }

  it("replans only the targeted workstream, consumes the steer exactly once, and leaves the other workstream unchanged", async () => {
    const barrier = new Barrier(2);
    const holdAlphaText = new Deferred();
    const alphaReplanned = new Deferred();
    const provider = new ScopedSteerProvider(barrier, holdAlphaText, alphaReplanned);
    const events: Array<{ type: string; workstreamId?: string }> = [];
    const orchestrator = makeOrchestrator(provider, events);

    const pending = orchestrator.startRun({ runId: RUN_ID, sessionId: SESSION_ID, workspacePath: repoDir, goal: "two independent modules" });

    // Both workstreams are genuinely active at the same instant.
    await barrier.reached;
    expect(barrier.ids()).toEqual(["alpha", "beta"]);

    // Invalid targets are rejected, never silently converted to a global steer.
    expect((await orchestrator.steerWorkstream(RUN_ID, "gamma", STEER_MESSAGE)).error).toBe("PARALLEL_WORKSTREAM_NOT_FOUND");

    // Steer alpha while both coders are in flight: durable, exactly-once, scoped.
    const steered = await orchestrator.steerWorkstream(RUN_ID, "alpha", STEER_MESSAGE, "scoped-steer-1");
    expect(steered).toMatchObject({ ok: true });
    const duplicate = await orchestrator.steerWorkstream(RUN_ID, "alpha", STEER_MESSAGE, "scoped-steer-1");
    expect(duplicate).toMatchObject({ ok: true, duplicate: true });

    const receipts = await persistence.getWorkItemsByKind("steer_receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ steerId: "scoped-steer-1", targetWorkstreamId: "alpha", turnId: RUN_ID + ":alpha" });
    expect((receipts[0] as unknown as { consumedAt?: string }).consumedAt).toBeUndefined();

    holdAlphaText.resolve();
    await alphaReplanned.promise;
    const result = await pending;
    expect(result.status).toBe("completed");
    const alphaCoder = provider.captures.filter((capture) => capture.id === "alpha" && capture.role === "coder");
    const betaCoder = provider.captures.filter((capture) => capture.id === "beta" && capture.role === "coder");
    // Alpha replanned: exactly one extra dispatch carrying the steer instruction.
    expect(alphaCoder).toHaveLength(2);
    expect(alphaCoder[0]!.content).not.toContain(STEER_MESSAGE);
    expect(alphaCoder[1]!.content).toContain("[User Steering Instruction]");
    expect(alphaCoder[1]!.content).toContain(STEER_MESSAGE);
    // Beta never saw the steer and ran exactly one dispatch.
    expect(betaCoder).toHaveLength(1);
    expect(betaCoder[0]!.content).not.toContain(STEER_MESSAGE);

    // Durable exactly-once consumption, scope intact.
    const consumed = await persistence.getWorkItemsByKind("steer_receipt");
    expect(consumed).toHaveLength(1);
    expect((consumed[0] as unknown as { consumedAt?: string }).consumedAt).toBeDefined();

    // Events: alpha replanned, beta never did.
    expect(events.some((event) => event.type === "workstream.replanned" && event.workstreamId === "alpha")).toBe(true);
    expect(events.filter((event) => event.type === "workstream.replanned")).toHaveLength(1);
    expect((await orchestrator.getRun(RUN_ID))?.dispatches.every((dispatch) => dispatch.state === "completed")).toBe(true);
  }, 45_000);

  it("keeps a queued scoped steer owned by its workstream across a restart, and beta still cannot claim it", async () => {
    const barrier = new Barrier(2);
    const holdAlphaText = new Deferred();
    const alphaReplanned = new Deferred();
    const provider = new ScopedSteerProvider(barrier, holdAlphaText, alphaReplanned);
    const events: Array<{ type: string; workstreamId?: string }> = [];
    const orchestrator = makeOrchestrator(provider, events);

    const pending = orchestrator.startRun({ runId: RUN_ID, sessionId: SESSION_ID, workspacePath: repoDir, goal: "two independent modules" });

    await barrier.reached;
    const steered = await orchestrator.steerWorkstream(RUN_ID, "alpha", STEER_MESSAGE, "scoped-steer-restart");
    expect(steered).toMatchObject({ ok: true });

    // Kill the run mid-flight (the process-death analog): the workstream never consumed the steer.
    expect(orchestrator.cancelRun(RUN_ID)).toBe(true);
    const cancelled = await pending;
    expect(cancelled.status).toBe("cancelled");

    // "Restart": a fresh orchestrator over the same durable store observes the same queued steer,
    // still owned by alpha, still unconsumed.
    const restartedProvider = new ScopedSteerProvider(new Barrier(2), new Deferred(), new Deferred());
    const restarted = makeOrchestrator(restartedProvider, []);
    const receipts = await persistence.getWorkItemsByKind("steer_receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ steerId: "scoped-steer-restart", targetWorkstreamId: "alpha", turnId: RUN_ID + ":alpha" });
    expect((receipts[0] as unknown as { consumedAt?: string }).consumedAt).toBeUndefined();

    // Exactly-once still holds after the restart: a retried steerId is a durable duplicate.
    expect(await restarted.steerWorkstream(RUN_ID, "alpha", STEER_MESSAGE, "scoped-steer-restart")).toMatchObject({ ok: true, duplicate: true });
    // The cancelled run is terminal: no new steering, and beta has no receipt of its own.
    expect((await restarted.steerWorkstream(RUN_ID, "beta", STEER_MESSAGE)).error).toBe("PARALLEL_RUN_TERMINAL");
    expect(receipts.filter((receipt) => (receipt as unknown as { targetWorkstreamId?: string }).targetWorkstreamId === "beta")).toHaveLength(0);
  }, 45_000);
});
