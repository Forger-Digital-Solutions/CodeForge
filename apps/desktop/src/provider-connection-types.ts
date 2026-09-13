import type {
  AuthClass,
  CredentialSource,
  DetectedEnvironmentCredential,
  ProviderConnectionState,
  ProviderDefinition,
} from "@codeforge/model-registry";

/**
 * Renderer-safe view types for provider connections. Pure types only (no node/electron imports)
 * so the sandboxed renderer and the trusted main process share one contract. No field here ever
 * carries a credential value.
 */

export interface EnvironmentCredentialView extends DetectedEnvironmentCredential {
  enabled: boolean;
  /** True when the provider's active credential currently comes from the environment. */
  active: boolean;
  policyBlocked: boolean;
  policyBlockedReason?: string;
}

export interface ProviderCatalogModelView {
  modelId: string;
  canonicalId: string;
  displayName: string;
  free: boolean;
  freeReason: string;
  toolCalling: boolean;
  contextWindow?: number;
  enabled: boolean;
}

export interface ProviderConnectionView {
  providerId: string;
  displayName: string;
  kind: ProviderDefinition["kind"];
  implemented: boolean;
  recommendedForFreeDefault: boolean;
  authClasses: AuthClass[];
  fields: Array<{ id: string; label: string; secret: boolean; optional: boolean; help?: string; environmentAliases: string[] }>;
  freeAccess: ProviderDefinition["freeAccess"];
  privacy: ProviderDefinition["privacy"];
  terms: ProviderDefinition["terms"];
  keyUrl?: string;
  docsUrl?: string;
  connected: boolean;
  credentialSource: CredentialSource;
  environmentVariable?: string;
  authState: ProviderConnectionState["authState"];
  planAttested: boolean;
  planAttestationRequired: boolean;
  connectOffer?: ProviderConnectionState["connectOffer"];
  environment: EnvironmentCredentialView | null;
  freeRouteCount: number;
  healthyRouteCount: number;
  catalogCount: number;
  paidOnly: boolean;
  zeroCashFreeAccess: boolean;
  /** Sorting bucket (R1 §180): 0 connected · 1 detected env · 2 one-click · 3 recommended · 4 other. */
  sortRank: number;
}

export interface ConnectResult {
  ok: boolean;
  error?: string;
  models?: ProviderCatalogModelView[];
  verifiedFree?: number;
}

export type FirstRunOffer =
  | { kind: "ready"; models: number; routes: number }
  | { kind: "qualifying"; pending: number }
  | { kind: "environment"; providerId: string; displayName: string; variable: string }
  | { kind: "oauth"; providerId: string; displayName: string }
  | { kind: "manual"; providerId: string; displayName: string; keyUrl?: string };
