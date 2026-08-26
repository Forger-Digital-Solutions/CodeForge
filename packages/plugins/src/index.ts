export interface PluginContext {
  registerTool(tool: unknown): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export interface CodeForgePlugin {
  id: string;
  activate(ctx: PluginContext): Promise<void>;
}

export class PluginRegistry {
  async load(plugin: CodeForgePlugin): Promise<void> {}
}
