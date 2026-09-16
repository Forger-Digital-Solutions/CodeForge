/**
 * Canonical model identity normalization lives in @codeforge/forge-zero (the lowest shared
 * layer) so both the registry and the 8-Bit dataset pipeline derive identity from ONE
 * authority without a dependency cycle. This module preserves model-registry's public API.
 */
export {
  canonicalIdentityFor,
  groupByCanonical,
  normalizeSlug,
  type CanonicalIdentity,
} from "@codeforge/forge-zero";
