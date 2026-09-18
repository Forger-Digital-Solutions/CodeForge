import { SecretEnvelopeService } from "./envelope.js";
import { KeyProviderError, LocalKeyEncryptionProvider, type KeyEncryptionProvider } from "./key-provider.js";

export interface SecretEnvelopeRuntimeOptions {
  env?: Record<string, string | undefined>;
  /** `staging`/`production` REQUIRE configured key material; `development` may fall back to an ephemeral key. */
  environment: "development" | "staging" | "production";
  /** Inject a provider directly (tests, or a future KMS-backed provider). Overrides env parsing. */
  provider?: KeyEncryptionProvider;
}

export interface SecretEnvelopeRuntime {
  service: SecretEnvelopeService;
  /** Safe-to-log description: provider kind, active version, known versions. No key material. */
  describe(): string;
  /** True when this process is using an ephemeral key that will not survive a restart. */
  ephemeral: boolean;
}

/**
 * Build the process-wide envelope service from configuration, failing closed exactly like the
 * rest of the Cloud config: a staging/production process without `CODEFORGE_DATA_ENCRYPTION_KEYS`
 * does not start. Development without keys uses an ephemeral in-memory KEK (short-lived secrets
 * such as OAuth transactions still work within one process; nothing persisted under it is
 * decryptable after a restart, which is what a development fallback should look like — never a
 * hard-coded or predictable key).
 */
export function createSecretEnvelopeService(options: SecretEnvelopeRuntimeOptions): SecretEnvelopeRuntime {
  const env = options.env ?? process.env;
  let provider: KeyEncryptionProvider;
  let ephemeral = false;
  if (options.provider) {
    provider = options.provider;
  } else if (env.CODEFORGE_DATA_ENCRYPTION_KEYS) {
    provider = LocalKeyEncryptionProvider.fromEnvironment(env);
  } else if (options.environment === "development") {
    provider = LocalKeyEncryptionProvider.ephemeral();
    ephemeral = true;
  } else {
    throw new KeyProviderError(
      "KEY_CONFIG_INVALID",
      "CODEFORGE_DATA_ENCRYPTION_KEYS is required in staging/production (32 random bytes, base64; see docs/security/key-management-and-rotation.md).",
    );
  }
  const service = new SecretEnvelopeService(provider);
  return {
    service,
    ephemeral,
    describe: () => `secretEnvelope=${provider.kind} activeKey=v${provider.activeKeyVersion} knownKeys=[${provider.knownKeyVersions.map((v) => `v${v}`).join(",")}]${ephemeral ? " (EPHEMERAL — development only)" : ""}`,
  };
}
