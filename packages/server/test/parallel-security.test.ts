import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createToolBroker } from "@codeforge/tools";
import { ERROR_CODES } from "@codeforge/agent";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createParallelAutonomousRunOrchestrator } from "../src/parallel-orchestrator.js";
import type { ParallelEvent } from "../src/parallel-state.js";

const execFile = promisify(execFileCallback);

describe("CF-08 cross-worktree ToolBroker firewall", () => {
  let root: string; let worktreeA: string; let worktreeB: string; let synthesis: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "cf08-security-")); worktreeA = path.join(root, "worktree-a"); worktreeB = path.join(root, "worktree-b"); synthesis = path.join(root, "synthesis"); await Promise.all([fs.mkdir(worktreeA), fs.mkdir(worktreeB), fs.mkdir(synthesis)]); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  async function write(from: string, target: string, permissions = { read: true, search: true, write: true, executeCommand: true, network: false }) { return createToolBroker().executeTool({ name: "write_file", arguments: JSON.stringify({ path: target, content: "forbidden" }) }, { workspacePath: from, permissions, role: "coder" }); }
  it("denies both Coder directions and leaves the other real worktree unmodified", async () => {
    const aToB = await write(worktreeA, path.join(worktreeB, "escape.txt")); const bToA = await write(worktreeB, path.join(worktreeA, "escape.txt"));
    expect(aToB).toMatchObject({ success: false }); expect(aToB.error).toMatch(new RegExp(`${ERROR_CODES.TOOL_WORKSPACE_ESCAPE}|${ERROR_CODES.TOOL_PATH_ESCAPE}`)); expect(bToA).toMatchObject({ success: false }); expect(bToA.error).toMatch(new RegExp(`${ERROR_CODES.TOOL_WORKSPACE_ESCAPE}|${ERROR_CODES.TOOL_PATH_ESCAPE}`)); await expect(fs.stat(path.join(worktreeA, "escape.txt"))).rejects.toThrow(); await expect(fs.stat(path.join(worktreeB, "escape.txt"))).rejects.toThrow();
  });
  it("confines synthesis writers and keeps both reviewer roles read-only", async () => {
    expect(await write(synthesis, path.join(worktreeA, "escape.txt"))).toMatchObject({ success: false }); expect(await write(synthesis, path.join(root, "primary.txt"))).toMatchObject({ success: false });
    for (const role of ["reviewer", "global-reviewer"]) { const result = await write(synthesis, "reviewer-write.txt", { read: true, search: true, write: false, executeCommand: false, network: false }); expect(result.error).toContain(ERROR_CODES.TOOL_PERMISSION_DENIED); }
    expect(await fs.readFile(path.join(synthesis, "reviewer-write.txt"), "utf8").catch(() => "absent")).toBe("absent");
  });
});

const CODER_A_PRIVATE = "CF08_CODER_A_PRIVATE_7c314af92e";
const REVIEWER_A_PRIVATE = "CF08_REVIEWER_A_PRIVATE_83b4f113dd";
const PUBLIC_FINDING = "PUBLIC_CF08_FINDING_FIX_NULL_HANDLER";
const PRIVACY_SESSION = "cf08g-privacy";

class PrivacyProvider implements ProviderAdapter {
  readonly providerId = "cf08g-privacy";
  readonly isTestProvider = true;
  readonly captured: Array<{ tag: string; payload: string }> = [];
  private reviewerAlphaCalls = 0;
  async listModels(): Promise<ProviderModel[]> { return [{ modelId: "free", displayName: "Free", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }]; }
  async chat(_request: ChatRequest): Promise<ChatResponse> { throw new Error("stream only"); }
  async healthCheck() { return { status: "available" as const }; }
  private classify(system: string, all: string): string {
    if (system.includes("CodeForge Planner")) return "planner";
    if (system.includes("CodeForge Reviewer")) return all.includes("Review synthesized implementation") ? "reviewer:global" : all.includes("Review workstream alpha") ? "reviewer:alpha" : "reviewer:beta";
    if (system.includes("CodeForge Coder")) return all.includes('"workstream":"alpha"') ? "coder:alpha" : "coder:beta";
    return "other";
  }
  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const all = request.messages.map((message) => message.content).join("\n");
    const tag = this.classify(system, all);
    this.captured.push({ tag, payload: JSON.stringify(request) });
    if (tag === "planner") {
      yield { type: "text_delta", delta: JSON.stringify({
        id: "cf08g-privacy", goal: "user api and its consumer", summary: "producer and consumer",
        workstreams: [
          { id: "alpha", title: "User API", objective: "Implement the user API module", dependencies: [], expectedFiles: ["src/user.mjs"], contractsProduced: ["user-api"] },
          { id: "beta", title: "User API consumer", objective: "Implement the consumer module", dependencies: ["alpha"], expectedFiles: ["src/beta.mjs"], contractsConsumed: ["user-api"] },
        ],
      }) };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    if (tag === "reviewer:alpha") {
      this.reviewerAlphaCalls++;
      const body = this.reviewerAlphaCalls === 1
        ? { verdict: "revision_required", findings: [{ id: "cf08-null-handler", severity: "blocking", category: "correctness", message: `${PUBLIC_FINDING}: guard the null user handler`, path: "src/user.mjs", line: 1 }], summary: "revision required" }
        : { verdict: "pass", findings: [], summary: "null handler guarded" };
      yield { type: "text_delta", delta: JSON.stringify(body) };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    if (tag.startsWith("reviewer:")) {
      yield { type: "text_delta", delta: JSON.stringify({ verdict: "pass", findings: [], summary: "approved" }) };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    if (tag.startsWith("coder:")) {
      const alpha = tag === "coder:alpha";
      const revising = alpha && all.includes(PUBLIC_FINDING);
      if (!request.messages.some((message) => message.role === "tool")) {
        const target = revising
          ? { path: "src/user-null-handler.mjs", content: "export const guarded = true;\n" }
          : alpha
            ? { path: "src/user.mjs", content: "export function getUser() { return { name: 'Ada' }; }\n" }
            : { path: "src/beta.mjs", content: "export const consumer = true;\n" };
        // A private working note that must never leave this agent's own transcript.
        if (alpha) yield { type: "text_delta", delta: `Working note ${CODER_A_PRIVATE}` };
        const callId = `write-${tag}-${revising ? "revision" : "initial"}`;
        yield { type: "tool_call_started", toolCallId: callId, toolName: "write_file" };
        yield { type: "tool_call_completed", toolCallId: callId, toolName: "write_file", arguments: JSON.stringify(target) };
        yield { type: "finish", finishReason: "tool_calls" }; return;
      }
      yield { type: "text_delta", delta: `${tag} complete` };
      yield { type: "finish", finishReason: "stop" }; return;
    }
    yield { type: "text_delta", delta: "done" };
    yield { type: "finish", finishReason: "stop" };
  }
}

describe("CF-08 private agent context firewall", () => {
  let repoDir: string; let worktreeDir: string; let persistence: ReturnType<typeof createSessionPersistence>;
  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf08g-privacy-repo-"));
    worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf08g-privacy-wt-"));
    persistence = createSessionPersistence();
    await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
    await execFile("git", ["config", "user.name", "CodeForge"], { cwd: repoDir });
    await execFile("git", ["config", "user.email", "codeforge@example.test"], { cwd: repoDir });
    await fs.mkdir(path.join(repoDir, "src"));
    await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ type: "module" }));
    await fs.writeFile(path.join(repoDir, "src", "base.mjs"), "export const base = true;\n");
    await execFile("git", ["add", "."], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "base"], { cwd: repoDir });
  });
  afterEach(async () => { await persistence.close(); await fs.rm(repoDir, { recursive: true, force: true }); await fs.rm(worktreeDir, { recursive: true, force: true }); });

  it("keeps private Coder and Reviewer context inside its own agent while public artifacts still cross", async () => {
    const provider = new PrivacyProvider();
    const catalog = new InMemoryProviderCatalog(); catalog.register(provider);
    const firewall = new ForgeZero(); firewall.register(createGenericFreeRecord());
    const events: ParallelEvent[] = [];
    const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: worktreeDir });
    const runtime = createAgentRuntime({ sessionId: PRIVACY_SESSION, eventStore: new EventStore(), persistence, firewall, providerCatalog: catalog, workspacePath: repoDir });
    const orchestrator = createParallelAutonomousRunOrchestrator({ workspaceService, agentRuntime: runtime, persistence, onEvent: (event) => { events.push(event); } });

    const result = await orchestrator.startRun({
      sessionId: PRIVACY_SESSION, workspacePath: repoDir, goal: "Implement the user API and its consumer",
      privateAgentContext: { "coder:alpha": `Operator briefing: ${CODER_A_PRIVATE}`, "reviewer:alpha": `Operator briefing: ${REVIEWER_A_PRIVATE}` },
    });
    expect(result.status).toBe("completed");

    const requests = provider.captured;
    const byTag = (tag: string) => requests.filter((entry) => entry.tag === tag);
    expect(byTag("coder:alpha").length).toBeGreaterThanOrEqual(3);
    expect(byTag("coder:beta").length).toBeGreaterThanOrEqual(2);
    expect(byTag("reviewer:alpha")).toHaveLength(2);
    expect(byTag("reviewer:beta")).toHaveLength(1);
    expect(byTag("reviewer:global")).toHaveLength(1);

    // Positive control: each private briefing really did reach its own agent's provider request.
    expect(byTag("coder:alpha").every((entry) => entry.payload.includes(CODER_A_PRIVATE))).toBe(true);
    expect(byTag("reviewer:alpha").every((entry) => entry.payload.includes(REVIEWER_A_PRIVATE))).toBe(true);

    // Isolation: neither marker appears in any other agent's provider request, including the
    // Coder A revision request, the global Reviewer, and every synthesis-side agent.
    for (const entry of requests.filter((candidate) => candidate.tag !== "coder:alpha")) expect(entry.payload).not.toContain(CODER_A_PRIVATE);
    for (const entry of requests.filter((candidate) => candidate.tag !== "reviewer:alpha")) expect(entry.payload).not.toContain(REVIEWER_A_PRIVATE);
    for (const entry of byTag("coder:alpha")) expect(entry.payload).not.toContain(REVIEWER_A_PRIVATE);
    for (const tag of ["coder:beta", "reviewer:beta", "reviewer:global", "planner"]) {
      for (const entry of byTag(tag)) { expect(entry.payload).not.toContain(CODER_A_PRIVATE); expect(entry.payload).not.toContain(REVIEWER_A_PRIVATE); }
    }

    // Public orchestration surfaces stay clean.
    const run = await orchestrator.getRun(result.runId)!;
    const surfaces = [
      JSON.stringify(run.contracts),
      JSON.stringify(run.workstreams),
      JSON.stringify(run.synthesis),
      JSON.stringify(events),
      JSON.stringify(await persistence.getEvents(PRIVACY_SESSION)),
      JSON.stringify(await persistence.getWorkItem(result.runId)),
      JSON.stringify(await persistence.getAllWorkItems()),
    ];
    for (const serialized of surfaces) { expect(serialized).not.toContain(CODER_A_PRIVATE); expect(serialized).not.toContain(REVIEWER_A_PRIVATE); }
    expect(JSON.stringify(await persistence.getAllWorkItems())).toContain("alpha");

    // The public event stream still describes the whole lifecycle the product renders.
    const emitted = new Set(events.map((event) => event.type));
    const lifecycle = ["parallel.plan.created", "parallel.plan.validated", "workstream.ready", "workstream.dispatched", "workstream.started", "workstream.reviewing", "workstream.revising", "workstream.completed", "contract.published", "synthesis.started", "synthesis.workstream_added", "global_verification.started", "global_verification.completed", "global_review.started", "global_review.completed", "promotion.started", "promotion.completed"];
    expect(lifecycle.filter((type) => !emitted.has(type))).toEqual([]);

    // Positive: structured public findings and published contracts intentionally cross.
    const revisionRequest = byTag("coder:alpha").find((entry) => entry.payload.includes(PUBLIC_FINDING));
    expect(revisionRequest).toBeDefined();
    expect(revisionRequest!.payload).toContain("Structured Review Findings to address");
    expect(events.find((event) => event.type === "workstream.revising" && event.workstreamId === "alpha")?.payload).toMatchObject({ findingIds: ["cf08-null-handler"] });
    const alphaRevision = run.workstreams.find((workstream) => workstream.workstreamId === "alpha")!.resultRevision!;
    expect(run.contracts.map((state) => state.contract.id)).toEqual(["user-api"]);
    expect(byTag("coder:beta").some((entry) => entry.payload.includes(`Published contract user-api at revision ${alphaRevision.slice(0, 12)}`))).toBe(true);
  }, 240_000);
});
