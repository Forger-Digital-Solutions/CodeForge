import type { TestCaseResult } from "./types.js";

const MODEL_IDENTITY_CODES: ReadonlySet<string> = new Set([
  "MODEL_SUBSTITUTED", "MODEL_IDENTITY_MISSING", "SERVED_MODEL_UNVERIFIED",
]);

export interface ProviderCompatibilityFailure {
  providerErrorCode: string;
  providerFailureClass: "MODEL_IDENTITY";
}

export function providerCompatibilityFailure(value: unknown): ProviderCompatibilityFailure | undefined {
  if (value === null || typeof value !== "object" || !("code" in value)
    || typeof value.code !== "string" || !MODEL_IDENTITY_CODES.has(value.code)) return undefined;
  return { providerErrorCode: value.code, providerFailureClass: "MODEL_IDENTITY" };
}

export function isProviderCompatibilityFailure(result: TestCaseResult): boolean {
  const details = result.details;
  return details?.providerFailureClass === "MODEL_IDENTITY"
    && typeof details.providerErrorCode === "string" && MODEL_IDENTITY_CODES.has(details.providerErrorCode);
}

export function providerCompatibilityMetadata(cases: TestCaseResult[]): Record<string, unknown> {
  const codes = [...new Set(cases.filter(isProviderCompatibilityFailure).map(result => result.details!.providerErrorCode as string))];
  return codes.length ? { providerFailureClass: "MODEL_IDENTITY", providerErrorCodes: codes } : {};
}
