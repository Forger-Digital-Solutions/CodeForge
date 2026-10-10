export interface PersonalPaidEstimateView {
  presentationId: string;
  connectionId: string;
  providerId: string;
  maskedIdentity: string;
  modelId: string;
  estimatedCostUsd: number;
  remainingBudgetUsd: number;
  currency: "USD";
  purpose: "INFERENCE" | "QUALIFICATION";
}
