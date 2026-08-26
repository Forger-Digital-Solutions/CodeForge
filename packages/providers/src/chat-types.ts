import { z } from "zod";

export const ChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(z.any()).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ToolParameterSchemaSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.any()),
  required: z.array(z.string()).optional(),
});
export type ToolParameterSchema = z.infer<typeof ToolParameterSchemaSchema>;

export const ToolDefinitionSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: ToolParameterSchemaSchema.optional(),
  }),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema),
  system: z.string().optional(),
  tools: z.array(ToolDefinitionSchema).optional(),
  toolChoice: z.enum(["auto", "none", "required"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const StreamEventTypeSchema = z.enum([
  "text_delta",
  "tool_call_started",
  "tool_call_delta",
  "tool_call_completed",
  "usage",
  "finish",
  "error",
]);
export type StreamEventType = z.infer<typeof StreamEventTypeSchema>;

export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text_delta"),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("tool_call_started"),
    toolCallId: z.string(),
    toolName: z.string(),
  }),
  z.object({
    type: z.literal("tool_call_delta"),
    toolCallId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("tool_call_completed"),
    toolCallId: z.string(),
    toolName: z.string(),
    arguments: z.string(),
  }),
  z.object({
    type: z.literal("usage"),
    usage: UsageSchema,
  }),
  z.object({
    type: z.literal("finish"),
    finishReason: z.enum(["stop", "tool_calls", "length", "content_filter", "error"]),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const ChatResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      message: ChatMessageSchema,
      finishReason: z.enum(["stop", "tool_calls", "length", "content_filter", "error"]).optional(),
    }),
  ),
  usage: UsageSchema.optional(),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export const FinishReasonSchema = z.enum([
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  "error",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;
