import { describe, expect, it } from "vitest";
import {
  createOwnerScopedCredentialResolver,
  isSealedCredential,
  isUserApiCredentialRef,
  maskCredentialForDisplay,
  migrateLegacyPlaintextCredentials,
  openCredential,
  sealCredential,
  type SafeStorageLike,
} from "../src/secure-credential-codec.js";

// Obviously fake fixture secrets. Never real credentials.
const FIXTURE_KEY = "CF_TEST_SECRET_DO_NOT_USE_desktop_9c1f2e";
const FIXTURE_TOKEN = "cfr_CF_TEST_SECRET_DO_NOT_USE_refresh_0a1b2c3d4e";

/** Deterministic stand-in for Electron safeStorage: reversible XOR so tampering is observable. */
function fakeSafeStorage(available = true): SafeStorageLike {
  const mask = 0x5a;
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, "utf8").map((b) => b ^ mask)),
    decryptString: (buf) => {
      if (buf.length < 4) throw new Error("DPAPI: invalid blob");
      return Buffer.from(buf.map((b) => b ^ mask)).toString("utf8");
    },
  };
}

describe("desktop secure credential codec (Security R1)", () => {
  it("seals and opens a credential through OS-backed storage", () => {
    const storage = fakeSafeStorage();
    const sealed = sealCredential(storage, FIXTURE_KEY);
    expect(isSealedCredential(sealed)).toBe(true);
    expect(sealed).not.toContain(FIXTURE_KEY);
    expect(openCredential(storage, sealed)).toBe(FIXTURE_KEY);
  });

  it("NEVER returns a legacy plaintext value as a usable credential (legacy read path closed)", () => {
    const storage = fakeSafeStorage();
    expect(openCredential(storage, FIXTURE_KEY)).toBeUndefined();
    expect(openCredential(storage, "")).toBeUndefined();
    expect(openCredential(storage, "enc:")).toBeUndefined();
    expect(openCredential(storage, 42)).toBeUndefined();
    expect(openCredential(storage, null)).toBeUndefined();
  });

  it("fails closed on a corrupt or foreign sealed payload", () => {
    const storage = fakeSafeStorage();
    expect(openCredential(storage, "enc:not-valid-encrypted-data")).not.toBe(FIXTURE_KEY);
    expect(openCredential(storage, "enc:AA==")).toBeUndefined();
  });

  it("refuses to seal — and persists nothing — when secure storage is unavailable", () => {
    const storage = fakeSafeStorage(false);
    expect(() => sealCredential(storage, FIXTURE_KEY)).toThrow(/Secure credential storage is unavailable/);
    // Even a previously sealed value is not opened without the backend; plaintext is never a fallback.
    const sealed = sealCredential(fakeSafeStorage(true), FIXTURE_KEY);
    expect(openCredential(storage, sealed)).toBeUndefined();
  });

  it("migrates legacy plaintext in place, idempotently, without touching sealed values", () => {
    const storage = fakeSafeStorage();
    const alreadySealed = sealCredential(storage, "CF_TEST_SECRET_DO_NOT_USE_sealed");
    const credentials: Record<string, unknown> = {
      openrouter: FIXTURE_KEY,
      groq: alreadySealed,
      "codeforge:cloud-refresh-token": FIXTURE_TOKEN,
      ignored: 7,
    };
    const first = migrateLegacyPlaintextCredentials(storage, credentials);
    expect(first).toEqual({ sealed: ["openrouter", "codeforge:cloud-refresh-token"], blocked: [] });
    expect(credentials.groq).toBe(alreadySealed);
    expect(isSealedCredential(credentials.openrouter)).toBe(true);
    expect(openCredential(storage, credentials.openrouter)).toBe(FIXTURE_KEY);
    expect(JSON.stringify(credentials)).not.toContain(FIXTURE_KEY);
    expect(JSON.stringify(credentials)).not.toContain(FIXTURE_TOKEN);

    const second = migrateLegacyPlaintextCredentials(storage, credentials);
    expect(second).toEqual({ sealed: [], blocked: [] });
  });

  it("does not destroy plaintext it cannot seal, and reports it as blocked", () => {
    const storage = fakeSafeStorage(false);
    const credentials: Record<string, unknown> = { openrouter: FIXTURE_KEY };
    const result = migrateLegacyPlaintextCredentials(storage, credentials);
    expect(result).toEqual({ sealed: [], blocked: ["openrouter"] });
    expect(credentials.openrouter).toBe(FIXTURE_KEY);
    // ...and it is still not usable.
    expect(openCredential(storage, credentials.openrouter)).toBeUndefined();
  });

  it("honours the key allowlist during migration", () => {
    const storage = fakeSafeStorage();
    const credentials: Record<string, unknown> = { openrouter: FIXTURE_KEY, __proto__polluted: FIXTURE_KEY };
    const result = migrateLegacyPlaintextCredentials(storage, credentials, (key) => key === "openrouter");
    expect(result.sealed).toEqual(["openrouter"]);
    expect(credentials.__proto__polluted).toBe(FIXTURE_KEY);
  });

  it("masks credentials for display without revealing them", () => {
    expect(maskCredentialForDisplay("sk-or-v1-abcdefghijklmnop7F2A")).toBe("sk-…7F2A");
    expect(maskCredentialForDisplay("short")).toBe("••••");
  });

  it("accepts only deterministic user-api credential refs as storage keys", () => {
    expect(isUserApiCredentialRef("user-api-credential:0123456789abcdef01234567")).toBe(true);
    expect(isUserApiCredentialRef("user-api-credential:0123456789abcdef0123456")).toBe(false);
    expect(isUserApiCredentialRef("user-api-credential:0123456789abcdef012345678")).toBe(false);
    expect(isUserApiCredentialRef("user-api-credential:0123456789abcdef0123456g")).toBe(false);
    expect(isUserApiCredentialRef("user-api-credential:")).toBe(false);
    expect(isUserApiCredentialRef("user-api-credential:sk-live-key")).toBe(false);
    expect(isUserApiCredentialRef("user-api-credential:0123456789ABCDEF01234567")).toBe(false);
    expect(isUserApiCredentialRef(" openrouter")).toBe(false);
    expect(isUserApiCredentialRef("user-api-credential:0123456789abcdef01234567:extra")).toBe(false);
  });

  it("resolves user-api credentials only for the connected owner scope", () => {
    const store = new Map<string, string>([["user-api-credential:0123456789abcdef01234567", FIXTURE_KEY]]);
    const resolver = createOwnerScopedCredentialResolver(() => "alice", (ref) => store.get(ref));

    expect(resolver.get("alice", "user-api-credential:0123456789abcdef01234567")).toBe(FIXTURE_KEY);
    // A different owner identity can never touch this host's sealed value.
    expect(resolver.get("bob", "user-api-credential:0123456789abcdef01234567")).toBeUndefined();
    // Non-ref key shapes never reach the store.
    expect(resolver.get("alice", "openrouter")).toBeUndefined();
    expect(resolver.get("alice", "user-api-credential:not-hex")).toBeUndefined();
    // A deterministic ref with no stored value resolves to nothing — fail closed.
    expect(resolver.get("alice", "user-api-credential:ffffffffffffffffffffffff")).toBeUndefined();
  });
});
