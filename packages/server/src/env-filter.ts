/**
 * The child-process environment filter now lives in `@codeforge/secrets` so every package that
 * spawns a subprocess (server, context packing, repository intelligence) applies the same policy.
 * This module is kept as a re-export for existing server-internal imports.
 */
export { filterEnv, getSanitizedEnvForChild, isSensitiveEnvKey, KNOWN_SENSITIVE_KEYS } from "@codeforge/secrets";
