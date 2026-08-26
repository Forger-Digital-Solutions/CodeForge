export type PermissionPolicy = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string;
  policy: PermissionPolicy;
  pattern?: string;
}

export class PermissionEngine {
  constructor(rules?: PermissionRule[]) {}
  evaluate(tool: string, context?: unknown): PermissionPolicy {
    return "ask";
  }
}
