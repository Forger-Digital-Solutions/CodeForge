import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/index.js";

async function fetchJson(url: string, body?: unknown, method = "POST"): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

interface PendingApproval { approvalId: string; action: string; tool: string }

async function pendingPlanApprovals(port: number, sessionId: string): Promise<PendingApproval[]> {
  const sess = await fetchJson(`http://localhost:${port}/api/sessions/${sessionId}`, undefined, "GET");
  const pending = (sess.body as { pendingApprovals?: PendingApproval[] }).pendingApprovals ?? [];
  return pending.filter((a) => a.action === "execute_plan");
}

async function waitForPhase(port: number, taskId: string, phases: string[], timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const get = await fetchJson(`http://localhost:${port}/api/workflow/${taskId}`, undefined, "GET");
    const task = (get.body as { task?: { phase?: string; status?: string } }).task;
    last = `${task?.phase ?? ""}/${task?.status ?? ""}`;
    if (task && (phases.includes(task.phase ?? "") || phases.includes(task.status ?? ""))) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

describe("Plan gate — workflow transitions are not permission boundaries", () => {
  let ws: string;
  let port: number;
  let server: InstanceType<typeof createServer>;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "plan-gate-"));
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "calc.ts"), "export function add(a:number,b:number){return a-b}");
    await writeFile(join(ws, "package.json"), JSON.stringify({ type: "module" }));
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    port = (server as unknown as { httpPort: number }).httpPort;
    await fetchJson(`http://localhost:${port}/api/workspace/set`, { path: ws });
  });

  afterEach(async () => {
    await server.stop();
    await rm(ws, { recursive: true, force: true });
  });

  it("authority endpoint validates, persists, and exposes the lease on the session", async () => {
    const bad = await fetchJson(`http://localhost:${port}/api/sessions/sess-auth/authority`, { permissionMode: "everything" });
    expect(bad.status).toBe(400);
    const empty = await fetchJson(`http://localhost:${port}/api/sessions/sess-auth/authority`, {});
    expect(empty.status).toBe(400);

    const ok = await fetchJson(`http://localhost:${port}/api/sessions/sess-auth/authority`, {
      permissionMode: "full_autonomy",
      planMode: "review_first",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ authority: { permissionMode: "full_autonomy", planMode: "review_first" } });

    const sess = await fetchJson(`http://localhost:${port}/api/sessions/sess-auth`, undefined, "GET");
    expect((sess.body as { authority: { permissionMode: string; planMode: string } }).authority)
      .toMatchObject({ permissionMode: "full_autonomy", planMode: "review_first" });
  });

  it("Plan: Auto runs an approval-required plan to completion with zero permission cards", async () => {
    const run = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-auto",
      message: "Implement a multi file feature that fixes add across the codebase",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(run.status).toBe(200);
    const { taskId } = run.body as { taskId: string };

    const terminal = await waitForPhase(port, taskId, ["completed", "complete", "failed", "cancelled", "done"]);
    expect(terminal).not.toContain("awaiting_approval");

    // The run must never have parked on a plan decision.
    const plans = await pendingPlanApprovals(port, "sess-auto");
    expect(plans).toHaveLength(0);
  }, 30_000);

  it("Plan: Review First surfaces exactly one execute_plan decision and proceeds after it", async () => {
    await fetchJson(`http://localhost:${port}/api/sessions/sess-review/authority`, { planMode: "review_first" });
    const run = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-review",
      message: "Implement a multi file feature that fixes add across the codebase",
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(run.status).toBe(200);
    const { taskId } = run.body as { taskId: string };

    // Wait for the plan decision to surface.
    let planApprovals: PendingApproval[] = [];
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && planApprovals.length === 0) {
      planApprovals = await pendingPlanApprovals(port, "sess-review");
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(planApprovals).toHaveLength(1);

    await fetchJson(`http://localhost:${port}/api/approvals/${planApprovals[0].approvalId}/resolve`, { decision: "allow_once" });

    const terminal = await waitForPhase(port, taskId, ["completed", "complete", "failed", "cancelled", "done"]);
    expect(terminal).not.toContain("awaiting_approval");

    // One decision, one card — the same run never asks again.
    expect(await pendingPlanApprovals(port, "sess-review")).toHaveLength(0);
  }, 30_000);

  it("repair continuation inherits the session lease — no second plan card under Auto", async () => {
    const first = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-repair",
      message: "Fix the add function",
      verificationCommands: ["node -e \"process.exit(1)\""],
    });
    expect(first.status).toBe(200);
    const { taskId } = first.body as { taskId: string };
    await waitForPhase(port, taskId, ["completed", "complete", "failed", "cancelled", "done", "blocked"]);

    const repair = await fetchJson(`http://localhost:${port}/api/workflow/run`, {
      sessionId: "sess-repair",
      message: "continue",
      repair: true,
      verificationCommands: ["node -e \"process.exit(0)\""],
    });
    expect(repair.status).toBe(200);
    const repairTask = (repair.body as { taskId: string }).taskId;
    await waitForPhase(port, repairTask, ["completed", "complete", "failed", "cancelled", "done", "blocked"]);

    // The continuation never produced a plan approval card.
    expect(await pendingPlanApprovals(port, "sess-repair")).toHaveLength(0);
  }, 45_000);
});
