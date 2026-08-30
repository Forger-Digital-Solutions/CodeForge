import { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const HostedInferenceRequestSchema = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    }),
  ),
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
  | { type: "assistant.message.completed"; messageId: string; fullText: string; usage: { inputTokens: number; outputTokens: number } }
  | { type: "usage.updated"; creditsConsumed: number; balanceAfter: number }
  | { type: "turn.completed"; turnId: string }
  | { type: "turn.failed"; turnId: string; error: string };
