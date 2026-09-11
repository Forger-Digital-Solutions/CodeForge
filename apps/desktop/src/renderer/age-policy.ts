export const APPROVED_MINIMUM_AGE = 18;
export const AGE_POLICY_VERSION = "desktop-byok-beta-r1";

export interface AgePolicyAcknowledgement {
  minimumAge: typeof APPROVED_MINIMUM_AGE;
  policyVersion: typeof AGE_POLICY_VERSION;
  acknowledged: true;
}

export function createAgePolicyAcknowledgement(
  minimumAge: number,
  policyVersion: string,
): AgePolicyAcknowledgement | null {
  if (minimumAge !== APPROVED_MINIMUM_AGE || policyVersion !== AGE_POLICY_VERSION) {
    return null;
  }
  return {
    minimumAge: APPROVED_MINIMUM_AGE,
    policyVersion: AGE_POLICY_VERSION,
    acknowledged: true,
  };
}

export function isAgePolicyAcknowledgement(value: unknown): value is AgePolicyAcknowledgement {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    state.minimumAge === APPROVED_MINIMUM_AGE &&
    state.policyVersion === AGE_POLICY_VERSION &&
    state.acknowledged === true
  );
}
