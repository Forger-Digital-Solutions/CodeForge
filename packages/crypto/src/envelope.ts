import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KeyProviderError, type KeyEncryptionProvider } from "./key-provider.js";

/**
 * CodeForge secret envelope, format version 1.
 *
 * Wire form (a single opaque string, safe for TEXT/VARCHAR columns and JSON):
 *
 *   cfe1.<kekVersion>.<wrappedDek>.<nonce>.<ciphertext>.<tag>
 *
 * where every field after the version is base64url. Cryptographic construction:
 *
 *   DEK        = 32 random bytes (fresh per encryption — never reused across records or rewrites)
 *   nonce      = 12 random bytes from the CSPRNG (fresh per encryption)
 *   ciphertext || tag = AES-256-GCM(DEK, nonce, plaintext, aad = canonicalAad(context))
 *   wrappedDek = KeyEncryptionProvider.wrapKey(DEK, aad)   (KEK-versioned; see key-provider.ts)
 *
 * The associated data binds the ciphertext to an immutable context — the purpose of the secret and
 * the identifiers of the record and tenant it belongs to — so an envelope copied between rows, users
 * or purposes fails authentication instead of decrypting. Decryption fails closed on any
 * tampering: a flipped bit anywhere in the nonce, ciphertext, tag, wrapped DEK, version, or AAD
 * produces an {@link EnvelopeError}, never partial plaintext.
 */
export const ENVELOPE_PREFIX = "cfe1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
const MAX_PLAINTEXT_BYTES = 64 * 1024;

/** Immutable binding context. Every field participates in the AAD in canonical order. */
export interface EnvelopeContext {
  /** What kind of secret this is, e.g. `github_pkce_verifier`. Required. */
  purpose: string;
  /** Owning tenant/user identifier, when the secret belongs to one. */
  tenantId?: string;
  /** Identifier of the row/record the secret is stored in. */
  recordId?: string;
  /** Schema/format hint for the plaintext, so a decoder cannot be confused across formats. */
  schema?: string;
}

export interface EnvelopeMetadata {
  formatVersion: 1;
  algorithm: "A256GCM";
  kekVersion: number;
}

export class EnvelopeError extends Error {
  constructor(
    readonly code: "ENVELOPE_MALFORMED" | "ENVELOPE_AUTH_FAILED" | "ENVELOPE_CONTEXT_INVALID" | "ENVELOPE_PLAINTEXT_TOO_LARGE" | "ENVELOPE_KEY_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** Canonical, order-independent AAD serialization. Keys sorted, undefined omitted, no whitespace. */
export function canonicalAad(context: EnvelopeContext): Buffer {
  if (!context || typeof context.purpose !== "string" || context.purpose.length === 0 || context.purpose.length > 128) {
    throw new EnvelopeError("ENVELOPE_CONTEXT_INVALID", "Envelope context requires a non-empty purpose");
  }
  const entries: Array<[string, string]> = [];
  for (const key of ["purpose", "recordId", "schema", "tenantId"] as const) {
    const value = context[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 512) throw new EnvelopeError("ENVELOPE_CONTEXT_INVALID", `Envelope context field ${key} is invalid`);
    entries.push([key, value]);
  }
  return Buffer.from(JSON.stringify(Object.fromEntries(entries)), "utf8");
}

export function isEnvelope(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${ENVELOPE_PREFIX}.`);
}

function b64(buf: Buffer): string {
  return buf.toString("base64url");
}

function unb64(field: string, name: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(field)) throw new EnvelopeError("ENVELOPE_MALFORMED", `Envelope field ${name} is not base64url`);
  return Buffer.from(field, "base64url");
}

/**
 * Parse only the non-secret metadata of an envelope. Safe to log/report: it exposes the format
 * and KEK version and nothing else.
 */
export function describeEnvelope(value: string): EnvelopeMetadata {
  const parts = value.split(".");
  if (parts.length !== 6 || parts[0] !== ENVELOPE_PREFIX) throw new EnvelopeError("ENVELOPE_MALFORMED", "Not a CodeForge secret envelope");
  const kekVersion = Number(parts[1]);
  if (!/^\d{1,6}$/.test(parts[1]!) || !Number.isInteger(kekVersion) || kekVersion <= 0) {
    throw new EnvelopeError("ENVELOPE_MALFORMED", "Envelope key version is invalid");
  }
  return { formatVersion: 1, algorithm: "A256GCM", kekVersion };
}

export class SecretEnvelopeService {
  constructor(private readonly keys: KeyEncryptionProvider) {}

  get keyProvider(): KeyEncryptionProvider {
    return this.keys;
  }

  encrypt(plaintext: string | Buffer, context: EnvelopeContext): string {
    const aad = canonicalAad(context);
    const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
    if (data.length > MAX_PLAINTEXT_BYTES) throw new EnvelopeError("ENVELOPE_PLAINTEXT_TOO_LARGE", "Secret exceeds the 64 KiB envelope limit");
    const dek = randomBytes(DEK_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    try {
      const cipher = createCipheriv("aes-256-gcm", dek, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
      const tag = cipher.getAuthTag();
      const wrapped = this.keys.wrapKey(dek, aad);
      return [ENVELOPE_PREFIX, String(wrapped.keyVersion), b64(wrapped.blob), b64(nonce), b64(ciphertext), b64(tag)].join(".");
    } finally {
      dek.fill(0);
    }
  }

  decrypt(envelope: string, context: EnvelopeContext): Buffer {
    const aad = canonicalAad(context);
    const meta = describeEnvelope(envelope);
    const parts = envelope.split(".");
    const wrappedBlob = unb64(parts[2]!, "wrappedDek");
    const nonce = unb64(parts[3]!, "nonce");
    const ciphertext = unb64(parts[4]!, "ciphertext");
    const tag = unb64(parts[5]!, "tag");
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new EnvelopeError("ENVELOPE_MALFORMED", "Envelope nonce or tag has an invalid length");

    let dek: Buffer;
    try {
      dek = this.keys.unwrapKey({ keyVersion: meta.kekVersion, blob: wrappedBlob }, aad);
    } catch (error) {
      if (error instanceof KeyProviderError && error.code === "KEY_VERSION_UNKNOWN") {
        throw new EnvelopeError("ENVELOPE_KEY_UNAVAILABLE", error.message);
      }
      throw new EnvelopeError("ENVELOPE_AUTH_FAILED", "Envelope key unwrap failed authentication");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", dek, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new EnvelopeError("ENVELOPE_AUTH_FAILED", "Envelope failed authentication");
    } finally {
      dek.fill(0);
    }
  }

  decryptString(envelope: string, context: EnvelopeContext): string {
    return this.decrypt(envelope, context).toString("utf8");
  }

  /** True when the envelope is wrapped under a KEK version other than the active one. */
  needsRotation(envelope: string): boolean {
    return describeEnvelope(envelope).kekVersion !== this.keys.activeKeyVersion;
  }

  /**
   * Re-encrypt under the active KEK. The plaintext is decrypted with whichever (still known)
   * previous version wrapped it and immediately re-encrypted with a fresh DEK and nonce; the
   * plaintext never leaves this call. Returns the same envelope when it is already current.
   */
  rotate(envelope: string, context: EnvelopeContext): { envelope: string; rotated: boolean } {
    if (!this.needsRotation(envelope)) return { envelope, rotated: false };
    const plaintext = this.decrypt(envelope, context);
    try {
      return { envelope: this.encrypt(plaintext, context), rotated: true };
    } finally {
      plaintext.fill(0);
    }
  }
}
