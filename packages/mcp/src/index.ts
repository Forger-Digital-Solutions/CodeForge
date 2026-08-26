export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export class McpClient {
  constructor(serverCommand: string) {}
  async listTools(): Promise<McpTool[]> {
    return [];
  }
}
