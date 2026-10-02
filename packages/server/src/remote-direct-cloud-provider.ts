import { randomUUID } from "node:crypto";
import { ChatResponseSchema, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderExecutionContext, type StreamEvent } from "@codeforge/providers";

export class RemoteDirectCloudProviderAdapter implements ProviderAdapter {
  readonly providerId = "kilo-free-direct";
  constructor(private readonly options: {
    cloudUrl: string;
    getAccessToken: () => string | undefined | Promise<string | undefined>;
    workflowId: string;
    ownerUserId: string;
    fetcher?: typeof fetch;
  }) {
    const url = new URL(options.cloudUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("REMOTE_CLOUD_URL_DENIED");
  }
  async listModels() { return []; }
  async healthCheck() { return { status: "degraded" as const }; }
  async chat(_request: ChatRequest): Promise<ChatResponse> { throw new Error("REMOTE_RUNTIME_CONTEXT_REQUIRED"); }
  async *streamChat(_request: ChatRequest): AsyncIterable<StreamEvent> { throw new Error("REMOTE_RUNTIME_CONTEXT_REQUIRED"); }
  async *streamChatWithContext(request: ChatRequest, context: ProviderExecutionContext, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    if (context.userId !== this.options.ownerUserId) throw new Error("REMOTE_RUNTIME_OWNER_REQUIRED");
    const prefix = `/v1/workflows/${encodeURIComponent(this.options.workflowId)}/remote-direct`;
    const role = typeof context.role === "string" ? context.role : typeof context.metadata?.role === "string" ? context.metadata.role : "CODER";
    const submitted = await this.send(prefix, { request: { ...request, dispatchId: request.dispatchId ?? randomUUID() }, role }, signal) as { jobId: string };
    if (typeof submitted.jobId !== "string") throw new Error("REMOTE_DISPATCH_INVALID");
    let settled = false;
    try {
      while (!signal?.aborted) {
        const state = await this.send(`${prefix}/${encodeURIComponent(submitted.jobId)}`, undefined, signal) as { state: string; response?: unknown; feedback?: { status?: string; httpStatus?: number; providerErrorCode?: string; terminationReason?: string } };
        if (["cancelled", "blocked"].includes(state.state)) throw new Error("REMOTE_CLIENT_OFFLINE");
        if (state.state === "settled") {
          settled = true;
          if (state.feedback?.status !== "success") {
            yield { type: "error", code: state.feedback?.status === "rate_limited" ? "PROVIDER_RATE_LIMITED" : state.feedback?.providerErrorCode ?? "PROVIDER_UNAVAILABLE",
              message: state.feedback?.terminationReason ?? "Remote inference failed", retryable: true, ...(state.feedback?.httpStatus ? { status: state.feedback.httpStatus } : {}) };
            return;
          }
          const response = ChatResponseSchema.parse(state.response);
          for (const choice of response.choices) {
            if (choice.message.content) yield { type: "text_delta", delta: choice.message.content };
            for (const call of choice.message.toolCalls ?? []) {
              yield { type: "tool_call_started", toolCallId: call.id, toolName: call.function.name };
              yield { type: "tool_call_completed", toolCallId: call.id, toolName: call.function.name, arguments: call.function.arguments };
            }
          }
          if (response.usage) yield { type: "usage", usage: response.usage };
          yield { type: "finish", finishReason: response.choices[0]?.finishReason ?? "stop", model: response.model };
          return;
        }
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
          // Status reads share the API budget with worker ACKs, heartbeats, results and feedback.
          const timer = setTimeout(done, 2_000);
          signal?.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      if (!settled) await this.send(`/v1/remote-direct/jobs/${encodeURIComponent(submitted.jobId)}/cancel`, {}).catch(() => undefined);
    }
  }
  private async send(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const token = await this.options.getAccessToken();
    if (!token) throw new Error("REMOTE_AUTH_REQUIRED");
    const response = await (this.options.fetcher ?? fetch)(`${this.options.cloudUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok) throw new Error("REMOTE_DISPATCH_DENIED");
    return response.json();
  }
}
