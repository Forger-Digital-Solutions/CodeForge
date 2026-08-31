import { describe, it, expect } from "vitest";
import { createApprovalService } from "../src/approval-service.js";

/**
 * The approval gate is the only thing standing between an autonomous agent and a side effect, so
 * its lifecycle has to hold under every ordering a real user can produce: a double-click, a decision
 * that arrives after the workflow already died, a stale card clicked minutes later, an id from a
 * different turn.
 *
 * Every test here asserts the same underlying property from a different angle — an approval
 * authorises AT MOST ONE execution, and only while it is genuinely pending.
 */
describe("approval lifecycle", () => {
  const request = (svc: ReturnType<typeof createApprovalService>, turnId = "turn-1") =>
    svc.requestApproval({
      turnId,
      tool: "edit_file",
      action: "write",
      description: "Edit src/calc.ts",
      risk: "moderate",
      scope: "/ws",
    });

  it("creates exactly one record per request", () => {
    const svc = createApprovalService();
    const { approvalId } = request(svc);
    expect(svc.getAllPending()).toHaveLength(1);
    expect(svc.getRecord(approvalId)?.state).toBe("pending");
  });

  it("resolves a pending approval once and reports it approved", async () => {
    const svc = createApprovalService();
    const { approvalId, promise } = request(svc);
    svc.resolve(approvalId, "allow_once");
    await expect(promise).resolves.toMatchObject({ approved: true, state: "approved" });
    expect(svc.getAllPending()).toHaveLength(0);
  });

  it("a double approve authorises exactly one execution", async () => {
    const svc = createApprovalService();
    const { approvalId, promise } = request(svc);

    // Count how many times the gate says "yes" — this is what a caller would act on.
    const first = svc.resolve(approvalId, "allow_once");
    const second = svc.resolve(approvalId, "allow_once");

    expect(first.approved).toBe(true);
    expect(second.approved).toBe(false);
    expect(second.reason).toMatch(/already/i);
    await expect(promise).resolves.toMatchObject({ approved: true });
  });

  it("a rejected approval never authorises execution", async () => {
    const svc = createApprovalService();
    const { approvalId, promise } = request(svc);
    const res = svc.resolve(approvalId, "deny");
    expect(res.approved).toBe(false);
    expect(res.state).toBe("rejected");
    await expect(promise).resolves.toMatchObject({ approved: false, state: "rejected" });
  });

  it("a cancelled approval never authorises execution, and a late approve cannot revive it", async () => {
    const svc = createApprovalService();
    const { approvalId, promise } = request(svc, "turn-cancel");
    svc.cancelForTurn("turn-cancel", "workflow cancelled");
    await expect(promise).resolves.toMatchObject({ approved: false, state: "cancelled" });

    // The user clicks Approve on a card that is still on screen.
    const late = svc.resolve(approvalId, "allow_once");
    expect(late.approved).toBe(false);
    expect(late.state).toBe("cancelled");
  });

  it("a late approve after the workflow already ended cannot execute anything", async () => {
    const svc = createApprovalService();
    const { approvalId, promise } = request(svc, "turn-failed");
    // This is what the workflow service now does when it reaches a terminal state.
    svc.cancelForTurn("turn-failed", "workflow failed before this approval was answered");
    await promise;
    expect(svc.resolve(approvalId, "allow_once").approved).toBe(false);
    expect(svc.getRecord(approvalId)?.state).toBe("cancelled");
  });

  it("an expired approval cannot be approved afterwards", async () => {
    const svc = createApprovalService();
    const { approvalId, promise } = request(svc);
    svc.expireNow(approvalId);
    await expect(promise).resolves.toMatchObject({ approved: false, state: "expired" });
    expect(svc.resolve(approvalId, "allow_once").approved).toBe(false);
  });

  it("an unknown approval id executes nothing", () => {
    const svc = createApprovalService();
    expect(() => svc.resolve("00000000-0000-0000-0000-000000000000", "allow_once")).toThrow(/not found/i);
  });

  it("cancelling one turn leaves another turn's approval untouched", async () => {
    const svc = createApprovalService();
    const a = request(svc, "turn-A");
    const b = request(svc, "turn-B");

    svc.cancelForTurn("turn-A");

    await expect(a.promise).resolves.toMatchObject({ approved: false, state: "cancelled" });
    expect(svc.getRecord(b.approvalId)?.state).toBe("pending");
    // Workflow B's approval still works on its own terms.
    expect(svc.resolve(b.approvalId, "allow_once").approved).toBe(true);
    await expect(b.promise).resolves.toMatchObject({ approved: true });
  });

  it("resolving one approval does not resolve a different pending one", async () => {
    const svc = createApprovalService();
    const first = request(svc, "turn-multi");
    const second = request(svc, "turn-multi");

    svc.resolve(first.approvalId, "allow_once");

    await expect(first.promise).resolves.toMatchObject({ approved: true });
    expect(svc.getRecord(second.approvalId)?.state).toBe("pending");
    expect(svc.getAllPendingForTurn("turn-multi")).toHaveLength(1);
  });

  it("keeps two sequential side effects distinguishable rather than collapsing them", () => {
    const svc = createApprovalService();
    const editA = svc.requestApproval({ turnId: "t", tool: "edit_file", action: "write", description: "Edit A", risk: "moderate", scope: "/ws/a.ts" });
    const editB = svc.requestApproval({ turnId: "t", tool: "edit_file", action: "write", description: "Edit B", risk: "moderate", scope: "/ws/b.ts" });

    expect(editA.approvalId).not.toBe(editB.approvalId);
    expect(svc.getAllPendingForTurn("t")).toHaveLength(2);

    svc.resolve(editA.approvalId, "allow_once");
    svc.resolve(editB.approvalId, "deny");

    expect(svc.getRecord(editA.approvalId)?.state).toBe("approved");
    expect(svc.getRecord(editB.approvalId)?.state).toBe("rejected");
  });

  it("an abort signal cancels the pending approval without executing", async () => {
    const svc = createApprovalService();
    const controller = new AbortController();
    const { approvalId, promise } = svc.requestApproval({
      turnId: "t", tool: "run_command", action: "shell", description: "npm test", risk: "high", signal: controller.signal,
    });
    controller.abort();
    await expect(promise).resolves.toMatchObject({ approved: false, state: "cancelled" });
    expect(svc.resolve(approvalId, "allow_once").approved).toBe(false);
  });

  it("a pending approval keeps its promise unsettled — the caller waits rather than failing", async () => {
    const svc = createApprovalService();
    const { promise } = request(svc);
    const settled = await Promise.race([promise.then(() => "settled"), new Promise((r) => setTimeout(() => r("still-waiting"), 60))]);
    expect(settled).toBe("still-waiting");
  });
});
