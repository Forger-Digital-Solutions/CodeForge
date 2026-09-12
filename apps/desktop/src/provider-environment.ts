/**
 * Environment credentials supported by the desktop without persisting them. Only providers with
 * independently zero-priced model routes are enabled here: merely possessing a key must never
 * trigger an allowance probe whose billing state is ambiguous.
 */
const ZERO_UNIT_PROVIDER_ENV = {
  opencode: "OPENCODE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZHIPU_API_KEY",
} as const;

export function readZeroUnitEnvironmentCredentials(
  environment: Readonly<Record<string, string | undefined>>,
  maxLength = 512,
): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const [providerId, variable] of Object.entries(ZERO_UNIT_PROVIDER_ENV)) {
    const value = environment[variable];
    if (typeof value === "string" && value.length > 0 && value.length <= maxLength) {
      credentials[providerId] = value;
    }
  }
  return credentials;
}
