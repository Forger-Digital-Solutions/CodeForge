import { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export const HostedInferenceRequestSchema = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.string(),
      name: z.string().max(128).optional(),
      toolCallId: z.string().max(256).optional(),
      toolCalls: z.array(z.object({
        id: z.string().max(256),
        type: z.literal("function"),
        function: z.object({
          name: z.string().max(128),
          arguments: z.string().max(64_000),
        }),
      })).max(32).optional(),
    }),
  ),
  tools: z.array(z.object({
    type: z.literal("function"),
    function: z.object({
      name: z.string().min(1).max(128),
      description: z.string().max(4_000),
      parameters: z.object({
        type: z.literal("object"),
        properties: z.record(z.unknown()),
        required: z.array(z.string().max(128)).max(128).optional(),
      }).optional(),
    }),
  })).max(64).optional(),
  toolChoice: z.enum(["auto", "none", "required"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(16_384).optional(),
  modelId: z.string().optional(), // "auto" or specific modelId
  providerId: z.string().optional(),
  taskType: z.string().default("coding"),
  privacyMode: z.enum(["STRICT", "STANDARD", "MAXIMUM_FREE"]).default("STANDARD"),
  estimatedContextTokens: z.number().int().default(4000),
});
export type HostedInferenceRequest = z.infer<typeof HostedInferenceRequestSchema>;

export type HostedStreamEvent =
  | { type: "assistant.message.started"; turnId: string; messageId: string; model: string; provider: string }
  | { type: "assistant.message.delta"; messageId: string; delta: string }
  | { type: "assistant.tool_call.started"; messageId: string; toolCallId: string; toolName: string }
  | { type: "assistant.tool_call.delta"; messageId: string; toolCallId: string; delta: string }
  | { type: "assistant.tool_call.completed"; messageId: string; toolCallId: string; toolName: string; arguments: string }
  | { type: "assistant.message.completed"; messageId: string; fullText: string; finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error"; usage: { inputTokens: number; outputTokens: number } }
  | { type: "usage.updated"; creditsConsumed: number; balanceAfter: number }
  | { type: "turn.completed"; turnId: string }
  | { type: "turn.failed"; turnId: string; error: string };
