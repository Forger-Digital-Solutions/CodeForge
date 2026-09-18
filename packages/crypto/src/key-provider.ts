import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Key-encryption authority for the CodeForge secret envelope.
 *
 * The envelope service never touches a key-encryption key (KEK) directly. It hands a freshly
 * generated per-record data-encryption key (DEK) to a {@link KeyEncryptionProvider} to be wrapped,
 * and later hands the wrapped blob back to be unwrapped. That is the whole seam a managed KMS/HSM
 * needs: a KMS-backed provider implements the same two methods with remote `Encrypt`/`Decrypt`
 * calls and the stored envelopes do not change shape.
 *
 * Today the only production provider is {@link LocalKeyEncryptionProvider}, which wraps DEKs with
 * a server-side KEK loaded from the process environment. That KEK is NOT a KMS and is not
 * described as one anywhere in CodeForge documentation: it is a transitional, server-only,
 * versioned master key that keeps the wrapping authority outside the database and outside every
 * client. See docs/security/key-management-and-rotation.md for the remaining risk.
 */
export interface WrappedKey {
  /** Identifier of the KEK version that wrapped this DEK. */
  keyVersion: number;
  /** Opaque provider-specific blob. For the local provider: nonce || ciphertext || tag. */
  blob: Buffer;
}

export interface KeyEncryptionProvider {
  /** Human-readable provider kind, surfaced in metrics/documentation. Never a secret. */
  readonly kind: "local-kek" | "static-test" | "kms";
  /** Version of the KEK new envelopes are wrapped with. */
  readonly activeKeyVersion: number;
  /** Every KEK version this provider can still unwrap (active + decrypt-only). */
  readonly knownKeyVersions: readonly number[];
  wrapKey(dek: Buffer, aad: Buffer): WrappedKey;
  /**
   * Unwrap a DEK. MUST throw (never return garbage) when the version is unknown, the AAD does not
   * match, or the authentication tag fails.
   */
  unwrapKey(wrapped: WrappedKey, aad: Buffer): Buffer;
}

export class KeyProviderError extends Error {
  constructor(readonly code: "KEY_VERSION_UNKNOWN" | "KEY_UNWRAP_FAILED" | "KEY_MATERIAL_INVALID" | "KEY_CONFIG_INVALID", message: string) {
    super(message);
    this.name = "KeyProviderError";
  }
}

const KEK_BYTES = 32;
const WRAP_NONCE_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const HKDF_INFO = "codeforge-data-encryption-kek-v1";

export interface KeyRingEntry {
  version: number;
  key: Buffer;
}

/**
 * Parse `CODEFORGE_DATA_ENCRYPTION_KEYS`.
 *
 * Accepted grammar (comma-separated entries, whitespace ignored):
 *   `<version>:<material>` — explicit version number (positive integer) and key material
 *   `<material>`           — a single unversioned entry, treated as version 1
 *
 * Key material is either exactly 32 bytes encoded as base64 / base64url / hex (preferred: generate
 * with `openssl rand -base64 32`), or an arbitrary secret string of at least 32 characters, which is
 * stretched to 32 bytes with HKDF-SHA256. The second form exists so a platform that generates a
 * random alphanumeric secret (Render's `generateValue`) can be used without hand-encoding. Every
 * version must be distinct; duplicates and low-length material are rejected — a misconfigured key
 * must stop boot, never silently weaken storage.
 */
export function parseKeyRing(raw: string): KeyRingEntry[] {
  const entries: KeyRingEntry[] = [];
  const seen = new Set<number>();
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new KeyProviderError("KEY_CONFIG_INVALID", "CODEFORGE_DATA_ENCRYPTION_KEYS is empty");
  for (const part of parts) {
    let version = 1;
    let material = part;
    const match = /^(\d{1,6}):(.+)$/.exec(part);
    if (match) {
      version = Number(match[1]);
      material = match[2]!;
    } else if (parts.length > 1) {
      throw new KeyProviderError("KEY_CONFIG_INVALID", "Every CODEFORGE_DATA_ENCRYPTION_KEYS entry must be versioned (<version>:<material>) when more than one key is configured");
    }
    if (!Number.isInteger(version) || version <= 0) throw new KeyProviderError("KEY_CONFIG_INVALID", "Key version must be a positive integer");
    if (seen.has(version)) throw new KeyProviderError("KEY_CONFIG_INVALID", `Duplicate key version ${version}`);
    seen.add(version);
    entries.push({ version, key: deriveKeyMaterial(material) });
  }
  return entries.sort((a, b) => b.version - a.version);
}

function deriveKeyMaterial(material: string): Buffer {
  const decoded = decodeExact32(material);
  if (decoded) return decoded;
  if (material.length < 32) {
    throw new KeyProviderError("KEY_MATERIAL_INVALID", "Key material must be 32 random bytes (base64/base64url/hex) or a secret of at least 32 characters");
  }
  if (/^(.)\1+$/.test(material) || /^(test|password|secret|changeme|example)/i.test(material)) {
    throw new KeyProviderError("KEY_MATERIAL_INVALID", "Key material is a placeholder, not a secret");
  }
  return Buffer.from(hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.alloc(0), HKDF_INFO, KEK_BYTES));
}

function decodeExact32(material: string): Buffer | undefined {
  if (/^[0-9a-fA-F]{64}$/.test(material)) return Buffer.from(material, "hex");
  if (/^[A-Za-z0-9+/]{43}=?$/.test(material)) {
    const buf = Buffer.from(material, "base64");
    if (buf.length === KEK_BYTES) return buf;
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(material)) {
    const buf = Buffer.from(material, "base64url");
    if (buf.length === KEK_BYTES) return buf;
  }
  return undefined;
}

/**
 * Wraps DEKs with a versioned in-process KEK using AES-256-GCM. The AAD binds the wrapped DEK to
 * the same context as the payload it protects, so a wrapped DEK lifted from one record cannot be
 * used to unwrap another record's DEK.
 */
export class LocalKeyEncryptionProvider implements KeyEncryptionProvider {
  readonly kind = "local-kek" as const;
  readonly activeKeyVersion: number;
  readonly knownKeyVersions: readonly number[];
  private readonly keys = new Map<number, Buffer>();

  constructor(entries: readonly KeyRingEntry[], options: { activeVersion?: number } = {}) {
    if (entries.length === 0) throw new KeyProviderError("KEY_CONFIG_INVALID", "At least one key-encryption key is required");
    for (const entry of entries) {
      if (entry.key.length !== KEK_BYTES) throw new KeyProviderError("KEY_MATERIAL_INVALID", `Key version ${entry.version} is not 256 bits`);
      if (this.keys.has(entry.version)) throw new KeyProviderError("KEY_CONFIG_INVALID", `Duplicate key version ${entry.version}`);
      this.keys.set(entry.version, Buffer.from(entry.key));
    }
    const versions = [...this.keys.keys()].sort((a, b) => b - a);
    const active = options.activeVersion ?? versions[0]!;
    if (!this.keys.has(active)) throw new KeyProviderError("KEY_VERSION_UNKNOWN", `Active key version ${active} is not in the key ring`);
    this.activeKeyVersion = active;
    this.knownKeyVersions = versions;
  }

  static fromEnvironment(env: Record<string, string | undefined> = process.env): LocalKeyEncryptionProvider {
    const raw = env.CODEFORGE_DATA_ENCRYPTION_KEYS;
    if (!raw) throw new KeyProviderError("KEY_CONFIG_INVALID", "CODEFORGE_DATA_ENCRYPTION_KEYS is not configured");
    const entries = parseKeyRing(raw);
    const activeRaw = env.CODEFORGE_DATA_ENCRYPTION_ACTIVE_KEY?.trim();
    const activeVersion = activeRaw ? Number(activeRaw) : undefined;
    if (activeRaw && (!Number.isInteger(activeVersion) || (activeVersion ?? 0) <= 0)) {
      throw new KeyProviderError("KEY_CONFIG_INVALID", "CODEFORGE_DATA_ENCRYPTION_ACTIVE_KEY must be a positive integer key version");
    }
    return new LocalKeyEncryptionProvider(entries, { activeVersion });
  }

  /** Ephemeral single-process key. Development/test only: nothing encrypted with it survives a restart. */
  static ephemeral(): LocalKeyEncryptionProvider {
    return new LocalKeyEncryptionProvider([{ version: 1, key: randomBytes(KEK_BYTES) }]);
  }

  wrapKey(dek: Buffer, aad: Buffer): WrappedKey {
    const key = this.keys.get(this.activeKeyVersion)!;
    const nonce = randomBytes(WRAP_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: WRAP_TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { keyVersion: this.activeKeyVersion, blob: Buffer.concat([nonce, ciphertext, tag]) };
  }

  unwrapKey(wrapped: WrappedKey, aad: Buffer): Buffer {
    const key = this.keys.get(wrapped.keyVersion);
    if (!key) throw new KeyProviderError("KEY_VERSION_UNKNOWN", `Key version ${wrapped.keyVersion} is not available to this process`);
    if (wrapped.blob.length !== WRAP_NONCE_BYTES + KEK_BYTES + WRAP_TAG_BYTES) {
      throw new KeyProviderError("KEY_UNWRAP_FAILED", "Wrapped key has an invalid length");
    }
    const nonce = wrapped.blob.subarray(0, WRAP_NONCE_BYTES);
    const ciphertext = wrapped.blob.subarray(WRAP_NONCE_BYTES, WRAP_NONCE_BYTES + KEK_BYTES);
    const tag = wrapped.blob.subarray(WRAP_NONCE_BYTES + KEK_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: WRAP_TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new KeyProviderError("KEY_UNWRAP_FAILED", "Wrapped key failed authentication");
    }
  }

  /** Constant-time check used by rotation tooling to confirm two rings share a version's material. */
  sharesKeyMaterial(version: number, other: LocalKeyEncryptionProvider): boolean {
    const a = this.keys.get(version);
    const b = other.keys.get(version);
    return Boolean(a && b && a.length === b.length && timingSafeEqual(a, b));
  }
}
