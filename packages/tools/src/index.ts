export interface Tool {
  id: string;
  description: string;
  execute(ctx: unknown): Promise<unknown>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  register(tool: Tool): void {
    this.tools.set(tool.id, tool);
  }
  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }
  all(): Tool[] {
    return Array.from(this.tools.values());
  }
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}

export const READ_TOOL: Tool = {
  id: "read",
  description: "Read a file",
  execute: async () => ({}),
};
