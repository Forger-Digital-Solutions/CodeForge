import { randomBytes, randomUUID } from "node:crypto";
import type { ISessionPersistence, SessionPersistenceTx, WorkItem } from "@codeforge/sessions";
import { ChatRequestSchema, ChatResponseSchema, type ChatRequest, type ChatResponse } from "@codeforge/providers";
import {
  RemoteDirectAuthority, digestRemoteDirectRequest, signRemoteDirectAssignment, type RemoteDirectAssignment,
  type RemoteDirectSessionIdentity, type SignedRemoteDirectAcknowledgement,
  type SignedRemoteDirectAssignment, type SignedRemoteDirectFeedback, type SignedRemoteDirectResult,
} from "./remote-client-direct.js";

type Session = Extract<WorkItem, { kind: "remote_direct_session" }>;
type Job = Extract<WorkItem, { kind: "remote_direct_job" }>;
export interface RemoteDirectPrincipal { accountId: string; authSessionId: string }
export interface RemoteDirectBinding {
  accountId: string; deviceId: string; workspaceId: string;
  runId: string; routeId: string; quotaDomainId: string;
  role?: string;
}
export interface RemoteDirectEnvelope {
  encrypt(value: string | Buffer, context: { purpose: string; tenantId: string; recordId: string }): string;
  decrypt(value: string, context: { purpose: string; tenantId: string; recordId: string }): Buffer;
}
export interface RemoteDirectTransportOptions {
  persistence: ISessionPersistence;
  envelope: RemoteDirectEnvelope;
  admit: (binding: RemoteDirectBinding, request: ChatRequest) => boolean | Promise<boolean>;
  sessionActive?: (principal: RemoteDirectPrincipal) => boolean | Promise<boolean>;
  authorizeSessionScope?: (principal: RemoteDirectPrincipal, scope: { deviceId: string; workspaceId: string }) => boolean | Promise<boolean>;
  now?: () => number;
  leaseMs?: number;
  sessionMs?: number;
  maxAttempts?: number;
}

export class RemoteDirectTransport {
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly sessionMs: number;
  private readonly maxAttempts: number;
  constructor(private readonly options: RemoteDirectTransportOptions) {
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.sessionMs = options.sessionMs ?? 900_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    if (this.leaseMs < 10 || this.leaseMs > 120_000 || this.sessionMs <= this.leaseMs || this.sessionMs > 3_600_000
      || !Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 10) throw new Error("REMOTE_CONFIGURATION_INVALID");
  }

  async bootstrap(principal: RemoteDirectPrincipal, scope: { deviceId: string; workspaceId: string }): Promise<{
    identity: RemoteDirectSessionIdentity; secret: string; expiresAt: string;
  }> {
    for (const field of [principal.accountId, principal.authSessionId, scope.deviceId, scope.workspaceId]) {
      if (!field || field.length > 256 || field === "*" || field.includes("\u0000")) throw new Error("REMOTE_SESSION_SCOPE_INVALID");
    }
    if (this.options.sessionActive && !(await this.options.sessionActive(principal))) throw new Error("REMOTE_SESSION_UNAUTHORIZED");
    if (this.options.authorizeSessionScope && !(await this.options.authorizeSessionScope(principal, scope))) throw new Error("REMOTE_SESSION_SCOPE_UNAUTHORIZED");
    const id = `remote-session-${randomUUID()}`;
    const key = randomBytes(32);
    const record: Session = { kind: "remote_direct_session", id, ownerUserId: principal.accountId,
      ...scope, authSessionId: principal.authSessionId, secretEnvelope: this.options.envelope.encrypt(key, this.secretContext(id, principal.accountId)),
      expiresAt: new Date(this.now() + this.sessionMs).toISOString(), heartbeatAt: new Date(this.now()).toISOString(), revoked: false };
    await this.options.persistence.insertIfAbsent(record);
    return { identity: this.identity(record), secret: key.toString("base64url"), expiresAt: record.expiresAt };
  }

  async enqueue(binding: RemoteDirectBinding, input: ChatRequest, idempotencyKey: string): Promise<string> {
    const request = ChatRequestSchema.parse(input);
    for (const field of [...Object.values(binding), idempotencyKey]) {
      if (!field || field.length > 256 || field === "*") throw new Error("REMOTE_ASSIGNMENT_SCOPE_INVALID");
    }
    if (!(await this.options.admit(binding, request))) throw new Error("REMOTE_DOMAIN_ADMISSION_DENIED");
    const id = `remote-job-${digestRemoteDirectRequest([binding.accountId, idempotencyKey])}`;
    const requestDigest = digestRemoteDirectRequest({ binding, request });
    const record: Job = { kind: "remote_direct_job", id, ownerUserId: binding.accountId,
      deviceId: binding.deviceId, workspaceId: binding.workspaceId, runId: binding.runId, routeId: binding.routeId,
      quotaDomainId: binding.quotaDomainId, request, requestDigest, state: "queued", attempts: 0,
      role: binding.role,
      createdAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString() };
    const inserted = await this.options.persistence.insertIfAbsent(record);
    if (!inserted) {
      const prior = await this.options.persistence.getWorkItem(id);
      if (prior?.kind !== "remote_direct_job" || prior.requestDigest !== requestDigest) throw new Error("REMOTE_IDEMPOTENCY_CONFLICT");
    }
    return id;
  }

  async poll(principal: RemoteDirectPrincipal, sessionId: string): Promise<Array<{ jobId: string; signed: SignedRemoteDirectAssignment; request: ChatRequest }>> {
    await this.options.persistence.withTransaction(async (tx) => { await this.session(tx, principal, sessionId); });
    await this.recover();
    const deliveries: Array<{ jobId: string; signed: SignedRemoteDirectAssignment; request: ChatRequest }> = [];
    const candidates = await this.options.persistence.getWorkItemsByKind("remote_direct_job");
    for (const candidate of candidates) {
      if (deliveries.length >= 8) break;
      if (candidate.kind !== "remote_direct_job" || !["queued", "delivered"].includes(candidate.state)) continue;
      const delivery = await this.options.persistence.withTransaction(async (tx) => {
        const session = await this.session(tx, principal, sessionId);
        await tx.lockWorkItem(candidate.id);
        const job = await this.job(tx, candidate.id, principal.accountId);
        if (job.deviceId !== session.deviceId || job.workspaceId !== session.workspaceId) return;
        if (job.state === "delivered") {
          const assignment = job.assignment as unknown as RemoteDirectAssignment;
          if (assignment.sessionId !== session.id) return;
          const authority = new RemoteDirectAuthority();
          authority.restorePending(assignment, this.key(session), false);
          return { jobId: job.id, signed: this.signExisting(assignment, session), request: ChatRequestSchema.parse(job.request) };
        }
        if (job.state !== "queued") return;
        const request = ChatRequestSchema.parse(job.request);
        if (!(await this.options.admit(this.binding(job), request))) {
          await tx.upsertWorkItem({ ...job, state: "blocked", updatedAt: new Date(this.now()).toISOString() });
          return;
        }
        const authority = new RemoteDirectAuthority();
        authority.registerSession(this.identity(session), this.key(session));
        const signed = authority.issue(session.id, { runId: job.runId, routeId: job.routeId, quotaDomainId: job.quotaDomainId, model: request.model, request }, this.now());
        await tx.upsertWorkItem({ ...job, state: "delivered", attempts: job.attempts + 1,
          assignment: signed.assignment as unknown as Record<string, unknown>, leaseExpiresAt: new Date(this.now() + this.leaseMs).toISOString(),
          updatedAt: new Date(this.now()).toISOString() });
        return { jobId: job.id, signed, request };
      });
      if (delivery) deliveries.push(delivery);
    }
    return deliveries;
  }

  async acknowledge(principal: RemoteDirectPrincipal, sessionId: string, jobId: string, signed: SignedRemoteDirectAcknowledgement): Promise<void> {
    await this.mutate(principal, sessionId, jobId, async (tx, job, authority) => {
      if (job.state !== "delivered") throw new Error("REMOTE_ACKNOWLEDGEMENT_INVALID");
      authority.acceptAcknowledgement(signed, this.now());
      await tx.upsertWorkItem({ ...job, state: "acknowledged", updatedAt: new Date(this.now()).toISOString() });
    });
  }

  async heartbeat(principal: RemoteDirectPrincipal, sessionId: string): Promise<{ cancelledJobIds: string[] }> {
    await this.recover();
    return this.options.persistence.withTransaction(async (tx) => {
      const session = await this.session(tx, principal, sessionId);
      await tx.upsertWorkItem({ ...session, heartbeatAt: new Date(this.now()).toISOString() });
      const cancelledJobIds: string[] = [];
      for (const candidate of await tx.getWorkItemsByKind("remote_direct_job")) {
        if (candidate.kind !== "remote_direct_job" || candidate.assignment?.sessionId !== sessionId) continue;
        await tx.lockWorkItem(candidate.id);
        const job = await this.job(tx, candidate.id, principal.accountId);
        if (["cancelled", "blocked", "queued"].includes(job.state)) cancelledJobIds.push(job.id);
        else if (["acknowledged", "result"].includes(job.state)) {
          await tx.upsertWorkItem({ ...job, leaseExpiresAt: new Date(Math.min(this.now() + this.leaseMs, Date.parse(String(job.assignment?.expiresAt)))).toISOString() });
        }
      }
      return { cancelledJobIds };
    });
  }

  async result(principal: RemoteDirectPrincipal, sessionId: string, jobId: string, signed: SignedRemoteDirectResult): Promise<void> {
    await this.mutate(principal, sessionId, jobId, async (tx, job, authority) => {
      if (job.state !== "acknowledged") throw new Error("REMOTE_RESULT_REPLAY");
      const result = authority.acceptResult(signed, this.now());
      await tx.upsertWorkItem({ ...job, state: "result", response: result.response, updatedAt: new Date(this.now()).toISOString() });
    });
  }

  async feedback(principal: RemoteDirectPrincipal, sessionId: string, jobId: string, signed: SignedRemoteDirectFeedback): Promise<void> {
    await this.mutate(principal, sessionId, jobId, async (tx, job, authority) => {
      if (job.state !== "result") throw new Error("REMOTE_FEEDBACK_REPLAY");
      const feedback = authority.acceptFeedback(signed, this.now());
      const response = ChatResponseSchema.parse(job.response);
      if (feedback.status === "success" && response.choices.some((choice) => choice.finishReason === "error")) throw new Error("REMOTE_FEEDBACK_RESULT_MISMATCH");
      const toolCount = response.choices.reduce((count, choice) => count + (choice.message.toolCalls?.length ?? 0), 0);
      if (feedback.physicalModel !== response.model || feedback.toolCallCount !== toolCount
        || (response.usage && (feedback.inputTokens !== response.usage.inputTokens || feedback.outputTokens !== response.usage.outputTokens))) {
        throw new Error("REMOTE_FEEDBACK_ACCOUNTING_MISMATCH");
      }
      await tx.upsertWorkItem({ ...job, state: "settled", feedback: feedback as unknown as Record<string, unknown>, updatedAt: new Date(this.now()).toISOString() });
    });
  }

  async cancel(accountId: string, jobId: string): Promise<void> {
    await this.options.persistence.withTransaction(async (tx) => {
      await tx.lockWorkItem(jobId);
      const job = await this.job(tx, jobId, accountId);
      if (["settled", "blocked", "cancelled"].includes(job.state)) return;
      await tx.upsertWorkItem({ ...job, state: "cancelled", updatedAt: new Date(this.now()).toISOString() });
    });
  }

  async revoke(principal: RemoteDirectPrincipal, sessionId: string): Promise<void> {
    await this.options.persistence.withTransaction(async (tx) => {
      const session = await this.session(tx, principal, sessionId);
      await tx.upsertWorkItem({ ...session, revoked: true });
    });
    await this.recover();
  }

  async recover(): Promise<void> {
    for (const candidate of await this.options.persistence.getWorkItemsByKind("remote_direct_job")) {
      if (candidate.kind !== "remote_direct_job") continue;
      if (candidate.state === "queued" && Date.parse(candidate.createdAt) + 600_000 <= this.now()) {
        await this.options.persistence.withTransaction(async (tx) => {
          await tx.lockWorkItem(candidate.id);
          const job = await this.job(tx, candidate.id, candidate.ownerUserId);
          if (job.state === "queued") await tx.upsertWorkItem({ ...job, state: "blocked", recoveryReason: "DELIVERY_TIMEOUT", updatedAt: new Date(this.now()).toISOString() });
        });
        continue;
      }
      if (!["delivered", "acknowledged", "result"].includes(candidate.state)) continue;
      await this.options.persistence.withTransaction(async (tx) => {
        // Session precedes job in every lock order, including recovery, to avoid Postgres deadlocks.
        const sessionId = String(candidate.assignment?.sessionId ?? "");
        if (sessionId) await tx.lockWorkItem(sessionId);
        await tx.lockWorkItem(candidate.id);
        const job = await this.job(tx, candidate.id, candidate.ownerUserId);
        if (!["delivered", "acknowledged", "result"].includes(job.state)) return;
        const session = await tx.getWorkItem(sessionId);
        const identityActive = session?.kind === "remote_direct_session" && (!this.options.sessionActive
          || await this.options.sessionActive({ accountId: session.ownerUserId, authSessionId: session.authSessionId }));
        if (session?.kind === "remote_direct_session" && !session.revoked && Date.parse(session.expiresAt) > this.now()
          && identityActive
          && Date.parse(job.leaseExpiresAt ?? "") > this.now() && Date.parse(String(job.assignment?.expiresAt)) > this.now()) return;
        const recoveryReason: Job["recoveryReason"] = session?.kind !== "remote_direct_session" || session.revoked ? "SESSION_REVOKED"
          : !identityActive ? "IDENTITY_REVOKED" : Date.parse(session.expiresAt) <= this.now() ? "SESSION_EXPIRED"
          : Date.parse(String(job.assignment?.expiresAt)) <= this.now() ? "ASSIGNMENT_EXPIRED"
          : job.state === "delivered" ? "DELIVERY_TIMEOUT" : "MISSED_HEARTBEAT";
        await tx.upsertWorkItem({ ...job, state: job.attempts >= this.maxAttempts ? "blocked" : "queued", recoveryReason, response: undefined, feedback: undefined,
          updatedAt: new Date(this.now()).toISOString() });
      });
    }
  }

  async status(accountId: string, jobId: string): Promise<{ state: Job["state"]; response?: ChatResponse; feedback?: Record<string, unknown> }> {
    await this.recover();
    const job = await this.job(this.options.persistence, jobId, accountId);
    return { state: job.state, ...(job.state === "settled" ? { response: ChatResponseSchema.parse(job.response), feedback: job.feedback } : {}) };
  }

  private async mutate(principal: RemoteDirectPrincipal, sessionId: string, jobId: string,
    operation: (tx: SessionPersistenceTx, job: Job, authority: RemoteDirectAuthority) => Promise<void>): Promise<void> {
    await this.options.persistence.withTransaction(async (tx) => {
      const session = await this.session(tx, principal, sessionId);
      await tx.lockWorkItem(jobId);
      const job = await this.job(tx, jobId, principal.accountId);
      const assignment = job.assignment as unknown as RemoteDirectAssignment | undefined;
      if (!assignment || assignment.sessionId !== sessionId || assignment.deviceId !== session.deviceId || assignment.workspaceId !== session.workspaceId
        || Date.parse(job.leaseExpiresAt ?? "") <= this.now() || ["cancelled", "blocked", "queued", "settled"].includes(job.state)) throw new Error("REMOTE_ASSIGNMENT_STALE");
      const authority = new RemoteDirectAuthority();
      authority.restorePending(assignment, this.key(session), ["acknowledged", "result"].includes(job.state));
      await operation(tx, job, authority);
    });
  }
  private async session(tx: SessionPersistenceTx, principal: RemoteDirectPrincipal, id: string): Promise<Session> {
    await tx.lockWorkItem(id);
    const session = await tx.getWorkItem(id);
    if (session?.kind !== "remote_direct_session" || session.ownerUserId !== principal.accountId || session.authSessionId !== principal.authSessionId
      || session.revoked || Date.parse(session.expiresAt) <= this.now()
      || (this.options.sessionActive && !(await this.options.sessionActive(principal)))) throw new Error("REMOTE_SESSION_UNAUTHORIZED");
    return session;
  }
  private async job(tx: SessionPersistenceTx, id: string, accountId: string): Promise<Job> {
    const job = await tx.getWorkItem(id);
    if (job?.kind !== "remote_direct_job" || job.ownerUserId !== accountId) throw new Error("REMOTE_JOB_UNAUTHORIZED");
    return job;
  }
  private identity(session: Session): RemoteDirectSessionIdentity {
    return { accountId: session.ownerUserId, sessionId: session.id, deviceId: session.deviceId, workspaceId: session.workspaceId };
  }
  private binding(job: Job): RemoteDirectBinding {
    return { accountId: job.ownerUserId, deviceId: job.deviceId, workspaceId: job.workspaceId, runId: job.runId, routeId: job.routeId, quotaDomainId: job.quotaDomainId, role: job.role };
  }
  private secretContext(recordId: string, tenantId: string) { return { purpose: "remote_direct_mac", tenantId, recordId }; }
  private key(session: Session): Buffer { return this.options.envelope.decrypt(session.secretEnvelope, this.secretContext(session.id, session.ownerUserId)); }
  private signExisting(assignment: RemoteDirectAssignment, session: Session): SignedRemoteDirectAssignment {
    return { assignment, mac: signRemoteDirectAssignment(this.key(session), assignment) };
  }
}
