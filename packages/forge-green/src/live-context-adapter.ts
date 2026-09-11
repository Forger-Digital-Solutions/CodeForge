import type { RepositoryIntelligence } from "@codeforge/repo-intelligence";
import type { ContextComparisonPopulation } from "./sustainability-types.js";

/**
 * FG-8R: Baseline B's live eligible-context-population source (closes the "no automatic
 * ContextComparisonPopulation source in live runs" gap). This is a thin, bounded read-model over
 * `RepositoryIntelligence`'s ALREADY-COMPUTED, ALREADY-PERSISTED facts — it never re-indexes,
 * re-parses, or duplicates any part of the context/repository-intelligence engine.
 *
 * Two existing read APIs are composed:
 *  - `getCompleteness()` — a single cheap query giving `analyzableFiles` (eligible) vs
 *    `skippedFiles` (excluded; binary/too-large/generated/sensitive, NOT reason-coded — no
 *    aggregate breakdown by reason exists anywhere in repo-intelligence today, confirmed by
 *    direct investigation, so this adapter is honest about that limitation rather than inventing
 *    a false reason split).
 *  - `listFiles({ limit: cap })` — ONE bounded page. `QueryPage.truncated` tells us, without a
 *    second call, whether that single bounded page actually covered every eligible file:
 *      - `truncated === false`: the repo fit inside the cap. We have a REAL, exact sum of every
 *        eligible file's byte size (never a sample, never an extrapolation) and a REAL
 *        binary/generated/sensitive breakdown for the population we actually saw.
 *      - `truncated === true`: the repo is larger than the cap. Rather than sum a partial page
 *        and present it as "naive full-context bytes" (fake precision), we report `eligibleBytes`/
 *        `naivePolicyBytes` as `undefined` — no baseline is computed from an undercount.
 *
 * Never persists file paths, contents, or any other file-identifying string beyond counts.
 */
export const LIVE_CONTEXT_POPULATION_POLICY_VERSION = "fg8r-live-context-population-1";

/** Bounded page size for the exact-sum path. Chosen to cover CodeForge's own repo and
 * similarly-sized workspaces in one call; larger workspaces honestly report bytes unavailable
 * rather than paying for (or approximating from) a full-repository file-size scan. */
export const DEFAULT_LIVE_CONTEXT_POPULATION_CAP = 5000;

export interface LiveContextPopulationOptions {
  cap?: number;
  /** The run's actually-measured transmitted context, when known (e.g.
   * `AgentContextMetrics.contextBytes`/`.estimatedInputTokens`) — merged into the returned
   * population. The adapter itself only knows about the repository, never about one run's
   * transmitted context. */
  actualTransmittedBytes?: number;
  actualTransmittedTokens?: number;
}

/** Never throws: a query failure or an intelligence instance in a non-ready state degrades to
 * `undefined` (no Baseline B claim), exactly like every other FG-8 "unavailable" path. */
export async function computeLiveContextPopulation(
  intelligence: RepositoryIntelligence | undefined,
  options: LiveContextPopulationOptions = {},
): Promise<ContextComparisonPopulation | undefined> {
  if (!intelligence) return undefined;
  const cap = Math.max(1, options.cap ?? DEFAULT_LIVE_CONTEXT_POPULATION_CAP);
  const actualTransmittedBytes = typeof options.actualTransmittedBytes === "number" ? options.actualTransmittedBytes : undefined;
  const actualTransmittedTokens = typeof options.actualTransmittedTokens === "number" ? options.actualTransmittedTokens : undefined;
  try {
    const completeness = await intelligence.getCompleteness();
    const eligibleFileCount = completeness.analyzableFiles;
    const excludedFileCount = completeness.skippedFiles;
    if (eligibleFileCount <= 0 && excludedFileCount <= 0) return undefined;

    const page = await intelligence.listFiles({ limit: cap });

    if (page.truncated) {
      return {
        fullContextDefinition:
          "All files indexed by RepositoryIntelligence (git-tracked, non-ignored, outside node_modules/dist/build/.git/etc.) at the workspace's current content generation, split into analyzable (parsed/fallback/error) vs skipped (binary/too-large/generated/sensitive — repo-intelligence does not expose a per-reason breakdown of skipped files). This workspace exceeds the bounded single-page cap, so exact eligible/naive byte totals are NOT computed (never approximated from a partial page).",
        eligibleFileCount,
        excludedFileCount,
        exclusionReasons: { skipped_unspecified_reason: excludedFileCount },
        eligibleBytes: undefined,
        eligibleTokensEstimate: undefined,
        actualTransmittedBytes,
        actualTransmittedTokens,
        naivePolicyBytes: undefined,
        naivePolicyTokens: undefined,
      };
    }

    let binaryCount = 0;
    let generatedCount = 0;
    let sensitiveCount = 0;
    let eligibleBytesSum = 0;
    for (const file of page.items) {
      if (file.parserStatus !== "skipped") eligibleBytesSum += file.size;
      if (file.binary) binaryCount += 1;
      if (file.generated) generatedCount += 1;
      if (file.sensitive) sensitiveCount += 1;
    }

    return {
      fullContextDefinition:
        "All files indexed by RepositoryIntelligence (git-tracked, non-ignored, outside node_modules/dist/build/.git/etc.) at the workspace's current content generation, split into analyzable (parsed/fallback/error) vs skipped (binary/too-large/generated/sensitive). Eligible bytes are an EXACT sum over every indexed file's stored size (not a sample) because this workspace fit inside one bounded query page.",
      eligibleFileCount,
      excludedFileCount,
      exclusionReasons: {
        binary: binaryCount,
        generated: generatedCount,
        sensitive: sensitiveCount,
      },
      eligibleBytes: eligibleBytesSum,
      eligibleTokensEstimate: undefined,
      actualTransmittedBytes,
      actualTransmittedTokens,
      naivePolicyBytes: eligibleBytesSum,
      naivePolicyTokens: undefined,
    };
  } catch {
    return undefined;
  }
}
