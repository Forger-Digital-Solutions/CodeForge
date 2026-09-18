import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EnvelopeError,
  KeyProviderError,
  LocalKeyEncryptionProvider,
  SecretEnvelopeService,
  canonicalAad,
  createSecretEnvelopeService,
  describeEnvelope,
  isEnvelope,
  parseKeyRing,
} from "../src/index.js";

// Obviously fake fixture secret. Never a real credential.
const FIXTURE_SECRET = "CF_TEST_SECRET_DO_NOT_USE_7f38c1a2b9d4e5f6";
const CONTEXT = { purpose: "unit_test_secret", tenantId: "user-A", recordId: "rec-1", schema: "utf8" };

function service(seed = 1): SecretEnvelopeService {
  return new SecretEnvelopeService(new LocalKeyEncryptionProvider([{ version: seed, key: randomBytes(32) }]));
}

function flipByteInField(envelope: string, fieldIndex: number): string {
  const parts = envelope.split(".");
  const buf = Buffer.from(parts[fieldIndex]!, "base64url");
  buf[0] = (buf[0]! ^ 0x01) & 0xff;
  parts[fieldIndex] = buf.toString("base64url");
  return parts.join(".");
}

describe("SecretEnvelopeService — AES-256-GCM envelope (Phase 51 properties)", () => {
  it("1/2: encrypts and decrypts a secret round-trip", () => {
    const svc = service();
    const envelope = svc.encrypt(FIXTURE_SECRET, CONTEXT);
    expect(isEnvelope(envelope)).toBe(true);
    expect(envelope).not.toContain(FIXTURE_SECRET);
    expect(svc.decryptString(envelope, CONTEXT)).toBe(FIXTURE_SECRET);
  });

  it("3/4: identical plaintext yields different ciphertext, nonces, and wrapped DEKs every time", () => {
    const svc = service();
    const seenNonces = new Set<string>();
    const seenCiphertexts = new Set<string>();
    const seenWrapped = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const envelope = svc.encrypt(FIXTURE_SECRET, CONTEXT);
      const [, , wrapped, nonce, ciphertext] = envelope.split(".");
      seenNonces.add(nonce!);
      seenCiphertexts.add(ciphertext!);
      seenWrapped.add(wrapped!);
    }
    expect(seenNonces.size).toBe(200);
    expect(seenCiphertexts.size).toBe(200);
    expect(seenWrapped.size).toBe(200);
  });

  it("5: modifying the ciphertext fails authentication (fails closed, no partial plaintext)", () => {
    const svc = service();
    const envelope = svc.encrypt(FIXTURE_SECRET, CONTEXT);
    expect(() => svc.decrypt(flipByteInField(envelope, 4), CONTEXT)).toThrowError(EnvelopeError);
    expect(() => svc.decrypt(flipByteInField(envelope, 4), CONTEXT)).toThrow(/authentication/);
  });

  it("6: modifying the nonce fails authentication", () => {
    const svc = service();
    const envelope = svc.encrypt(FIXTURE_SECRET, CONTEXT);
    expect(() => svc.decrypt(flipByteInField(envelope, 3), CONTEXT)).toThrowError(EnvelopeError);
  });

  it("7: modifying the authentication tag fails", () => {
    const svc = service();
    const envelope = svc.encrypt(FIXTURE_SECRET, CONTEXT);
    expect(() => svc.decrypt(flipByteInField(envelope, 5), CONTEXT)).toThrowError(EnvelopeError);
  });

  it("7b: modifying the wrapped DEK fails", () => {
    const svc = service();
    const envelope = svc.encrypt(FIXTURE_SECRET, CONTEXT);
    expect(() => svc.decrypt(flipByteInField(envelope, 2), CONTEXT)).toThrowError(EnvelopeError);
  });

  it("8: the wrong key (same version number, different material) fails", () => {
    const a = service(1);
    const b = service(1);
    const envelope = a.encrypt(FIXTURE_SECRET, CONTEXT);
    expect(() => b.decrypt(envelope, CONTEXT)).toThrowError(EnvelopeError);
  });

  it("9: the wrong AAD fails — envelopes cannot move between tenants, records, or purposes", () => {
    const svc = service();
    const envelope = svc.encrypt(FIXTURE_SECRET, CONTEXT);
    expect(() => svc.decrypt(envelope, { ...CONTEXT, tenantId: "user-B" })).toThrowError(EnvelopeError);
    expect(() => svc.decrypt(envelope, { ...CONTEXT, recordId: "rec-2" })).toThrowError(EnvelopeError);
    expect(() => svc.decrypt(envelope, { ...CONTEXT, purpose: "other_purpose" })).toThrowError(EnvelopeError);
    expect(() => svc.decrypt(envelope, { purpose: CONTEXT.purpose })).toThrowError(EnvelopeError);
    expect(svc.decryptString(envelope, CONTEXT)).toBe(FIXTURE_SECRET);
  });

  it("10: key-version lookup works — previous versions decrypt, unknown versions are refused", () => {
    const k1 = { version: 1, key: randomBytes(32) };
    const k2 = { version: 2, key: randomBytes(32) };
    const old = new SecretEnvelopeService(new LocalKeyEncryptionProvider([k1]));
    const envelope = old.encrypt(FIXTURE_SECRET, CONTEXT);
    expect(describeEnvelope(envelope)).toEqual({ formatVersion: 1, algorithm: "A256GCM", kekVersion: 1 });

    const staged = new SecretEnvelopeService(new LocalKeyEncryptionProvider([k1, k2]));
    expect(staged.keyProvider.activeKeyVersion).toBe(2);
    expect(staged.decryptString(envelope, CONTEXT)).toBe(FIXTURE_SECRET);

    const retired = new SecretEnvelopeService(new LocalKeyEncryptionProvider([k2]));
    expect(() => retired.decrypt(envelope, CONTEXT)).toThrow(/not available/);
    try {
      retired.decrypt(envelope, CONTEXT);
    } catch (error) {
      expect((error as EnvelopeError).code).toBe("ENVELOPE_KEY_UNAVAILABLE");
    }
  });

  it("11: rotation re-wraps under the active key without losing the secret", () => {
    const k1 = { version: 1, key: randomBytes(32) };
    const k2 = { version: 2, key: randomBytes(32) };
    const v1 = new SecretEnvelopeService(new LocalKeyEncryptionProvider([k1]));
    const envelope = v1.encrypt(FIXTURE_SECRET, CONTEXT);

    const staged = new SecretEnvelopeService(new LocalKeyEncryptionProvider([k1, k2]));
    expect(staged.needsRotation(envelope)).toBe(true);
    const rotated = staged.rotate(envelope, CONTEXT);
    expect(rotated.rotated).toBe(true);
    expect(describeEnvelope(rotated.envelope).kekVersion).toBe(2);
    expect(staged.needsRotation(rotated.envelope)).toBe(false);
    expect(staged.rotate(rotated.envelope, CONTEXT)).toEqual({ envelope: rotated.envelope, rotated: false });

    // After v1 is retired the rotated envelope still opens; the stale one does not.
    const retired = new SecretEnvelopeService(new LocalKeyEncryptionProvider([k2]));
    expect(retired.decryptString(rotated.envelope, CONTEXT)).toBe(FIXTURE_SECRET);
    expect(() => retired.decrypt(envelope, CONTEXT)).toThrowError(EnvelopeError);
  });

  it("12: legacy migration — a plaintext value is recognisable as non-envelope and can be sealed in place", () => {
    const svc = service();
    const legacyRow = { secret: FIXTURE_SECRET };
    expect(isEnvelope(legacyRow.secret)).toBe(false);
    const migrated = isEnvelope(legacyRow.secret) ? legacyRow.secret : svc.encrypt(legacyRow.secret, CONTEXT);
    expect(isEnvelope(migrated)).toBe(true);
    // Idempotent: re-running the migration does not double-encrypt.
    const again = isEnvelope(migrated) ? migrated : svc.encrypt(migrated, CONTEXT);
    expect(again).toBe(migrated);
    expect(svc.decryptString(migrated, CONTEXT)).toBe(FIXTURE_SECRET);
  });

  it("13: corrupted or malformed envelopes fail closed", () => {
    const svc = service();
    const envelope = svc.encrypt(FIXTURE_SECRET, CONTEXT);
    const cases = [
      "",
      "not-an-envelope",
      envelope.slice(0, -4),
      envelope.replace(/^cfe1\./, "cfe9."),
      envelope.replace(/^cfe1\.1\./, "cfe1.0."),
      envelope.replace(/^cfe1\.1\./, "cfe1.x."),
      `${envelope}.extra`,
      envelope.split(".").slice(0, 5).join("."),
      envelope.replace(/\.[^.]+$/, ".!!!!"),
      FIXTURE_SECRET,
    ];
    for (const corrupted of cases) {
      expect(() => svc.decrypt(corrupted, CONTEXT), corrupted).toThrowError(EnvelopeError);
    }
  });

  it("14: plaintext is never logged or embedded in errors or metadata", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const svc = service();
      const envelope = svc.encrypt(FIXTURE_SECRET, CONTEXT);
      expect(JSON.stringify(describeEnvelope(envelope))).not.toContain(FIXTURE_SECRET);
      for (const bad of [flipByteInField(envelope, 4), "garbage"]) {
        try {
          svc.decrypt(bad, CONTEXT);
        } catch (error) {
          expect(String((error as Error).message)).not.toContain(FIXTURE_SECRET);
          expect(String((error as Error).stack ?? "")).not.toContain(FIXTURE_SECRET);
        }
      }
      const calls = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join("\n");
      expect(calls).not.toContain(FIXTURE_SECRET);
      expect(calls).toBe("");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("binds binary payloads and rejects oversized secrets", () => {
    const svc = service();
    const payload = randomBytes(1024);
    const envelope = svc.encrypt(payload, CONTEXT);
    expect(svc.decrypt(envelope, CONTEXT).equals(payload)).toBe(true);
    expect(() => svc.encrypt(Buffer.alloc(64 * 1024 + 1), CONTEXT)).toThrow(/64 KiB/);
  });

  it("requires a purpose in the binding context", () => {
    const svc = service();
    expect(() => svc.encrypt(FIXTURE_SECRET, { purpose: "" })).toThrowError(EnvelopeError);
    expect(() => canonicalAad({ purpose: "x", tenantId: "y".repeat(513) })).toThrowError(EnvelopeError);
    expect(canonicalAad({ tenantId: "t", purpose: "p", recordId: "r" }).toString("utf8")).toBe('{"purpose":"p","recordId":"r","tenantId":"t"}');
  });
});

describe("Key ring configuration", () => {
  it("parses versioned base64/base64url/hex 32-byte keys and passphrase material", () => {
    const b64 = randomBytes(32).toString("base64");
    const b64url = randomBytes(32).toString("base64url");
    const hex = randomBytes(32).toString("hex");
    const ring = parseKeyRing(`3:${b64}, 2:${b64url},1:${hex}`);
    expect(ring.map((e) => e.version)).toEqual([3, 2, 1]);
    for (const entry of ring) expect(entry.key.length).toBe(32);

    const passphrase = parseKeyRing("this-is-a-long-random-render-generated-value-0123456789");
    expect(passphrase).toHaveLength(1);
    expect(passphrase[0]!.version).toBe(1);
    expect(passphrase[0]!.key.length).toBe(32);
  });

  it("refuses short, placeholder, duplicate, and unversioned multi-entry material", () => {
    expect(() => parseKeyRing("short")).toThrowError(KeyProviderError);
    expect(() => parseKeyRing("password-password-password-password-1")).toThrowError(KeyProviderError);
    expect(() => parseKeyRing("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toThrowError(KeyProviderError);
    const k = randomBytes(32).toString("base64");
    expect(() => parseKeyRing(`1:${k},1:${k}`)).toThrowError(KeyProviderError);
    expect(() => parseKeyRing(`${k},${k}`)).toThrowError(KeyProviderError);
    expect(() => parseKeyRing("")).toThrowError(KeyProviderError);
  });

  it("selects the active version explicitly or defaults to the highest", () => {
    const k1 = randomBytes(32).toString("base64");
    const k2 = randomBytes(32).toString("base64");
    const defaulted = LocalKeyEncryptionProvider.fromEnvironment({ CODEFORGE_DATA_ENCRYPTION_KEYS: `1:${k1},2:${k2}` });
    expect(defaulted.activeKeyVersion).toBe(2);
    const pinned = LocalKeyEncryptionProvider.fromEnvironment({ CODEFORGE_DATA_ENCRYPTION_KEYS: `1:${k1},2:${k2}`, CODEFORGE_DATA_ENCRYPTION_ACTIVE_KEY: "1" });
    expect(pinned.activeKeyVersion).toBe(1);
    expect(() => LocalKeyEncryptionProvider.fromEnvironment({ CODEFORGE_DATA_ENCRYPTION_KEYS: `1:${k1}`, CODEFORGE_DATA_ENCRYPTION_ACTIVE_KEY: "7" })).toThrowError(KeyProviderError);
  });

  it("runtime factory fails closed in staging/production without keys and is ephemeral only in development", () => {
    expect(() => createSecretEnvelopeService({ environment: "production", env: {} })).toThrow(/CODEFORGE_DATA_ENCRYPTION_KEYS is required/);
    expect(() => createSecretEnvelopeService({ environment: "staging", env: {} })).toThrow(/CODEFORGE_DATA_ENCRYPTION_KEYS is required/);
    const dev = createSecretEnvelopeService({ environment: "development", env: {} });
    expect(dev.ephemeral).toBe(true);
    expect(dev.describe()).toContain("EPHEMERAL");
    const configured = createSecretEnvelopeService({ environment: "production", env: { CODEFORGE_DATA_ENCRYPTION_KEYS: randomBytes(32).toString("base64") } });
    expect(configured.ephemeral).toBe(false);
    expect(configured.describe()).toBe("secretEnvelope=local-kek activeKey=v1 knownKeys=[v1]");
  });
});
