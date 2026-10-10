export type ConnectedAccountAuthMethod = "OAUTH_PKCE" | "API_KEY" | "ENVIRONMENT";
export type ConnectedAccountClassification = "FREE_VERIFIED" | "FREE_UNVERIFIED" | "PAID" | "BLOCKED";
export type ConnectedAccountPreference = "AUTO" | "PREFERRED" | "FALLBACK" | "MANUAL";

export interface ConnectedAccountView {
  connectionId: string;
  providerId: string;
  providerName: string;
  label?: string;
  maskedIdentity: string;
  authMethod: ConnectedAccountAuthMethod;
  connected: boolean;
  enabled: boolean;
  authState: "ok" | "auth_required" | "rate_limited" | "unknown";
  classification: ConnectedAccountClassification;
  freeOnly: boolean;
  paidSpendingEnabled: boolean;
  monthlyBudgetCents?: number;
  preference: ConnectedAccountPreference;
  freeRouteCount: number;
  qualifiedModels: string[];
  quotaSummary?: string;
  health?: string;
  reason?: string;
  paidDispatchEligible: boolean;
  paidBlockReason?: string;
  paidQualificationEligible?: boolean;
  paidQualificationBlockReason?: string;
  qualificationModels?: { modelId: string; displayName: string; isFree: boolean }[];
}

export interface ConnectedAccountPolicyPatch {
  label?: string;
  enabled?: boolean;
  paidSpendingEnabled?: boolean;
  monthlyBudgetCents?: number | null;
  preference?: ConnectedAccountPreference;
}

export interface ConnectedAccountResult {
  ok: boolean;
  connection?: ConnectedAccountView;
  error?: string;
}

export interface ProviderRoutingPolicy {
  mode: "FREE_ONLY" | "FREE_PREFERRED" | "PAID_PREFERRED" | "SPECIFIC_ACCOUNT" | "AUTO_BEST";
  paidEnabled: boolean;
  explicitConsent: boolean;
  limitationsAcknowledged: boolean;
  automaticTopUp: false;
  specificAccountConnectionId?: string;
}

export interface ProviderAccountOAuthOptions {
  label?: string;
  reauthorizeConnectionId?: string;
}
