import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";

/**
 * When the agent's working budget runs out mid-implementation, the workflow must STOP the agent
 * before it moves on. On the first real live task the budget expired while the model was still
 * editing: the workflow verified, reviewed and declared the task failed while an orphaned agent
 * turn kept mutating the workspace and raising approvals the UI no longer surfaced — and the repair
 * turn could not even start because the session still had that active turn.
 */
async function fetchJson(url: string, body?: unknown, method = "POST"): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A model that never finishes: every iteration writes another file. */
function endlessWriter(onWrite: () => void) {
  let iteration = 0;
  return {
    providerId: "codeforge",
    displayName: "Mock Provider",
    isTestProvider: false,
    models: () => [createGenericFreeRecord()],
    streamChat: () => (async function* () {
      iteration += 1;
      onWrite();
      // Real models think for a while; without this the runtime's own iteration ceiling (50) would
      // end the turn before the workflow's working budget is what stops it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const name = `scratch-${iteration}.txt`;
      yield { type: "tool_call_started", toolCallId: `tc-${iteration}`, toolName: "write_file" };
      yield { type: "tool_call_completed", toolCallId: `tc-${iteration}`, toolName: "write_file", arguments: JSON.stringify({ path: name, content: `iteration ${iteration}` }) };
      yield { type: "finish", finishReason: "tool_calls" as const };
    })(),
  } as any;
}

describe("workflow agent working budget", () => {
  let ws: string;
  let server: any;
  let port: number;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-agent-budget-"));
    await writeFile(join(ws, "package.json"), JSON.stringify({ name: "budget-fixture", version: "1.0.0", scripts: { test: "node -e \"process.exit(0)\"" } }));
  });

  afterEach(async () => {
    if (server) await server.stop();
    await rm(ws, { recursive: true, force: true });
  });

  it("cancels the agent turn when the budget is exhausted and fails the task truthfully", async () => {
    let modelCalls = 0;
    const catalog = new InMemoryProviderCatalog();
    catalog.register(endlessWriter(() => { modelCalls += 1; }));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true, agentWorkingBudgetMs: 1_500 } as any);
    await server.start();
    port = server.httpPort;
    server.setWorkspace(ws);

    const started = await fetchJson(`http://localhost:${port}/api/send`, { sessionId: "budget", message: "Implement the feature", executionMode: "agent" });
    expect(started.status).toBe(200);
    const events = () => (server as any).eventStore.getBySession("budget") as Array<{ type: string; payload: any }>;
    const runtime = () => (server as any).runtimes.get("budget");

    // Drive the workflow: approve the plan, then approve writes for the session so the agent works.
    const waitFor = async (check: () => boolean, ms = 15_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("condition not met in time");
    };
    await waitFor(() => events().some((event) => event.type === "approval.requested" && event.payload.tool === "workflow"));
    const planApproval = events().find((event) => event.type === "approval.requested" && event.payload.tool === "workflow")!.payload.approvalId;
    server.workflowService.getApprovalService().resolve(planApproval, "allow_once");
    await waitFor(() => events().some((event) => event.type === "approval.requested" && event.payload.tool === "write_file"));
    const writeApproval = events().find((event) => event.type === "approval.requested" && event.payload.tool === "write_file")!.payload.approvalId;
    await runtime().resolveApproval(writeApproval, "allow_session");

    await waitFor(() => events().some((event) => event.type === "workflow.completion_decided"), 30_000);
    const decision = events().find((event) => event.type === "workflow.completion_decided")!.payload;
    expect(decision.outcome).not.toBe("completed");

    // The agent turn is cancelled — not still running in the background.
    const agentTurns = events().filter((event) => event.type === "turn.started").map((event) => event.payload.turnId);
    const builderTurn = agentTurns.find((turnId) => runtime().getTurn(turnId));
    expect(builderTurn).toBeDefined();
    await waitFor(() => runtime().getTurn(builderTurn!)?.status === "cancelled", 5_000);
    expect(decision.rationale).toContain("plan_steps_unfinished");

    // No writes land after the decision: whatever the model still wanted to do is over.
    const callsAtDecision = modelCalls;
    const filesAtDecision = (await readdir(ws)).filter((name) => name.startsWith("scratch-")).length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(modelCalls).toBe(callsAtDecision);
    expect((await readdir(ws)).filter((name) => name.startsWith("scratch-")).length).toBe(filesAtDecision);
    // The workflow recorded WHY the implementation stopped, in the user's terms.
    const implementation = events().find((event) => event.type === "workflow.implementation_completed" || event.type === "workflow.implementation_failed");
    const summary = JSON.stringify(implementation?.payload ?? events().find((event) => event.type === "turn.failed")?.payload ?? {});
    expect(summary).toMatch(/working budget|exhausted/i);
  });
});
