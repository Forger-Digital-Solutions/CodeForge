import crypto from "node:crypto";

/**
 * FG-1D canonical content-addressable cache identity.
 *
 * Identity is content-first: structured, hashed, and versioned. A filename, mtime, commit
 * SHA, prompt text, or model name alone is never a valid key. The key digest is a pure
 * function of the identity so identical semantically relevant inputs always collide (hit)
 * and any change to a semantically relevant input diverges (miss).
 *
 * The namespace field is the security boundary: entries are stored and looked up per
 * namespace and a namespace can never read another namespace's entries, so one workspace
 * (or tenant) cannot infer another's repository existence, cache hits, file names, symbols,
 * or prompts.
 */

export const FORGE_GREEN_CACHE_SCHEMA_VERSION = "fg1-1";

export interface CanonicalCacheIdentity {
  /** Security namespace (e.g. repository workspace fingerprint). Mandatory. */
  namespace: string;
  /** Analysis type, e.g. "repo_file_summary" or "context_assembly_v1". Mandatory. */
  analysis: string;
  /** Canonical parameters of the analysis (sorted stable JSON). */
  parameters?: Record<string, unknown>;
  /** Content hashes of every semantically relevant input artifact. */
  contentHashes?: string[];
  /** Scope digest: repository generation, dependency-context digest, or index-state digest. */
  scopeDigest?: string;
  /** Parser/analyzer version when output depends on one. */
  parserVersion?: string;
  /** Policy version when output depends on one. */
  policyVersion?: string;
  /** Provider/model/version when output depends on a model. */
  model?: string;
  /** Relevant runtime configuration digest. */
  runtimeConfigDigest?: string;
  /** Repository Intelligence generation the analysis was based on. */
  repositoryGeneration?: number;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function canonicalCacheKey(identity: CanonicalCacheIdentity): string {
  if (!identity.namespace || !identity.analysis) {
    throw new Error("Canonical cache identity requires a security namespace and an analysis type");
  }
  const canonical = {
    schemaVersion: FORGE_GREEN_CACHE_SCHEMA_VERSION,
    namespace: identity.namespace,
    analysis: identity.analysis,
    parameters: identity.parameters ?? {},
    contentHashes: [...(identity.contentHashes ?? [])].sort(),
    scopeDigest: identity.scopeDigest ?? "",
    parserVersion: identity.parserVersion ?? "",
    policyVersion: identity.policyVersion ?? "",
    model: identity.model ?? "",
    runtimeConfigDigest: identity.runtimeConfigDigest ?? "",
    repositoryGeneration: identity.repositoryGeneration ?? -1,
  };
  return crypto.createHash("sha256").update(stableJson(canonical)).digest("hex");
}
