/**
 * FG-3B progressive context resolution levels.
 *
 * `ContextLevel` expresses information BREADTH ONLY — how much of the repository/runtime the
 * model has been offered, from the always-present runtime kernel (L0) up to exceptional broad
 * expansion (L7). It is a branded type deliberately kept structurally distinct from any
 * trust/authority signal:
 *
 *   - It is NOT `AnalysisCompleteness` (`@codeforge/repo-intelligence`): a page can be at L2
 *     (structural neighbors) and still be `PARTIAL`; a page can be at L0 and `COMPLETE`. Level
 *     never upgrades or downgrades completeness, and completeness never changes level policy.
 *   - It is NOT a permission, verification, or completion decision. A higher level means more
 *     was shown to the model, never that more was verified, authorized, or approved. See
 *     `docs/forgegreen.md` §FG-3 Authority Boundaries.
 *
 * A `Brand<...>` marker (mirroring the pattern already established for
 * `AnalysisCompleteness`/`RetrievalScore` in `@codeforge/repo-intelligence`) prevents a bare
 * string from being accidentally accepted as a level.
 */

declare const __contextLevelBrand: unique symbol;
type LevelLiteral = "L0" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7";
export type ContextLevel = LevelLiteral & { readonly [__contextLevelBrand]: "ContextLevel" };

export function asContextLevel(level: LevelLiteral): ContextLevel {
  return level as ContextLevel;
}

export const CONTEXT_LEVELS: readonly ContextLevel[] = (
  ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"] as const
).map(asContextLevel);

/** Human-readable meaning of each level, matching the FG-3 brief's L0-L7 semantics verbatim. */
export const CONTEXT_LEVEL_DESCRIPTIONS: Readonly<Record<ContextLevel, string>> = {
  [asContextLevel("L0")]: "Runtime Kernel — objective, plan/step, changed files, constraints, approval/question/steer/verification state.",
  [asContextLevel("L1")]: "Active Targets — current file, current symbol, currently relevant diagnostic, direct tool result.",
  [asContextLevel("L2")]: "Structural Neighbors — definition, direct imports, direct callers/callees, relevant tests.",
  [asContextLevel("L3")]: "One-Hop Dependency Context — direct dependents, direct dependencies, barrel/re-export relationships, package ownership.",
  [asContextLevel("L4")]: "Targeted Source Bodies — specific file excerpts, specific symbol bodies, specific test bodies.",
  [asContextLevel("L5")]: "Package / Module Context — local package architecture, module interfaces, selected configuration.",
  [asContextLevel("L6")]: "Broader Repository Search — cross-package search, broader symbol candidates, larger dependency exploration.",
  [asContextLevel("L7")]: "Exceptional Broad Expansion — multiple full files, broad subsystem context, large contextual reconstruction. Never the default.",
};

function indexOf(level: ContextLevel): number {
  return CONTEXT_LEVELS.indexOf(level);
}

export function contextLevelAtLeast(level: ContextLevel, minimum: ContextLevel): boolean {
  return indexOf(level) >= indexOf(minimum);
}

/** The highest of two levels — used when merging receipts from multiple retrieval steps. */
export function maxContextLevel(a: ContextLevel, b: ContextLevel): ContextLevel {
  return indexOf(a) >= indexOf(b) ? a : b;
}

export function nextContextLevel(level: ContextLevel): ContextLevel | undefined {
  const next = CONTEXT_LEVELS[indexOf(level) + 1];
  return next;
}
