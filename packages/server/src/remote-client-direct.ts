import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { EightBitRouteHealthAuthority } from "@codeforge/eight-bit";

const KILO_ENDPOINT = "https://api.kilo.ai/api/gateway/chat/completions";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function mac(secret: Buffer, kind: string, value: unknown): string {
  return createHmac("sha256", secret).update(`CodeForge remote direct v1:${kind}\n${canonical(value)}`).digest("base64url");
}

function matchesMac(secret: Buffer, kind: string, value: unknown, signature: string): boolean {
  const expected = Buffer.from(mac(secret, kind, value));
  const supplied = Buffer.from(signature);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export interface RemoteDirectSessionIdentity {
  accountId: string;
  deviceId: string;
  sessionId: string;
  workspaceId: string;
}

export interface RemoteDirectAssignment extends RemoteDirectSessionIdentity {
  version: 1;
  requestId: string;
  runId: string;
  routeId: string;
  quotaDomainId: string;
  provider: "kilo-free-direct";
  endpoint: typeof KILO_ENDPOINT;
  model: string;
  requestDigest: string;
  expiresAt: string;
  nonce: string;
}

export interface SignedRemoteDirectAssignment {
  assignment: RemoteDirectAssignment;
  mac: string;
}

export interface SignedRemoteDirectAcknowledgement {
  acknowledgement: { requestId: string; sessionId: string; nonce: string };
  mac: string;
}

export type RemoteDirectFrameKind = "content_delta" | "tool_call_delta" | "usage" | "provider_error" | "done" | "cancelled";

export interface RemoteDirectFrame {
  requestId: string;
  sequence: number;
  kind: RemoteDirectFrameKind;
  payload: unknown;
}

export interface SignedRemoteDirectFrame {
  frame: RemoteDirectFrame;
  mac: string;
}

export interface RemoteDirectFeedback {
  requestId: string;
  runId: string;
  routeId: string;
  quotaDomainId: string;
  provider: "kilo-free-direct";
  physicalModel: string;
  status: "success" | "rate_limited" | "provider_error" | "cancelled" | "client_offline";
  latencyMs: number;
  httpClass: 0 | 2 | 4 | 5;
  rateLimitResetAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCallCount: number;
  terminationReason: "completed" | "provider_rate_limit" | "provider_error" | "cancelled" | "client_offline";
  timestamp: string;
  accountId: string;
  deviceId: string;
  sessionId: string;
  workspaceId: string;
  nonce: string;
}

export interface SignedRemoteDirectFeedback {
  feedback: RemoteDirectFeedback;
  mac: string;
}

export function digestRemoteDirectRequest(request: unknown): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

function validKiloModel(model: string): boolean {
  return model === "kilo-auto/free" || /^[a-z0-9][a-z0-9._/-]{1,200}:free$/.test(model);
}

export class RemoteDirectDevice {
  private readonly nonces = new Set<string>();
  private readonly active = new Map<string, { assignment: RemoteDirectAssignment; abort: AbortController }>();

  constructor(
    readonly identity: RemoteDirectSessionIdentity,
    private readonly secret: Buffer,
    private readonly routeAllowed: (assignment: RemoteDirectAssignment) => boolean,
  ) {}

  accept(signed: SignedRemoteDirectAssignment, request: unknown, now = Date.now()): AbortSignal {
    const a = signed.assignment;
    if (!matchesMac(this.secret, "assignment", a, signed.mac)) throw new Error("REMOTE_ASSIGNMENT_MAC_INVALID");
    if (a.version !== 1 || Object.keys(this.identity).some((key) => a[key as keyof RemoteDirectSessionIdentity] !== this.identity[key as keyof RemoteDirectSessionIdentity])) {
      throw new Error("REMOTE_ASSIGNMENT_IDENTITY_MISMATCH");
    }
    if (a.provider !== "kilo-free-direct" || a.endpoint !== KILO_ENDPOINT || !validKiloModel(a.model)
      || !/^[a-f0-9]{64}$/.test(a.requestDigest) || a.requestDigest !== digestRemoteDirectRequest(request)
      || !Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt) <= now || Date.parse(a.expiresAt) > now + 120_000) {
      throw new Error("REMOTE_ASSIGNMENT_POLICY_DENIED");
    }
    if (this.nonces.has(a.nonce) || this.active.has(a.requestId)) throw new Error("REMOTE_ASSIGNMENT_REPLAY");
    if (!this.routeAllowed(a)) throw new Error("REMOTE_LOCAL_ROUTE_DENIED");
    this.nonces.add(a.nonce);
    const abort = new AbortController();
    this.active.set(a.requestId, { assignment: a, abort });
    return abort.signal;
  }

  signFrame(frame: RemoteDirectFrame): SignedRemoteDirectFrame {
    if (!this.active.has(frame.requestId)) throw new Error("REMOTE_REQUEST_NOT_ACTIVE");
    return { frame, mac: mac(this.secret, "frame", frame) };
  }

  acknowledge(requestId: string): SignedRemoteDirectAcknowledgement {
    const active = this.active.get(requestId);
    if (!active) throw new Error("REMOTE_REQUEST_NOT_ACTIVE");
    const acknowledgement = { requestId, sessionId: active.assignment.sessionId, nonce: active.assignment.nonce };
    return { acknowledgement, mac: mac(this.secret, "acknowledgement", acknowledgement) };
  }

  signFeedback(feedback: RemoteDirectFeedback): SignedRemoteDirectFeedback {
    const active = this.active.get(feedback.requestId);
    if (!active || !feedbackMatchesAssignment(feedback, active.assignment)) throw new Error("REMOTE_FEEDBACK_SCOPE_INVALID");
    this.active.delete(feedback.requestId);
    return { feedback, mac: mac(this.secret, "feedback", feedback) };
  }

  cancel(requestId: string): void {
    const active = this.active.get(requestId);
    active?.abort.abort();
  }
}

function feedbackMatchesAssignment(feedback: RemoteDirectFeedback, a: RemoteDirectAssignment): boolean {
  return feedback.requestId === a.requestId && feedback.runId === a.runId && feedback.routeId === a.routeId
    && feedback.quotaDomainId === a.quotaDomainId && feedback.provider === a.provider
    && feedback.accountId === a.accountId && feedback.deviceId === a.deviceId
    && feedback.sessionId === a.sessionId && feedback.workspaceId === a.workspaceId && feedback.nonce === a.nonce;
}

const FEEDBACK_FIELDS = new Set([
  "requestId", "runId", "routeId", "quotaDomainId", "provider", "physicalModel", "status", "latencyMs",
  "httpClass", "rateLimitResetAt", "inputTokens", "outputTokens", "toolCallCount", "terminationReason",
  "timestamp", "accountId", "deviceId", "sessionId", "workspaceId", "nonce",
]);

function validFeedback(feedback: RemoteDirectFeedback): boolean {
  if (Object.keys(feedback).some((field) => !FEEDBACK_FIELDS.has(field))) return false;
  if (!/^[a-z0-9][a-z0-9._/-]{0,255}$/i.test(feedback.physicalModel)) return false;
  if (!Number.isFinite(feedback.latencyMs) || feedback.latencyMs < 0 || feedback.latencyMs > 3_600_000) return false;
  if (!Number.isInteger(feedback.toolCallCount) || feedback.toolCallCount < 0 || feedback.toolCallCount > 10_000) return false;
  if (![0, 2, 4, 5].includes(feedback.httpClass)) return false;
  for (const count of [feedback.inputTokens, feedback.outputTokens]) {
    if (count !== undefined && (!Number.isInteger(count) || count < 0 || count > 1_000_000_000)) return false;
  }
  if (feedback.rateLimitResetAt !== undefined && !Number.isFinite(Date.parse(feedback.rateLimitResetAt))) return false;
  return (feedback.status === "rate_limited" && feedback.httpClass === 4 && feedback.terminationReason === "provider_rate_limit")
    || (feedback.status === "success" && feedback.httpClass === 2 && feedback.terminationReason === "completed")
    || (feedback.status === "provider_error" && [4, 5].includes(feedback.httpClass) && feedback.terminationReason === "provider_error")
    || (feedback.status === "cancelled" && feedback.httpClass === 0 && feedback.terminationReason === "cancelled")
    || (feedback.status === "client_offline" && feedback.httpClass === 0 && feedback.terminationReason === "client_offline");
}

export class RemoteDirectAuthority {
  private readonly sessions = new Map<string, { identity: RemoteDirectSessionIdentity; secret: Buffer }>();
  private readonly pending = new Map<string, { assignment: RemoteDirectAssignment; secret: Buffer; nextSequence: number; acknowledged: boolean }>();
  private readonly settled = new Set<string>();

  registerSession(identity: RemoteDirectSessionIdentity, secret: Buffer): void {
    if (secret.length < 32) throw new Error("REMOTE_SESSION_SECRET_TOO_SHORT");
    if (this.sessions.has(identity.sessionId) || Object.values(identity).some((value) => !value || value.length > 256)) {
      throw new Error("REMOTE_SESSION_IDENTITY_INVALID");
    }
    this.sessions.set(identity.sessionId, { identity, secret });
  }

  revokeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [requestId, pending] of this.pending) {
      if (pending.assignment.sessionId === sessionId) this.expire(requestId);
    }
  }

  issue(sessionId: string, input: {
    runId: string; routeId: string; quotaDomainId: string; model: string; request: unknown;
  }, now = Date.now()): SignedRemoteDirectAssignment {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("REMOTE_SESSION_UNKNOWN");
    if (!validKiloModel(input.model)) throw new Error("REMOTE_MODEL_DENIED");
    if ([input.runId, input.routeId, input.quotaDomainId].some((value) => !value || value.length > 256)) {
      throw new Error("REMOTE_ASSIGNMENT_SCOPE_INVALID");
    }
    const assignment: RemoteDirectAssignment = {
      ...session.identity,
      version: 1,
      requestId: randomUUID(), runId: input.runId, routeId: input.routeId, quotaDomainId: input.quotaDomainId,
      provider: "kilo-free-direct", endpoint: KILO_ENDPOINT, model: input.model,
      requestDigest: digestRemoteDirectRequest(input.request),
      expiresAt: new Date(now + 120_000).toISOString(), nonce: randomUUID(),
    };
    this.pending.set(assignment.requestId, { assignment, secret: session.secret, nextSequence: 0, acknowledged: false });
    return { assignment, mac: mac(session.secret, "assignment", assignment) };
  }

  acceptAcknowledgement(signed: SignedRemoteDirectAcknowledgement, now = Date.now()): void {
    const { acknowledgement } = signed;
    const pending = this.pending.get(acknowledgement.requestId);
    if (!pending || pending.acknowledged || !this.sessions.has(pending.assignment.sessionId)
      || Date.parse(pending.assignment.expiresAt) <= now
      || acknowledgement.sessionId !== pending.assignment.sessionId
      || acknowledgement.nonce !== pending.assignment.nonce
      || !matchesMac(pending.secret, "acknowledgement", acknowledgement, signed.mac)) {
      throw new Error("REMOTE_ACKNOWLEDGEMENT_INVALID");
    }
    pending.acknowledged = true;
  }

  acceptFrame(signed: SignedRemoteDirectFrame, now = Date.now()): RemoteDirectFrame {
    const pending = this.pending.get(signed.frame.requestId);
    if (!pending || !pending.acknowledged || !this.sessions.has(pending.assignment.sessionId)
      || Date.parse(pending.assignment.expiresAt) <= now
      || !matchesMac(pending.secret, "frame", signed.frame, signed.mac)
      || signed.frame.sequence !== pending.nextSequence) throw new Error("REMOTE_FRAME_INVALID");
    pending.nextSequence++;
    return signed.frame;
  }

  acceptFeedback(signed: SignedRemoteDirectFeedback, now = Date.now()): RemoteDirectFeedback {
    const feedback = signed.feedback;
    const pending = this.pending.get(feedback.requestId);
    if (!pending || !pending.acknowledged || !this.sessions.has(pending.assignment.sessionId)
      || Date.parse(pending.assignment.expiresAt) <= now
      || this.settled.has(feedback.requestId)) throw new Error("REMOTE_FEEDBACK_REPLAY");
    if (!matchesMac(pending.secret, "feedback", feedback, signed.mac)
      || !feedbackMatchesAssignment(feedback, pending.assignment)
      || Math.abs(Date.parse(feedback.timestamp) - now) > 120_000
      || !validFeedback(feedback)) {
      throw new Error("REMOTE_FEEDBACK_INVALID");
    }
    this.pending.delete(feedback.requestId);
    this.settled.add(feedback.requestId);
    return feedback;
  }

  acceptAndObserveFeedback(signed: SignedRemoteDirectFeedback, health: EightBitRouteHealthAuthority, now = Date.now()): RemoteDirectFeedback {
    const assignment = this.pending.get(signed.feedback.requestId)?.assignment;
    const feedback = this.acceptFeedback(signed, now);
    if (!assignment || feedback.status === "cancelled") return feedback;
    const base = {
      providerId: feedback.provider, modelId: assignment.model, quotaDomainId: feedback.quotaDomainId,
      observedAt: feedback.timestamp, source: "runtime" as const, correlationId: feedback.runId,
    };
    if (feedback.status === "success") {
      health.observe({ ...base, kind: "call_success", latencyMs: feedback.latencyMs,
        ...(feedback.inputTokens !== undefined ? { inputTokens: feedback.inputTokens } : {}),
        ...(feedback.outputTokens !== undefined ? { outputTokens: feedback.outputTokens } : {}) });
    } else {
      const retryAfterMs = feedback.rateLimitResetAt
        ? Math.max(0, Date.parse(feedback.rateLimitResetAt) - now) : undefined;
      health.observe({ ...base, kind: "call_failure",
        reason: feedback.status === "rate_limited" ? "RATE_LIMITED" : feedback.status === "client_offline" ? "TRANSIENT_NETWORK" : "PROVIDER_OUTAGE",
        status: feedback.status === "rate_limited" ? 429 : feedback.httpClass === 5 ? 503 : undefined,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    return feedback;
  }

  expire(requestId: string): RemoteDirectAssignment | undefined {
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (pending) this.settled.add(requestId);
    return pending?.assignment;
  }
}
