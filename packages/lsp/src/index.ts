/**
 * NON-IMPLEMENTATION PLACEHOLDER — do not wire into the tool surface.
 * `diagnostics()` returns an empty list unconditionally; there is no LSP transport, server
 * process, or protocol handling here. Production diagnostics reach the agent through the
 * workspace's own verification commands (tsc/eslint via run_command) and ForgeVerify.
 * Classified CLASSIFIED_STUB_NOT_A_FEATURE in the R32 capability inventory: a real
 * language-server bridge is future work, not a shipped capability.
 */
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
