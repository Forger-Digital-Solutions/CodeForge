export interface OnboardingState {
  completed: boolean;
}

export function shouldShowOnboarding(params: {
  onboardingCompleted: boolean;
  hasConfiguredProvider: boolean;
}): boolean {
  if (params.onboardingCompleted) return false;
  if (params.hasConfiguredProvider) return false;
  return true;
}

export function isOnboardingStateValid(state: unknown): boolean {
  if (typeof state !== "object" || state === null) return false;
  const s = state as Record<string, unknown>;
  if (typeof s.completed !== "boolean") return false;
  const forbiddenKeys = ["apiKey", "api_key", "credential", "OPENCODE_API_KEY", "OPENROUTER_API_KEY", "Authorization", "secret"];
  for (const key of forbiddenKeys) {
    if (key in s) return false;
  }
  for (const v of Object.values(s)) {
    if (typeof v === "string" && v.length > 20 && /sk[-_]/.test(v)) return false;
  }
  return true;
}

export function createOnboardingCompletedState(): OnboardingState {
  return { completed: true };
}

export function createOnboardingSkippedState(): OnboardingState {
  return { completed: true };
}
