import type { RepositoryIntelligence } from "@codeforge/repo-intelligence";
import { asContextLevel, contextLevelAtLeast, type ContextLevel } from "./levels.js";
import { renderContextKernel, type ContextKernel } from "./kernel.js";
import { buildContextPack, estimateTokens, sha256, type ContextChunk, type ContextReceipt } from "./pack.js";
import {
  buildDependencyNeighborhoodPage,
  type ContextPage,
  type ContextPageId,
  type ContextPageStore,
  type DependencyNeighborhoodData,
  ONE_HOP_MAX_EDGES,
} from "./pages.js";
import { ContextCapacityError, type ContextCapacity } from "./budget.js";

/**
 * FG-3 Context Planner.
 *
 * Implements "start narrow, expand when evidence or the task requires it" (FG-3 §3/§14):
 * `planNarrow` always includes the L0 kernel, then adds a SMALL, bounded L1 slice of directly
 * relevant/mentioned targets (never the eager broad grab `buildContextPack`'s own default
 * performs when called directly with no candidate cap — that remains available, unchanged, as
 * the explicit `repo_context` pull tool for when a caller genuinely wants a broad pack).
 * Selection ranking itself is deterministic structural retrieval (FG-2's `findRelevantContext`
 * plus content-hash/graph-generation-scoped Context Pages) — no LLM is the first-stage
 * selector (§54).
 *
 * `ContextLevel` on the result describes breadth only; it carries no verification, permission,
 * or completion authority (see `levels.ts`).
 */

const NARROW_CANDIDATE_LIMIT = 6;
const MAX_PREFETCH_TARGETS = 3;

export interface ContextPlanRequest {
  goal: string;
  kernel: ContextKernel;
  capacity: ContextCapacity;
  intelligence?: RepositoryIntelligence;
  mentionedPaths?: string[];
  pageStore?: ContextPageStore;
  /** Override for tests only; production callers should rely on the default. */
  narrowCandidateLimit?: number;
  /** Advisory breadth requested by FG-4; capacity remains authoritative for delivery. */
  minimumLevel?: ContextLevel;
}

export interface ContextPlanSection {
  title: string;
  content: string;
  level: ContextLevel;
  reasons: string[];
}

export interface ProgressiveContextReceipt extends ContextReceipt {
  level: ContextLevel;
  capacitySource: ContextCapacity["source"];
  pagesReused: number;
  pagesPulled: number;
  omittedOptionalPages: number;
}

export interface ContextPlanResult {
  level: ContextLevel;
  sections: ContextPlanSection[];
  prompt: string;
  selectedFiles: string[];
  /** Raw per-chunk provenance for the L1 active-target selection, so callers that want
   * file/symbol-level evidence entries (matching the granularity `buildContextPack` callers
   * already rely on) do not need to re-parse the rendered section text. */
  activeTargetChunks: ContextChunk[];
  pagesReused: ContextPageId[];
  pagesPulled: ContextPageId[];
  tokenEstimate: number;
  truncated: boolean;
  capacity: ContextCapacity;
  receipt: ProgressiveContextReceipt;
}

function sectionTokens(sections: ContextPlanSection[]): number {
  return sections.reduce((sum, section) => sum + estimateTokens(section.content), 0);
}

function renderDependencyNeighborhood(page: ContextPage<DependencyNeighborhoodData>): string {
  const { data } = page;
  const lines = [`Structural neighbors of ${data.path}:`];
  if (data.dependencies.length > 0) {
    lines.push(
      `Direct dependencies: ${data.dependencies.map((edge) => `${edge.targetPath ?? edge.specifier ?? "?"} (${edge.provenance})`).join(", ")}${data.dependenciesTruncated ? " [more not shown]" : ""}`,
    );
  }
  if (data.dependents.length > 0) {
    lines.push(
      `Direct dependents: ${data.dependents.map((edge) => `${edge.sourcePath} (${edge.provenance})`).join(", ")}${data.dependentsTruncated ? " [more not shown]" : ""}`,
    );
  }
  if (data.relatedTests.length > 0) {
    lines.push(
      `Candidate related tests: ${data.relatedTests.map((test) => `${test.path} (${test.reasons.join(",")})`).join(", ")}${data.testsTruncated ? " [more not shown]" : ""}`,
    );
  }
  const uncertainEdges = page.provenance.edgeProvenance?.filter((p) => p === "heuristic" || p === "unresolved").length ?? 0;
  if (uncertainEdges > 0 || data.dependenciesTruncated || data.dependentsTruncated || data.testsTruncated) {
    lines.push(
      `Note: bounded one-hop view (max ${ONE_HOP_MAX_EDGES} each, some edges heuristic/unresolved/omitted) — call repo_dependencies/repo_dependents/repo_tests directly for the full picture.`,
    );
  }
  return lines.join("\n");
}

interface PrefetchOutcome {
  section?: ContextPlanSection;
  reused: ContextPageId[];
  pulled: ContextPageId[];
  anyTruncated: boolean;
  /** Count of one-hop pages actually built and measured, then dropped because the remaining
   * budget could not hold them. Never speculative: dedup skips (loop protection) are not
   * omissions and are not counted. */
  omitted: number;
}

export class ContextPlanner {
  /** Pages already supplied by this planner instance (one plan/turn's worth of work). FG-3 §51:
   * a repeated identical pull with no new state is suppressed, not re-added forever. A new turn
   * gets a fresh planner and therefore a fresh, legitimate opportunity to pull the same page. */
  private readonly suppliedPageIds = new Set<ContextPageId>();

  async planNarrow(request: ContextPlanRequest): Promise<ContextPlanResult> {
    const kernelText = renderContextKernel(request.kernel);
    const kernelTokens = estimateTokens(kernelText) + 32;
    if (kernelTokens > request.capacity.maxContextTokens) {
      throw new ContextCapacityError({ minimumEstimatedTokens: kernelTokens, availableTokens: request.capacity.maxContextTokens });
    }

    const sections: ContextPlanSection[] = [
      { title: "runtime_kernel", content: kernelText, level: asContextLevel("L0"), reasons: ["RUNTIME_KERNEL"] },
    ];
    let level = asContextLevel("L0");
    let truncated = false;
    let selectedFiles: string[] = [];
    let activeTargetChunks: ContextChunk[] = [];
    const pagesReused: ContextPageId[] = [];
    const pagesPulled: ContextPageId[] = [];
    let omittedOptionalPages = 0;
    let reasonCodes: string[] = ["RUNTIME_KERNEL"];
    let repositoryGeneration = 1;

    if (request.intelligence) {
      const status = request.intelligence.status();
      repositoryGeneration = status.generation ?? 1;
      const afterKernel = request.capacity.maxContextTokens - kernelTokens;
      // Reserve roughly half of what remains for the L1 active target(s); the rest stays
      // available for bounded one-hop prefetch below. Never the eager 80%+ grab this budget
      // fraction used to receive (see the pre-FG-3 `ContextAssembler` coder branch).
      const narrowBudget = Math.max(0, Math.floor(afterKernel * 0.5));
      if (narrowBudget > 200) {
        const pack = await buildContextPack(request.goal, request.intelligence, {
          contextWindow: narrowBudget,
          mentionedPaths: request.mentionedPaths,
          maxCandidates: request.narrowCandidateLimit ?? NARROW_CANDIDATE_LIMIT,
          systemPromptTokens: 0,
          toolSchemaTokens: 0,
          reservedOutputTokens: 0,
          safetyMarginTokens: Math.max(8, Math.ceil(narrowBudget * 0.05)),
        });
        if (pack.chunks.length > 0) {
          level = asContextLevel("L1");
          reasonCodes = [...reasonCodes, "ACTIVE_TARGET"];
          sections.push({
            title: "active_targets",
            content: pack.chunks.map((chunk) => `File: ${chunk.provenance.path}:${chunk.provenance.startLine}\n${chunk.content}`).join("\n\n"),
            level,
            reasons: ["ACTIVE_TARGET"],
          });
          selectedFiles = pack.selectedFiles;
          activeTargetChunks = pack.chunks;
          truncated = truncated || pack.truncated;

          const remainingAfterTargets = request.capacity.maxContextTokens - sectionTokens(sections);
          if (remainingAfterTargets > 0) {
            const prefetch = await this.prefetchOneHop(request, selectedFiles.slice(0, MAX_PREFETCH_TARGETS), remainingAfterTargets);
            if (prefetch.section) {
              sections.push(prefetch.section);
              level = asContextLevel("L2");
              reasonCodes = [...reasonCodes, ...prefetch.section.reasons];
            }
            pagesReused.push(...prefetch.reused);
            pagesPulled.push(...prefetch.pulled);
            omittedOptionalPages += prefetch.omitted;
            truncated = truncated || prefetch.anyTruncated;
          }
          if (request.minimumLevel && contextLevelAtLeast(request.minimumLevel, asContextLevel("L3"))) {
            const prefixes = [...new Set(selectedFiles.map((file) => file.split("/").slice(0, 2).join("/")))];
            const moduleSummaries = await Promise.all(prefixes.map(async (prefix) => await request.intelligence!.getModuleSummary(prefix).catch(() => undefined)));
            const moduleText = moduleSummaries.filter(Boolean).map((summary) => {
              const module = summary!;
              return `Module ${module.prefix}: files=${module.files.length}; package dependencies=${module.packageDependencies.join(", ") || "none"}; internal dependencies=${module.internalDependencies.join(", ") || "none"}; related tests=${module.relatedTests.length}`;
            }).join("\n");
            const moduleTokens = estimateTokens(moduleText);
            if (moduleText && sectionTokens(sections) + moduleTokens <= request.capacity.maxContextTokens) {
              sections.push({ title: "module_context", content: moduleText, level: asContextLevel("L3"), reasons: ["MODULE_CONTEXT"] });
              level = asContextLevel("L3");
              reasonCodes = [...reasonCodes, "MODULE_CONTEXT"];
            } else if (moduleText) {
              truncated = true;
              reasonCodes = [...reasonCodes, "MODULE_CONTEXT_BUDGETED_OUT"];
            }
          }
        } else {
          reasonCodes = [...reasonCodes, "NO_RELEVANT_TARGET_FOUND"];
        }
      } else {
        reasonCodes = [...reasonCodes, "BUDGET_EXHAUSTED_BY_KERNEL"];
      }
    }

    const prompt = sections.map((section) => section.content).join("\n\n");
    const tokenEstimate = estimateTokens(prompt);
    const contextHash = sha256(sections.map((section) => `${section.title}:${sha256(section.content)}`).join("|"));

    const receipt: ProgressiveContextReceipt = {
      requestId: sha256(`${request.goal}\0${request.kernel.sessionId}\0${contextHash}`).slice(0, 16),
      repositoryGeneration,
      retrievedFiles: selectedFiles,
      retrievedSymbols: [],
      estimatedTokens: tokenEstimate,
      truncated,
      cacheHits: pagesReused.length,
      reasonCodes,
      contextHash,
      level,
      capacitySource: request.capacity.source,
      pagesReused: pagesReused.length,
      pagesPulled: pagesPulled.length,
      omittedOptionalPages,
    };

    return { level, sections, prompt, selectedFiles, activeTargetChunks, pagesReused, pagesPulled, tokenEstimate, truncated, capacity: request.capacity, receipt };
  }

  /**
   * Explicit, deliberate expansion for a file the narrow plan did not already cover (FG-3 §50)
   * — e.g. a symbol turned out unresolved, or a tool result revealed a new target. Bounded and
   * loop-safe: expanding the SAME file again within this planner (same turn) returns
   * `undefined` rather than re-supplying an identical page (§51).
   */
  async expandOneHop(request: ContextPlanRequest, filePath: string, budgetTokens: number): Promise<ContextPlanSection | undefined> {
    const outcome = await this.prefetchOneHop(request, [filePath], budgetTokens);
    return outcome.section;
  }

  private async prefetchOneHop(request: ContextPlanRequest, targetFiles: string[], budget: number): Promise<PrefetchOutcome> {
    if (!request.intelligence || targetFiles.length === 0) return { reused: [], pulled: [], anyTruncated: false, omitted: 0 };
    const reused: ContextPageId[] = [];
    const pulled: ContextPageId[] = [];
    const lines: string[] = [];
    let anyTruncated = false;
    let omitted = 0;
    let used = 0;
    for (const filePath of targetFiles) {
      const result = await buildDependencyNeighborhoodPage(request.intelligence, filePath, request.pageStore);
      if (!result) continue;
      const { page, reused: wasReused } = result;
      if (this.suppliedPageIds.has(page.id)) continue;
      const rendered = renderDependencyNeighborhood(page);
      const tokens = estimateTokens(rendered);
      if (used + tokens > budget) {
        anyTruncated = true;
        omitted += 1;
        continue;
      }
      this.suppliedPageIds.add(page.id);
      (wasReused ? reused : pulled).push(page.id);
      lines.push(rendered);
      used += tokens;
      anyTruncated = anyTruncated || page.data.dependenciesTruncated || page.data.dependentsTruncated || page.data.testsTruncated;
    }
    if (lines.length === 0) return { reused, pulled, anyTruncated, omitted };
    return {
      section: {
        title: "structural_neighbors",
        content: lines.join("\n\n"),
        level: asContextLevel("L2"),
        reasons: ["DIRECT_DEPENDENCY", "DIRECT_DEPENDENT", "RELATED_TEST"],
      },
      reused,
      pulled,
      anyTruncated,
      omitted,
    };
  }
}

export function createContextPlanner(): ContextPlanner {
  return new ContextPlanner();
}
