export type RiskLevel = "safe" | "moderate" | "high" | "critical";

export class CommandClassifier {
  classify(_command: string): { risk: RiskLevel; reasons: string[] } {
    return { risk: "moderate", reasons: [] };
  }
}

export class ProcessGuard {
  async killTree(_pid: number): Promise<void> {}
}
