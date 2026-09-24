import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";

type Server = ReturnType<typeof createServer>;
type ApiResponse = { status: number; body: Record<string, unknown> };

function toolCall(name: string, args: Record<string, unknown>, id: string) {
  const json = JSON.stringify(args);
  return [
    { type: "tool_call_started" as const, toolCallId: id, toolName: name },
    { type: "tool_call_delta" as const, toolCallId: id, delta: json },
    { type: "tool_call_completed" as const, toolCallId: id, toolName: name, arguments: json },
    { type: "finish" as const, finishReason: "tool_calls" },
  ];
}

function finalText(text: string) {
  return [
    { type: "text_delta" as const, delta: text },
    { type: "finish" as const, finishReason: "stop" },
  ];
}

const UNMET_VERDICT = `{"verdicts":[{"goal":"sum adds two numbers","status":"unmet","evidence":"src/calc.ts still subtracts","path":"src/calc.ts"}]}`;
const MET_VERDICT = `{"verdicts":[{"goal":"sum adds two numbers","status":"met","evidence":"src/calc.ts returns a + b","path":"src/calc.ts"}]}`;

async function fetchJson(url: string, body?: unknown): Promise<ApiResponse> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("workflow goal-conformance review", () => {
  let workspace: string;
  let server: Server | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "workflow-goal-review-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "calc.ts"), "export const sum = (a: number, b: number) => a - b;\n");
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "goal-review-test", type: "module" }));
  });

  afterEach(async () => {
    await server?.stop();
    await rm(workspace, { recursive: true, force: true });
  });

  async function runToTerminal(sessionId: string, streamEvents: unknown[][], verification: string, serverOptions: Record<string, unknown> = {}): Promise<{ status: string; events: Array<{ type: string; payload?: { label?: string; blockers?: Array<{ code: string }> } }> }> {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "codeforge", streamEvents: streamEvents as never }));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true, ...serverOptions });
    await server.start();
    const base = `http://localhost:${server.httpPort}`;
    expect((await fetchJson(`${base}/api/workspace/set`, { path: workspace })).status).toBe(200);
    const started = await fetchJson(`${base}/api/workflow/run`, {
      sessionId,
      message: "Fix sum so it adds two numbers",
      verificationCommands: [verification],
    });
    expect(started.status).toBe(200);
    const taskId = String(started.body.taskId);

    let status = "";
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const session = await fetchJson(`${base}/api/sessions/${sessionId}`);
      for (const approval of (session.body.pendingApprovals ?? []) as Array<{ approvalId: string }>) {
        await fetchJson(`${base}/api/approvals/${approval.approvalId}/resolve`, { decision: "allow_once" });
      }
      const workflow = await fetchJson(`${base}/api/workflow/${taskId}`);
      status = String((workflow.body.task as { status: string }).status);
      if (["complete", "completed", "blocked", "failed"].includes(status)) break;
    }
    const session = await fetchJson(`${base}/api/sessions/${sessionId}`);
    return { status, events: session.body.events as Array<{ type: string; payload?: { label?: string; blockers?: Array<{ code: string }> } }> };
  }

  it("blocks a run whose weak verification passed but the goal review found the goal unmet", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    // The implement turn makes the WRONG edit (a * b) and the configured check is vacuous:
    // without goal review this is exactly the R30 false-completion class.
    const { status, events } = await runToTerminal("goal-review-blocked", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a * b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText(UNMET_VERDICT),
    ], "node -e \"process.exit(0)\"");

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance").length).toBeGreaterThan(0);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(decided).toBeDefined();
    expect(JSON.stringify(decided?.payload ?? {})).toContain("review_rejected");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("still subtracts");
  }, 30_000);

  it("repairs an unmet goal once, then completes when the re-review confirms", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    const wrongHash = createHash("sha256").update("export const sum = (a: number, b: number) => a * b;\n").digest("hex");
    // Vacuous verification keeps the gate open for the wrong edit so the goal review is what
    // drives the conformance repair — verification-driven repair would mask it.
    const { status, events } = await runToTerminal("goal-review-repair", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a * b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText(UNMET_VERDICT),
      toolCall("read_file", { path: "src/calc.ts" }, "repair-read"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a * b", newText: "a + b", expectedHash: wrongHash }, "repair-edit"),
      finalText("Corrected the implementation."),
      finalText(MET_VERDICT),
    ], "node -e \"process.exit(0)\"");

    expect(await readFile(join(workspace, "src", "calc.ts"), "utf8")).toContain("a + b");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(2);
    expect(status).toBe("complete");
  }, 30_000);

  it("blocks completion when the reviewer produces no decisive verdict, even after a retry", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    // R32: a review that yields no usable verdict proves nothing — deterministic checks alone
    // can no longer complete the run. The engine re-reviews once, then the gate blocks.
    const { status, events } = await runToTerminal("goal-review-garbage", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText("I looked at the file and it seems fine, probably."),
      finalText("Second look — still seems fine, I think."),
    ], "node -e \"const fs=require('fs');process.exit(fs.readFileSync('src/calc.ts','utf8').includes('a + b')?0:1)\"");

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(2);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("goal_review_inconclusive");
  }, 30_000);

  it("still reaches the review when implementation exhausts the primary inference partition", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    // total 3 / reserve 1 → the primary lane caps at 2 requests, so the implement turn dies
    // mid-script at its third dispatch (a refused dispatch consumes no script event). The
    // reserved lane still funds one review request — the verdict lands — but the run is
    // blocked on the unfinished plan, never claimed as a success.
    const { status, events } = await runToTerminal("goal-review-primary-exhaustion", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText(MET_VERDICT),
    ], "node -e \"process.exit(0)\"", { workflowInferenceBudget: { total: 3, reserve: 1 } });

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(1);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("plan_steps_unfinished");
  }, 30_000);

  it("blocks when the reserved review budget runs out before a verdict", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    // Implementation fits the primary partition exactly (2 requests: edit, then final text),
    // leaving the review a single reserved request. The first review turn wastes it on prose;
    // the bounded retry is refused instantly — a starved review must never read as a pass.
    const { status, events } = await runToTerminal("goal-review-reserve-exhaustion", [
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText("Looks right to me."),
      finalText("Another look — I remain unsure."),
    ], "node -e \"const fs=require('fs');process.exit(fs.readFileSync('src/calc.ts','utf8').includes('a + b')?0:1)\"", { workflowInferenceBudget: { total: 3, reserve: 1 } });

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(2);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("goal_review_inconclusive");
  }, 30_000);

  it("blocks when every reviewer verdict is explicitly indeterminate", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    const indeterminate = `{"verdicts":[{"goal":"sum adds two numbers","status":"indeterminate","evidence":"could not tell","path":"src/calc.ts"}]}`;
    const { status, events } = await runToTerminal("goal-review-indeterminate", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText(indeterminate),
      finalText(indeterminate),
    ], "node -e \"process.exit(0)\"");

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(2);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("goal_review_inconclusive");
  }, 30_000);

  it("blocks when the review response is empty", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    const { status, events } = await runToTerminal("goal-review-empty", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      [{ type: "finish", finishReason: "stop" }],
      [{ type: "finish", finishReason: "stop" }],
    ], "node -e \"process.exit(0)\"");

    expect(status).toBe("blocked");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(2);
    const decided = events.find((event) => event.type === "workflow.completion_decided");
    expect(JSON.stringify(decided?.payload ?? {})).toContain("goal_review_inconclusive");
  }, 30_000);

  it("completes on a decisive verdict even when the primary partition is spent", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    // total 5 / reserve 2 → implementation's 3 requests exactly spend the primary partition;
    // the reserved lane still funds the review and its verdict authorizes completion.
    const { status, events } = await runToTerminal("goal-review-reserve-works", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText(MET_VERDICT),
    ], "node -e \"const fs=require('fs');process.exit(fs.readFileSync('src/calc.ts','utf8').includes('a + b')?0:1)\"", { workflowInferenceBudget: { total: 5, reserve: 2 } });

    expect(status).toBe("complete");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(1);
  }, 30_000);
});
