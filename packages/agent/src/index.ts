export interface AgentDefinition {
  id: string;
  role: string;
  systemPrompt: string;
  capabilities: string[];
}

export const BUILT_IN_ROLES: string[] = ["coder", "reviewer", "planner"];

export function getAgent(role: string): AgentDefinition | undefined {
  return undefined;
}
