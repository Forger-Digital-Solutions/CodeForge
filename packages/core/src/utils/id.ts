import { randomUUID } from "node:crypto";

export const generateId = (): string => randomUUID();

export const newSessionId = (): string => randomUUID();
export const newTaskId = (): string => randomUUID();
export const newToolCallId = (): string => randomUUID();
export const newCheckpointId = (): string => randomUUID();
