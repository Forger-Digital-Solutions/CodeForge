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

  async function runToTerminal(sessionId: string, streamEvents: unknown[][], verification: string): Promise<{ status: string; events: Array<{ type: string; payload?: { label?: string; blockers?: Array<{ code: string }> } }> }> {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "codeforge", streamEvents: streamEvents as never }));
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true });
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
  });

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
  });

  it("does not block completion when the reviewer verdict is unparseable", async () => {
    const before = await readFile(join(workspace, "src", "calc.ts"), "utf8");
    const hash = createHash("sha256").update(before).digest("hex");
    const { status, events } = await runToTerminal("goal-review-garbage", [
      toolCall("read_file", { path: "src/calc.ts" }, "read-1"),
      toolCall("edit_file", { path: "src/calc.ts", oldText: "a - b", newText: "a + b", expectedHash: hash }, "edit-1"),
      finalText("Implemented the change."),
      finalText("I looked at the file and it seems fine, probably."),
    ], "node -e \"const fs=require('fs');process.exit(fs.readFileSync('src/calc.ts','utf8').includes('a + b')?0:1)\"");

    expect(status).toBe("complete");
    expect(events.filter((event) => event.type === "turn.started" && event.payload?.label === "Reviewing goal conformance")).toHaveLength(1);
  });
});
