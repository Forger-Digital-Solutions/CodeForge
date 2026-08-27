/**
 * User-facing error message translations.
 * Maps internal error codes to friendly messages for the desktop UI.
 */

export const ERROR_MESSAGES: Record<string, string> = {
  NO_FREE_PROVIDER: "No verified free cloud model is currently available. Please connect a provider with free models or wait for promotional models to become available.",
  MODEL_MISMATCH: "The provider returned a different model than requested. CodeForge blocked the response to prevent unintended model substitution.",
  PAYMENT_REQUIRED: "The provider requires payment for this model. CodeForge blocked the request because Free Mode is enabled.",
  AUTH_ERROR: "Provider authentication failed. Check your provider connection and API key.",
  RATE_LIMITED: "This free provider is temporarily rate limited. CodeForge will use another eligible free provider if available.",
  MODEL_NOT_FOUND: "The requested model is unavailable. It may have been removed or is temporarily offline.",
  FREE_TIER_EXPIRED: "This promotional free model requires re-verification and is currently excluded from Free Mode. Please reconnect the provider.",
  PROVIDER_OFFLINE: "The provider is currently unavailable. Please check your internet connection and try again.",
  CREDENTIAL_MISSING: "Provider API key is missing. Please configure your provider credentials in settings.",
  CREDENTIAL_INVALID: "Provider API key is invalid. Please check your credentials and try again.",
  NETWORK_ERROR: "Network error occurred. Please check your internet connection.",
  TIMEOUT: "Request timed out. The provider may be slow or unavailable.",
  UNKNOWN_ERROR: "An unexpected error occurred. Please try again.",
};

export function getUserFacingMessage(errorCode: string, fallback?: string): string {
  const message = ERROR_MESSAGES[errorCode];
  if (message) return message;
  if (fallback) return fallback;
  return ERROR_MESSAGES["UNKNOWN_ERROR"]!;
}

export function isFreeModeError(errorCode: string): boolean {
  return [
    "NO_FREE_PROVIDER",
    "FREE_TIER_EXPIRED",
    "MODEL_MISMATCH",
  ].includes(errorCode);
}

export function isAuthError(errorCode: string): boolean {
  return [
    "AUTH_ERROR",
    "CREDENTIAL_MISSING",
    "CREDENTIAL_INVALID",
  ].includes(errorCode);
}

export function isProviderError(errorCode: string): boolean {
  return [
    "PROVIDER_OFFLINE",
    "RATE_LIMITED",
    "MODEL_NOT_FOUND",
    "TIMEOUT",
  ].includes(errorCode);
}
