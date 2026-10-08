export interface PuterAccountView {
  connected: boolean;
  checkedAt?: string;
  accountIdentity?: string;
  catalogModels?: number;
  monthlyAllowanceMicrocents?: number;
  remainingMicrocents?: number;
  automaticFreeAdmission: false;
  reason: "PROVIDER_FREE_ONLY_GUARD_UNAVAILABLE";
}

export interface PuterAuthorization {
  token: string;
  accountId: string;
  catalogModels: number;
  monthlyAllowanceMicrocents?: number;
  remainingMicrocents?: number;
}

export const PUTER_FREE_BLOCKER = "Puter may spend purchased credits after its monthly allowance. Automatic Free inference requires a provider-enforced free-only guard.";

export function parsePuterAuthorization(raw: unknown): PuterAuthorization {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid Puter authorization");
  const value = raw as Record<string, unknown>;
  if (typeof value.token !== "string" || value.token.length < 1 || value.token.length > 8192 || /[\r\n]/.test(value.token)) throw new Error("Invalid Puter authorization token");
  if (typeof value.accountId !== "string" || value.accountId.length < 1 || value.accountId.length > 256) throw new Error("Invalid Puter account identity");
  if (!Number.isSafeInteger(value.catalogModels) || (value.catalogModels as number) < 0 || (value.catalogModels as number) > 100_000) throw new Error("Invalid Puter catalog observation");
  const amount = (field: string): number | undefined => {
    if (value[field] === undefined || value[field] === null) return undefined;
    if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0) throw new Error("Invalid Puter allowance observation");
    return value[field];
  };
  return { token: value.token, accountId: value.accountId, catalogModels: value.catalogModels as number,
    monthlyAllowanceMicrocents: amount("monthlyAllowanceMicrocents"), remainingMicrocents: amount("remainingMicrocents") };
}
