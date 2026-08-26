export type DataClassification = "public" | "internal" | "protected" | "restricted";

export interface ExternalInferencePolicy {
  canSend(task: unknown, context: unknown[], provider: unknown): { allowed: boolean; reason: string };
}

export class GemsGuard {
  constructor(policy?: ExternalInferencePolicy) {}
  classify(path: string): DataClassification {
    return "public";
  }
  canSendToExternal(data: DataClassification): boolean {
    return data === "public";
  }
}

export function createGemsGuard(policy?: ExternalInferencePolicy): GemsGuard {
  return new GemsGuard(policy);
}
