import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createServer } from "../src/index.js";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";

/**
 * End-to-end autonomous plan execution, through the real machinery.
 *
 * Nothing on the path under test is mocked: the WorkflowEngine, AgentExecutor, AgentRuntime,
 * ApprovalService, the HTTP approval route, the edit tool and the verification runner all execute
 * for real, and the workspace's `npm test` genuinely fails before the edit and passes after it.
 * Only the MODEL is deterministic — replaying a fixed tool sequence — so the test asserts the
 * pipeline's behaviour rather than an LLM's mood, and costs nothing to run.
 *
 * This is the regression barrier for the defect where an approved edit landed correctly and the
 * workflow still reported failure with no evidence and no checkpoint.
 */

function sha256(t: string): string {
  return crypto.createHash("sha256").update(t, "utf-8").digest("hex");
}

function toolCall(toolName: string, args: Record<string, unknown>, id: string): any[] {
  const json = JSON.stringify(args);
  return [
    { type: "tool_call_started", toolCallId: id, toolName },
    { type: "tool_call_delta", toolCallId: id, delta: json },
    { type: "tool_call_completed", toolCallId: id, toolName, arguments: json },
  ];
}

async function api(url: string, body?: unknown, method = "POST"): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
const FIXED_LINE = "  return a + b;";
const BUGGY_LINE = "  return a - b;";

describe("autonomous plan execution — approve / reject / cancel", () => {
  let ws: string;
  let server: any;
  let port: number;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "plan-exec-"));
    await mkdir(join(ws, "src"), { recursive: true });
    await mkdir(join(ws, "test"), { recursive: true });
    await writeFile(join(ws, "src", "calc.js"), BUGGY);
    // A verification command that really runs and really distinguishes the two states.
    await writeFile(
      join(ws, "test", "calc.test.js"),
      "import { add } from '../src/calc.js';\n" +
        "if (add(2, 3) !== 5) { console.log('1 failed'); process.exit(1); }\n" +
        "console.log('1 passed');\n",
    );
    await writeFile(
      join(ws, "package.json"),
      JSON.stringify({ name: "plan-exec", type: "module", scripts: { test: "node test/calc.test.js" } }, null, 2),
    );
  });

  afterEach(async () => {
    if (server) await server.stop();
    await rm(ws, { recursive: true, force: true });
  });

  async function startServer(): Promise<void> {
    const hash = sha256(fs.readFileSync(join(ws, "src", "calc.js"), "utf-8"));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(
      createMockProvider({
        providerId: "codeforge",
        streamEvents: [
          [...toolCall("read_file", { path: "src/calc.js" }, "c1"), { type: "finish", finishReason: "tool_calls" }],
          [
            ...toolCall("edit_file", { path: "src/calc.js", oldText: BUGGY_LINE, newText: FIXED_LINE, expectedHash: hash }, "c2"),
            { type: "finish", finishReason: "tool_calls" },
          ],
          [{ type: "text_delta", delta: "Fixed add()" }, { type: "finish", finishReason: "stop" }],
        ],
      }) as any,
    );
    server = createServer({ port: 0, dbPath: ":memory:", providerCatalog: catalog, useRealRuntime: true } as any);
    await server.start();
    port = server.httpPort;
    await api(`http://localhost:${port}/api/workspace/set`, { path: ws });
  }

  const sessionUrl = (id: string) => `http://localhost:${port}/api/sessions/${id}`;
  const readCalc = () => fs.readFileSync(join(ws, "src/calc.js"), "utf-8");

  it("the workspace's verification genuinely fails before the fix", async () => {
    // Guards the test itself: if this passed on the buggy file, a later "PASS" would prove nothing.
    const { runVerification, verificationFailed } = await import("@codeforge/workflow");
    const before = await runVerification(ws, ["npm test"]);
    expect(verificationFailed(before)).toBe(true);
  }, 30000);

  it("approve: one approval per side effect, edit applied once, verification passes, evidence and checkpoint recorded", async () => {
    await startServer();
    const run = await api(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "approve-sess",
      message: "Fix the add function in src/calc.js so it correctly adds two numbers.",
    });
    expect(run.status).toBe(200);
    const { taskId } = run.body as { taskId: string };

    const approvalsSeen = new Set<string>();
    const approvalsAccepted: string[] = [];
    let task: any;

    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const sess = await api(sessionUrl("approve-sess"), undefined, "GET");
      for (const a of (sess.body?.pendingApprovals ?? []) as Array<{ approvalId: string }>) {
        approvalsSeen.add(a.approvalId);
        // Deliberately resolve twice: a real user double-click must still execute once.
        await api(`http://localhost:${port}/api/approvals/${a.approvalId}/resolve`, { decision: "allow_once" });
        await api(`http://localhost:${port}/api/approvals/${a.approvalId}/resolve`, { decision: "allow_once" });
        approvalsAccepted.push(a.approvalId);
      }
      const wf = await api(`http://localhost:${port}/api/workflow/${taskId}`, undefined, "GET");
      task = wf.body?.task;
      if (task && ["completed", "failed", "cancelled"].includes(task.phase)) break;
    }

    // The edit landed, exactly once.
    const after = readCalc();
    expect(after).toContain("a + b");
    expect(after).not.toContain("a - b");
    expect(after.split("a + b").length - 1).toBe(1);

    // The workflow completed rather than failing behind a successful edit.
    expect(task.phase).toBe("completed");

    const sess = await api(sessionUrl("approve-sess"), undefined, "GET");
    const types = ((sess.body?.events ?? []) as Array<{ type: string }>).map((e) => e.type);

    // Real evidence and a real checkpoint, not fabricated from plan intent.
    expect(types).toContain("evidence.created");
    expect(types).toContain("checkpoint.created");

    // Verification actually ran, and passed on the fixed file.
    const { runVerification, verificationPassed } = await import("@codeforge/workflow");
    const verified = await runVerification(ws, ["npm test"]);
    expect(verificationPassed(verified)).toBe(true);

    // No approval outlives the workflow.
    expect((sess.body?.pendingApprovals ?? []).length).toBe(0);
    expect(approvalsSeen.size).toBeGreaterThan(0);
  }, 60000);

  it("reject: the file is untouched and the workflow does not claim success", async () => {
    await startServer();
    const run = await api(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "reject-sess",
      message: "Fix the add function in src/calc.js so it correctly adds two numbers.",
    });
    const { taskId } = run.body as { taskId: string };

    let task: any;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const sess = await api(sessionUrl("reject-sess"), undefined, "GET");
      for (const a of (sess.body?.pendingApprovals ?? []) as Array<{ approvalId: string }>) {
        await api(`http://localhost:${port}/api/approvals/${a.approvalId}/resolve`, { decision: "deny" });
      }
      const wf = await api(`http://localhost:${port}/api/workflow/${taskId}`, undefined, "GET");
      task = wf.body?.task;
      if (task && ["completed", "failed", "cancelled"].includes(task.phase)) break;
    }

    expect(readCalc()).toBe(BUGGY);
    expect(task.phase).not.toBe("completed");

    const sess = await api(sessionUrl("reject-sess"), undefined, "GET");
    const types = ((sess.body?.events ?? []) as Array<{ type: string }>).map((e) => e.type);
    // A denied plan must not leave evidence claiming an edit happened.
    expect(types).not.toContain("evidence.created");
    expect((sess.body?.pendingApprovals ?? []).length).toBe(0);
  }, 60000);

  it("cancel: a pending approval dies with its workflow and a late approve executes nothing", async () => {
    await startServer();
    const run = await api(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "cancel-sess",
      message: "Fix the add function in src/calc.js so it correctly adds two numbers.",
    });
    const { taskId } = run.body as { taskId: string };

    // Wait for a real approval to be pending, then cancel the workflow underneath it.
    let pendingId: string | undefined;
    for (let i = 0; i < 40 && !pendingId; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const sess = await api(sessionUrl("cancel-sess"), undefined, "GET");
      pendingId = ((sess.body?.pendingApprovals ?? []) as Array<{ approvalId: string }>)[0]?.approvalId;
    }
    expect(pendingId).toBeDefined();

    await api(`http://localhost:${port}/api/workflow/${taskId}/cancel`, {});
    await new Promise((r) => setTimeout(r, 800));

    // The stale card is clicked after the workflow is gone.
    const late = await api(`http://localhost:${port}/api/approvals/${pendingId}/resolve`, { decision: "allow_once" });
    await new Promise((r) => setTimeout(r, 600));

    expect(readCalc()).toBe(BUGGY);
    // Either the approval is gone entirely, or it is terminal — never a fresh authorisation.
    expect([200, 404]).toContain(late.status);
    const sess = await api(sessionUrl("cancel-sess"), undefined, "GET");
    expect((sess.body?.pendingApprovals ?? []).length).toBe(0);
  }, 60000);
});
