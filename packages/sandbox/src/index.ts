export type RiskLevel = "safe" | "moderate" | "high" | "critical";

export class CommandClassifier {
  classify(command: string): { risk: RiskLevel; reasons: string[] } {
    return { risk: "moderate", reasons: [] };
  }
}

export class ProcessGuard {
  async killTree(pid: number): Promise<void> {}
}
