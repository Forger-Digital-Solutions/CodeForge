export type PermissionPolicy = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string;
  policy: PermissionPolicy;
  pattern?: string;
}

export class PermissionEngine {
  constructor(_rules?: PermissionRule[]) {}
  evaluate(_tool: string, _context?: unknown): PermissionPolicy {
    return "ask";
  }
}
