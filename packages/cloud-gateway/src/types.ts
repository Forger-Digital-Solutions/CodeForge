import { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: HostedToolCall[];
}

export const HostedToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});
export type HostedToolCall = z.infer<typeof HostedToolCallSchema>;

export const HostedToolDefinitionSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z
      .object({
        type: z.literal("object"),
        properties: z.record(z.unknown()),
        required: z.array(z.string()).optional(),
      })
      .optional(),
  }),
});
export type HostedToolDefinition = z.infer<typeof HostedToolDefinitionSchema>;

export const HostedInferenceRequestSchema = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.string(),
      name: z.string().optional(),
      toolCallId: z.string().optional(),
      toolCalls: z.array(HostedToolCallSchema).optional(),
    }),
  ),
  modelId: z.string().optional(), // "auto" or specific modelId
  providerId: z.string().optional(),
  taskType: z.string().default("coding"),
  privacyMode: z.enum(["STRICT", "STANDARD", "MAXIMUM_FREE"]).default("STANDARD"),
  estimatedContextTokens: z.number().int().default(4000),
  // Native tool passthrough (HOSTED_TOOLS). Clients on older gateways never send this —
  // they use the text-level contract instead — so presence always means the caller
  // negotiated the feature via /v1/meta.
  tools: z.array(HostedToolDefinitionSchema).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type HostedInferenceRequest = z.infer<typeof HostedInferenceRequestSchema>;

export type HostedFinishReason = "stop" | "tool_calls" | "length";

export type HostedStreamEvent =
  | { type: "assistant.message.started"; turnId: string; messageId: string; model: string; provider: string }
  | { type: "assistant.message.delta"; messageId: string; delta: string }
  | { type: "assistant.tool_call.started"; messageId: string; toolCallId: string; toolName: string }
  | { type: "assistant.tool_call.delta"; messageId: string; toolCallId: string; delta: string }
  | { type: "assistant.tool_call.completed"; messageId: string; toolCallId: string; toolName: string; arguments: string }
  | { type: "assistant.message.completed"; messageId: string; fullText: string; finishReason: HostedFinishReason; usage: { inputTokens: number; outputTokens: number } }
  | { type: "usage.updated"; creditsConsumed: number; balanceAfter: number }
  | { type: "turn.completed"; turnId: string }
  | { type: "turn.failed"; turnId: string; error: string };
