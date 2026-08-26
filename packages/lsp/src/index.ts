export interface LspDiagnostic {
  path: string;
  line: number;
  message: string;
  severity: string;
}

export class LspClient {
  constructor(workspaceRoot: string) {}
  async diagnostics(path: string): Promise<LspDiagnostic[]> {
    return [];
  }
}
