/**
 * Desktop local-secret codec (Security R1, Phases 6 & 22).
 *
 * Every user secret the desktop persists — BYOK provider keys and CodeForge Cloud session
 * tokens — is sealed with Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux Secret
 * Service/kwallet, depending on platform and session) and stored as `enc:<base64>`.
 *
 * Policy, stated as invariants the unit tests enforce:
 *   * A value that is not an `enc:` payload is NEVER treated as a usable credential. The pre-R1
 *     plaintext read fallback is closed: a plaintext value found on disk is either migrated in
 *     place (sealed on first load, when secure storage is available) or ignored.
 *   * A plaintext value is never destroyed by the migration when secure storage is unavailable;
 *     it is simply not usable until it can be sealed, and the caller is told so.
 *   * Sealing never silently degrades to plaintext: when secure storage is unavailable the write
 *     throws and nothing is persisted.
 *   * A corrupt/undecryptable `enc:` payload fails closed (undefined), never returns bytes.
 *
 * This module is pure so it can be unit-tested outside Electron; `main.ts` injects `safeStorage`.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export const ENC_PREFIX = "enc:";

export function isSealedCredential(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENC_PREFIX) && value.length > ENC_PREFIX.length;
}

export function sealCredential(storage: SafeStorageLike, value: string): string {
  if (!storage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable; the credential was not saved.");
  }
  return `${ENC_PREFIX}${storage.encryptString(value).toString("base64")}`;
}

/**
 * Open a sealed credential. Returns undefined for anything that is not a valid sealed payload —
 * including legacy plaintext, which is deliberately NOT returned.
 */
export function openCredential(storage: SafeStorageLike, stored: unknown): string | undefined {
  if (!isSealedCredential(stored)) return undefined;
  if (!storage.isEncryptionAvailable()) return undefined;
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
    if (buf.length === 0) return undefined;
    return storage.decryptString(buf);
  } catch {
    return undefined;
  }
}

export interface LegacyMigrationResult {
  /** Keys whose plaintext value was sealed in place. */
  sealed: string[];
  /** Keys that hold plaintext but could not be sealed because secure storage is unavailable. */
  blocked: string[];
}

/**
 * Seal any legacy plaintext values in a credential map, in place. Idempotent and restartable:
 * already-sealed values are untouched, and a second run finds nothing to do. Values that cannot
 * be sealed are left exactly as found (never deleted) and reported as blocked so the UI can ask
 * the user to re-enter them once secure storage is available.
 */
export function migrateLegacyPlaintextCredentials(
  storage: SafeStorageLike,
  credentials: Record<string, unknown>,
  isAllowedKey: (key: string) => boolean = () => true,
): LegacyMigrationResult {
  const result: LegacyMigrationResult = { sealed: [], blocked: [] };
  for (const [key, value] of Object.entries(credentials)) {
    if (!isAllowedKey(key)) continue;
    if (typeof value !== "string" || value.length === 0 || isSealedCredential(value)) continue;
    if (!storage.isEncryptionAvailable()) {
      result.blocked.push(key);
      continue;
    }
    credentials[key] = sealCredential(storage, value);
    result.sealed.push(key);
  }
  return result;
}

/** Mask for UI display: never the original value, only a stable non-reversible tail hint. */
export function maskCredentialForDisplay(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
