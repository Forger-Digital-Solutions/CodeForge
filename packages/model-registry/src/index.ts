export type RefreshResult = { added: number; updated: number };

/**
 * FreshModelRegistry is currently a stub/fallback.
 * Production model discovery is static via FREE_CATALOG in @codeforge/forge-zero.
 * Live provider state is reflected only through health/status and verifier expiry,
 * not dynamic discovery. This is intentional fallback until live catalog sync is
 * implemented. Static catalog never overrides live provider ineligibility because
 * ForgeZero remains authoritative.
 */
export class FreeModelRegistry {
  register(model: unknown): void {}
  all(): unknown[] { return []; }
}

export function createRegistry(): FreeModelRegistry {
  return new FreeModelRegistry();
}
