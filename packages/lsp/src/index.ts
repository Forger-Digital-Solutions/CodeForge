export interface LspDiagnostic {
  path: string;
  line: number;
  message: string;
  severity: string;
}

export class LspClient {
  constructor(_workspaceRoot: string) {}
  async diagnostics(_path: string): Promise<LspDiagnostic[]> {
    return [];
  }
}
