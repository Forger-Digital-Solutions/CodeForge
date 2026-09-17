export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export class McpClient {
  constructor(_serverCommand: string) {}
  async listTools(): Promise<McpTool[]> {
    return [];
  }
}
