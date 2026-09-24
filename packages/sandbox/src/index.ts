/**
 * NON-IMPLEMENTATION PLACEHOLDER — do not wire anywhere.
 * `CommandClassifier.classify` returns a constant for every input and `ProcessGuard.killTree`
 * is a no-op. The real implementations live in `packages/server/src/command-classifier.ts`
 * (risk/category/approval classification with destructive-pattern detection) and the governed
 * run_command/terminal execution path. Classified CLASSIFIED_STUB_SUPERSEDED in the R32
 * capability inventory.
 */
export type RiskLevel = "safe" | "moderate" | "high" | "critical";

export class CommandClassifier {
  classify(_command: string): { risk: RiskLevel; reasons: string[] } {
    return { risk: "moderate", reasons: [] };
  }
}

export class ProcessGuard {
  async killTree(_pid: number): Promise<void> {}
}
