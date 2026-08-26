// Centralized, configurable upgrade/subscription navigation target.
//
// A development/stub URL by default; override with CODEFORGE_UPGRADE_URL.
// All upgrade navigation in the product must go through getUpgradeUrl() so
// the billing entry point is never scattered or silently ignored across
// components. No payment processing lives here — this is a navigation seam.
export const DEFAULT_UPGRADE_URL = "https://codeforge.dev/pricing";

export function getUpgradeUrl(): string {
  try {
    const env =
      typeof process !== "undefined"
        ? (process as { env?: Record<string, string | undefined> }).env
        : undefined;
    if (env?.CODEFORGE_UPGRADE_URL) {
      return env.CODEFORGE_UPGRADE_URL;
    }
  } catch {
    // Renderers without a process shim fall through to the default URL
  }
  return DEFAULT_UPGRADE_URL;
}
