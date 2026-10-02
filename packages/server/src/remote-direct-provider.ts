import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderExecutionContext, StreamEvent } from "@codeforge/providers";
import { RemoteDirectTransport, type RemoteDirectBinding } from "./remote-direct-transport.js";

export class RemoteDirectProviderAdapter implements ProviderAdapter {
  readonly providerId = "kilo-free-direct";
  constructor(private readonly transport: RemoteDirectTransport,
    private readonly resolveBinding: (context: ProviderExecutionContext, request: ChatRequest) => RemoteDirectBinding | undefined | Promise<RemoteDirectBinding | undefined>) {}

  async listModels() { return []; }
  async healthCheck() { return { providerId: this.providerId, status: "degraded" as const, latencyMs: 0, checkedAt: new Date().toISOString(), message: "Availability depends on an authenticated client and admitted quota domain" }; }
  async chat(_request: ChatRequest): Promise<ChatResponse> { throw new Error("REMOTE_RUNTIME_CONTEXT_REQUIRED"); }
  async *streamChat(_request: ChatRequest): AsyncIterable<StreamEvent> { throw new Error("REMOTE_RUNTIME_CONTEXT_REQUIRED"); }

  async *streamChatWithContext(request: ChatRequest, context: ProviderExecutionContext, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const binding = await this.resolveBinding(context, request);
    if (!binding || context.userId !== binding.accountId) throw new Error("REMOTE_RUNTIME_OWNER_REQUIRED");
    const jobId = await this.transport.enqueue(binding, request, request.dispatchId ?? randomUUID());
    let settled = false;
    try {
      while (!signal?.aborted) {
        const status = await this.transport.status(binding.accountId, jobId);
        if (["cancelled", "blocked"].includes(status.state)) throw new Error(status.state === "cancelled" ? "REMOTE_CANCELLED" : "REMOTE_CLIENT_OFFLINE");
        if (status.state === "settled" && status.response) {
          settled = true;
          if (status.feedback?.status !== "success") {
            const rateLimited = status.feedback?.status === "rate_limited";
            yield { type: "error", code: rateLimited ? "PROVIDER_RATE_LIMITED" : String(status.feedback?.providerErrorCode ?? "PROVIDER_UNAVAILABLE"), message: String(status.feedback?.terminationReason), retryable: true,
              ...(typeof status.feedback?.httpStatus === "number" ? { status: status.feedback.httpStatus } : rateLimited ? { status: 429 } : {}), ...(typeof status.feedback?.rateLimitResetAt === "string" ? { retryAfter: Date.parse(status.feedback.rateLimitResetAt) } : {}) };
            return;
          }
          for (const choice of status.response.choices) {
            if (choice.message.content) yield { type: "text_delta", delta: choice.message.content };
            for (const call of choice.message.toolCalls ?? []) {
              yield { type: "tool_call_started", toolCallId: call.id, toolName: call.function.name };
              yield { type: "tool_call_completed", toolCallId: call.id, toolName: call.function.name, arguments: call.function.arguments };
            }
          }
          if (status.response.usage) yield { type: "usage", usage: status.response.usage };
          yield { type: "finish", finishReason: status.response.choices[0]?.finishReason ?? "stop", model: status.response.model };
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 100);
          function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
          signal?.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      if (!settled) await this.transport.cancel(binding.accountId, jobId);
    }
  }
}
