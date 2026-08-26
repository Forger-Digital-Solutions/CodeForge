import { z } from "zod";

export const SessionIdSchema = z.string().brand<"SessionId">();
export type SessionId = z.infer<typeof SessionIdSchema>;

export const TaskIdSchema = z.string().brand<"TaskId">();
export type TaskId = z.infer<typeof TaskIdSchema>;

export const AgentIdSchema = z.string().brand<"AgentId">();
export type AgentId = z.infer<typeof AgentIdSchema>;

export const ProviderIdSchema = z.string().brand<"ProviderId">();
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ModelIdSchema = z.string().brand<"ModelId">();
export type ModelId = z.infer<typeof ModelIdSchema>;

export const ToolCallIdSchema = z.string().brand<"ToolCallId">();
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;

export const CheckpointIdSchema = z.string().brand<"CheckpointId">();
export type CheckpointId = z.infer<typeof CheckpointIdSchema>;
