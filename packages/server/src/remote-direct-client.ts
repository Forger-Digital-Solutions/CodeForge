import { ChatRequestSchema, ChatResponseSchema, createKiloFreeDirectAdapter, type ChatResponse } from "@codeforge/providers";
import { RemoteDirectDevice, type RemoteDirectAssignment, type RemoteDirectFeedback, type RemoteDirectSessionIdentity, type SignedRemoteDirectAssignment } from "./remote-client-direct.js";

export interface RemoteDirectClientOptions {
  cloudUrl: string;
  getAccessToken: () => Promise<string | undefined> | string | undefined;
  deviceId: string;
  workspaceId: string;
  routeAllowed: (assignment: RemoteDirectAssignment) => boolean;
  cloudFetch?: typeof fetch;
  providerFetch?: typeof fetch;
  heartbeatMs?: number;
}

export class RemoteDirectHttpClient {
  private device?: RemoteDirectDevice;
  private identity?: RemoteDirectSessionIdentity;
  private readonly active = new Map<string, string>();
  private lastHeartbeatAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly options: RemoteDirectClientOptions) {
    const url = new URL(options.cloudUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
      throw new Error("REMOTE_CLOUD_URL_DENIED");
    }
  }
  async connect(): Promise<void> {
    if (this.identity) await this.disconnect().catch(() => { this.identity = undefined; this.device = undefined; });
    const session = await this.post("/v1/remote-direct/sessions", { deviceId: this.options.deviceId, workspaceId: this.options.workspaceId }) as {
      identity: RemoteDirectSessionIdentity; secret: string; expiresAt: string;
    };
    if (!session.identity || session.identity.deviceId !== this.options.deviceId || session.identity.workspaceId !== this.options.workspaceId
      || !/^[A-Za-z0-9_-]{43}$/.test(session.secret) || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new Error("REMOTE_BOOTSTRAP_INVALID");
    this.identity = session.identity;
    this.device = new RemoteDirectDevice(session.identity, Buffer.from(session.secret, "base64url"), this.options.routeAllowed);
  }
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    const stopActive = () => { for (const requestId of this.active.values()) this.device?.cancel(requestId); };
    signal.addEventListener("abort", stopActive, { once: true });
    try {
      while (!signal.aborted) {
        try {
          if (!this.identity) await this.connect();
          await this.tick();
          if (Date.now() - this.lastHeartbeatAt >= (this.options.heartbeatMs ?? 5_000)) await this.heartbeat();
          failures = 0;
        } catch (error) {
          for (const requestId of this.active.values()) this.device?.cancel(requestId);
          await this.disconnect().catch(() => { this.identity = undefined; this.device = undefined; });
          if (++failures >= 5 || (error instanceof Error && ["REMOTE_AUTHORIZATION_REQUIRED", "REMOTE_LOCAL_ROUTE_DENIED", "REMOTE_ASSIGNMENT_POLICY_DENIED", "REMOTE_ASSIGNMENT_MAC_INVALID"].includes(error.message))) throw error;
        }
        if (!signal.aborted) await new Promise<void>((resolve) => {
          const timer = setTimeout(done, Math.min(10_000, 1_000 * (failures + 1)));
          function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
          signal.addEventListener("abort", done, { once: true });
        });
      }
    } finally { signal.removeEventListener("abort", stopActive); await this.disconnect().catch(() => undefined); }
  }
  async tick(): Promise<number> {
    if (!this.device || !this.identity) throw new Error("REMOTE_CLIENT_NOT_CONNECTED");
    const deliveries = await this.post(`${this.sessionPath()}/poll`, {}) as Array<{ jobId: string; signed: SignedRemoteDirectAssignment; request: unknown }>;
    await Promise.all(deliveries.map(async (delivery) => {
      if (this.active.has(delivery.jobId)) return;
      const request = ChatRequestSchema.parse(delivery.request);
      const signal = this.device!.accept(delivery.signed, request);
      const assignment = delivery.signed.assignment;
      this.active.set(delivery.jobId, assignment.requestId);
      const prefix = `${this.sessionPath()}/jobs/${encodeURIComponent(delivery.jobId)}`;
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        await this.post(`${prefix}/ack`, this.device!.acknowledge(assignment.requestId));
        let heartbeatRunning = false;
        timer = setInterval(() => {
          if (heartbeatRunning) return;
          heartbeatRunning = true;
          void this.heartbeat().catch(() => this.device!.cancel(assignment.requestId)).finally(() => { heartbeatRunning = false; });
        }, this.options.heartbeatMs ?? 5_000);
        const startedAt = Date.now();
        const response: ChatResponse = { id: assignment.requestId, model: request.model,
          choices: [{ index: 0, message: { role: "assistant", content: "", toolCalls: [] }, finishReason: "stop" }] };
        let failure: { status: RemoteDirectFeedback["status"]; httpClass: RemoteDirectFeedback["httpClass"]; terminationReason: RemoteDirectFeedback["terminationReason"]; resetAt?: string; providerErrorCode?: string; httpStatus?: number } | undefined;
        const pending = new Map<string, { id: string; type: "function"; function: { name: string; arguments: string } }>();
        // This factory is anonymous and fixes the upstream URL; no environment credentials enter the device path.
        const provider = createKiloFreeDirectAdapter({ fetchFn: this.options.providerFetch, timeoutMs: 110_000 });
        for await (const event of provider.streamChat(request, signal)) {
          const choice = response.choices[0]!;
          if (event.type === "text_delta") choice.message.content += event.delta;
          else if (event.type === "tool_call_started") pending.set(event.toolCallId, { id: event.toolCallId, type: "function", function: { name: event.toolName, arguments: "" } });
          else if (event.type === "tool_call_delta") { const call = pending.get(event.toolCallId); if (call) call.function.arguments += event.delta; }
          else if (event.type === "tool_call_completed") {
            const call = pending.get(event.toolCallId) ?? { id: event.toolCallId, type: "function", function: { name: event.toolName, arguments: event.arguments } };
            call.function.arguments = event.arguments;
            choice.message.toolCalls!.push(call);
            pending.delete(event.toolCallId);
          } else if (event.type === "usage") response.usage = event.usage;
          else if (event.type === "finish") { choice.finishReason = event.finishReason; if (event.model) response.model = event.model; }
          else if (event.type === "error") {
            const limited = event.status === 429 || event.code === "PROVIDER_RATE_LIMITED";
            failure = { status: limited ? "rate_limited" : "provider_error", httpClass: limited || (event.status ?? 500) < 500 ? 4 : 5,
              terminationReason: limited ? "provider_rate_limit" : "provider_error", ...(event.retryAfter ? { resetAt: new Date(event.retryAfter).toISOString() } : {}),
              ...(/^[A-Z][A-Z0-9_]{0,127}$/.test(event.code) ? { providerErrorCode: event.code } : {}), ...(event.status ? { httpStatus: event.status } : {}) };
            choice.finishReason = "error";
          }
        }
        if (signal.aborted) return;
        ChatResponseSchema.parse(response);
        await this.post(`${prefix}/result`, this.device!.signResult({ requestId: assignment.requestId, nonce: assignment.nonce, response, toolExecutionState: "PROPOSED_ONLY" }));
        const feedback: RemoteDirectFeedback = {
          ...this.identity!, requestId: assignment.requestId, runId: assignment.runId, routeId: assignment.routeId, quotaDomainId: assignment.quotaDomainId,
          provider: "kilo-free-direct", physicalModel: response.model, status: failure?.status ?? "success", latencyMs: Date.now() - startedAt,
          httpClass: failure?.httpClass ?? 2, toolCallCount: response.choices[0]!.message.toolCalls?.length ?? 0,
          terminationReason: failure?.terminationReason ?? "completed", timestamp: new Date().toISOString(), nonce: assignment.nonce,
          ...(response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : {}),
          ...(failure?.resetAt ? { rateLimitResetAt: failure.resetAt } : {}),
          ...(failure?.providerErrorCode ? { providerErrorCode: failure.providerErrorCode } : {}), ...(failure?.httpStatus ? { httpStatus: failure.httpStatus } : {}),
        };
        await this.post(`${prefix}/feedback`, this.device!.signFeedback(feedback));
      } finally { if (timer) clearInterval(timer); this.active.delete(delivery.jobId); }
    }));
    return deliveries.length;
  }
  async heartbeat(): Promise<void> {
    const receipt = await this.post(`${this.sessionPath()}/heartbeat`, {}) as { cancelledJobIds: string[] };
    this.lastHeartbeatAt = Date.now();
    for (const id of receipt.cancelledJobIds) { const requestId = this.active.get(id); if (requestId) this.device?.cancel(requestId); }
  }
  async disconnect(): Promise<void> {
    for (const requestId of this.active.values()) this.device?.cancel(requestId);
    if (this.identity) await this.post(`${this.sessionPath()}/revoke`, {});
    this.identity = undefined;
    this.device = undefined;
  }
  private sessionPath(): string {
    if (!this.identity) throw new Error("REMOTE_CLIENT_NOT_CONNECTED");
    return `/v1/remote-direct/sessions/${encodeURIComponent(this.identity.sessionId)}`;
  }
  private async post(path: string, body: unknown): Promise<unknown> {
    const token = await this.options.getAccessToken();
    if (!token) throw new Error("REMOTE_AUTHORIZATION_REQUIRED");
    const response = await (this.options.cloudFetch ?? fetch)(`${this.options.cloudUrl.replace(/\/$/, "")}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`REMOTE_TRANSPORT_HTTP_${response.status}`);
    return response.json();
  }
}
