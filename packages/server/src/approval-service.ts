/**
 * Authoritative tool-execution approval gate.
 *
 * Invariants:
 * - A consequential tool cannot execute without resolved approval.
 * - Rejected/cancelled/expired approvals never execute.
 * - Duplicate resolutions execute at most once.
 * - Cancellation wins over late approvals.
 */

export type ApprovalState = "pending" | "approved" | "rejected" | "cancelled" | "expired";
export type ApprovalDecision = "allow_once" | "allow_session" | "deny";

export interface ApprovalRecord {
  approvalId: string;
  turnId: string;
  tool: string;
  action: string;
  description: string;
  risk: "safe" | "moderate" | "high" | "critical";
  scope?: string;
  state: ApprovalState;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  decision?: ApprovalDecision;
}

export interface ApprovalGateResult {
  approved: boolean;
  state: ApprovalState;
  decision?: ApprovalDecision;
  reason?: string;
}

type Resolver = (result: ApprovalGateResult) => void;

interface Pending {
  record: ApprovalRecord;
  resolver: Resolver;
  timer: ReturnType<typeof setTimeout>;
  signalHandler?: () => void;
}

export interface ApprovalServiceOptions {
  defaultTimeoutMs?: number;
}

export class ApprovalService {
  private readonly pendings: Map<string, Pending> = new Map();
  private readonly records: Map<string, ApprovalRecord> = new Map();
  private readonly defaultTimeoutMs: number;

  constructor(options: ApprovalServiceOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60 * 1000;
  }

  requestApproval(params: {
    turnId: string;
    tool: string;
    action: string;
    description: string;
    risk: "safe" | "moderate" | "high" | "critical";
    scope?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): { approvalId: string; promise: Promise<ApprovalGateResult>; record: ApprovalRecord } {
    const approvalId = crypto.randomUUID();
    const now = Date.now();
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const record: ApprovalRecord = {
      approvalId,
      turnId: params.turnId,
      tool: params.tool,
      action: params.action,
      description: params.description,
      risk: params.risk,
      scope: params.scope,
      state: "pending",
      createdAt: now,
      expiresAt: now + timeoutMs,
    };
    this.records.set(approvalId, record);

    let resolver!: Resolver;
    const promise = new Promise<ApprovalGateResult>((resolve) => {
      resolver = resolve;
    });

    const timer = setTimeout(() => {
      const p = this.pendings.get(approvalId);
      if (!p) return;
      if (p.record.state !== "pending") return;
      p.record.state = "expired";
      p.record.resolvedAt = Date.now();
      this.pendings.delete(approvalId);
      p.resolver({ approved: false, state: "expired", reason: "Approval expired" });
      if (p.signalHandler && params.signal) {
        params.signal.removeEventListener("abort", p.signalHandler);
      }
    }, timeoutMs);

    const pending: Pending = { record, resolver, timer };
    this.pendings.set(approvalId, pending);

    if (params.signal) {
      const handler = (): void => {
        const cur = this.pendings.get(approvalId);
        if (!cur) return;
        if (cur.record.state !== "pending") return;
        cur.record.state = "cancelled";
        cur.record.resolvedAt = Date.now();
        clearTimeout(cur.timer);
        this.pendings.delete(approvalId);
        cur.resolver({ approved: false, state: "cancelled", reason: "Turn cancelled while waiting for approval" });
      };
      pending.signalHandler = handler;
      if (params.signal.aborted) {
        handler();
      } else {
        params.signal.addEventListener("abort", handler, { once: true });
      }
    }

    return { approvalId, promise, record };
  }

  resolve(approvalId: string, decision: ApprovalDecision): ApprovalGateResult {
    const pending = this.pendings.get(approvalId);
    if (!pending) {
      const rec = this.records.get(approvalId);
      if (!rec) {
        throw new Error(`Approval ${approvalId} not found`);
      }
      if (rec.state !== "pending") {
        return { approved: false, state: rec.state, decision: rec.decision, reason: `Already ${rec.state}` };
      }
      throw new Error(`Approval ${approvalId} not pending`);
    }
    const rec = pending.record;
    if (rec.state !== "pending") {
      return { approved: false, state: rec.state, decision: rec.decision, reason: `Already ${rec.state}` };
    }
    clearTimeout(pending.timer);
    rec.resolvedAt = Date.now();
    if (decision === "deny") {
      rec.state = "rejected";
      rec.decision = decision;
      this.pendings.delete(approvalId);
      pending.resolver({ approved: false, state: "rejected", decision, reason: "User denied" });
      return { approved: false, state: "rejected", decision };
    }
    rec.state = "approved";
    rec.decision = decision;
    this.pendings.delete(approvalId);
    pending.resolver({ approved: true, state: "approved", decision });
    return { approved: true, state: "approved", decision };
  }

  cancelForTurn(turnId: string, reason = "Turn cancelled"): void {
    for (const [id, pending] of Array.from(this.pendings.entries())) {
      if (pending.record.turnId !== turnId) continue;
      if (pending.record.state !== "pending") continue;
      clearTimeout(pending.timer);
      pending.record.state = "cancelled";
      pending.record.resolvedAt = Date.now();
      this.pendings.delete(id);
      pending.resolver({ approved: false, state: "cancelled", reason });
    }
  }

  cancelAll(reason = "Workspace closed"): void {
    for (const [id, pending] of Array.from(this.pendings.entries())) {
      if (pending.record.state !== "pending") continue;
      clearTimeout(pending.timer);
      pending.record.state = "cancelled";
      pending.record.resolvedAt = Date.now();
      this.pendings.delete(id);
      pending.resolver({ approved: false, state: "cancelled", reason });
    }
  }

  expireNow(approvalId: string): void {
    const pending = this.pendings.get(approvalId);
    if (!pending || pending.record.state !== "pending") return;
    clearTimeout(pending.timer);
    pending.record.state = "expired";
    pending.record.resolvedAt = Date.now();
    this.pendings.delete(approvalId);
    pending.resolver({ approved: false, state: "expired", reason: "Expired by test" });
  }

  getRecord(approvalId: string): ApprovalRecord | undefined {
    return this.records.get(approvalId);
  }

  getPending(approvalId: string): ApprovalRecord | undefined {
    const p = this.pendings.get(approvalId);
    return p?.record;
  }

  getAllPending(): ApprovalRecord[] {
    return Array.from(this.pendings.values()).map((p) => p.record);
  }

  getAllPendingForTurn(turnId: string): ApprovalRecord[] {
    return Array.from(this.pendings.values())
      .filter((p) => p.record.turnId === turnId)
      .map((p) => p.record);
  }

  hasPending(): boolean {
    return this.pendings.size > 0;
  }
}

export function createApprovalService(options?: ApprovalServiceOptions): ApprovalService {
  return new ApprovalService(options);
}
