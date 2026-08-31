import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { RepositoryEdge, RepositoryIntelligence, RepositoryMatch, RepositorySymbol } from "@codeforge/repo-intelligence";

export interface ContextBudget {
  contextWindow: number;
  systemPrompt: number;
  toolSchemas: number;
  reservedOutput: number;
  safetyMargin: number;
  repository: number;
}

export interface ContextProvenance {
  path: string;
  startLine: number;
  endLine: number;
  symbolId?: string;
  symbol?: string;
  selectionReasons: string[];
  score: number;
  contentHash: string;
  indexedHash?: string;
  fresh: boolean;
}

export interface ContextChunk {
  id: string;
  content: string;
  tokenEstimate: number;
  provenance: ContextProvenance;
}

export type LedgerEventKind = "goal" | "constraint" | "decision" | "file_examined" | "file_modified" | "command" | "failure" | "repair" | "verification" | "blocker" | "evidence" | "noise";
export interface LedgerEvent { id: string; kind: LedgerEventKind; summary: string; timestamp: string; provenance?: string; uncertain?: boolean }
export interface LedgerFact { id: string; kind: Exclude<LedgerEventKind, "noise">; summary: string; provenance: string[]; uncertain: boolean }
export interface CompactedLedger { facts: LedgerFact[]; retainedEventIds: string[]; discardedEventCount: number }

export interface ContextPack {
  taskSummary: string;
  repositorySummary: string;
  selectedFiles: string[];
  selectedSymbols: RepositorySymbol[];
  relevantTests: RepositoryMatch[];
  dependencyContext: RepositoryEdge[];
  gitContext: { branch?: string; head?: string; currentDiff?: string };
  recentToolResults: LedgerEvent[];
  currentDiff?: string;
  unresolvedQuestions: string[];
  evidence: LedgerFact[];
  chunks: ContextChunk[];
  tokenEstimate: number;
  budget: ContextBudget;
  truncated: boolean;
  index: { workspaceId: string; version: number; updatedAt?: string; state: string };
}

export interface BuildContextPackOptions {
  contextWindow: number;
  systemPromptTokens?: number;
  toolSchemaTokens?: number;
  reservedOutputTokens?: number;
  safetyMarginTokens?: number;
  mentionedPaths?: string[];
  recentToolResults?: LedgerEvent[];
  unresolvedQuestions?: string[];
  evidence?: LedgerFact[];
  maxCandidates?: number;
}

export function estimateTokens(value: string): number {
  return value ? Math.ceil(Buffer.byteLength(value, "utf8") / 2.5) + Math.ceil(value.split("\n").length / 8) : 0;
}

export function calculateContextBudget(options: BuildContextPackOptions): ContextBudget {
  const systemPrompt = Math.max(0, options.systemPromptTokens ?? 4_000);
  const toolSchemas = Math.max(0, options.toolSchemaTokens ?? 4_000);
  const reservedOutput = Math.max(0, options.reservedOutputTokens ?? Math.min(8_000, Math.floor(options.contextWindow * 0.2)));
  const safetyMargin = Math.max(512, options.safetyMarginTokens ?? Math.ceil(options.contextWindow * 0.05));
  const repository = Math.max(0, options.contextWindow - systemPrompt - toolSchemas - reservedOutput - safetyMargin);
  return { contextWindow: options.contextWindow, systemPrompt, toolSchemas, reservedOutput, safetyMargin, repository };
}

function sha256(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function normalize(relativePath: string): string { return relativePath.replace(/\\/g, "/"); }

function git(root: string, args: string[]): string | undefined {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 2 * 1024 * 1024, timeout: 10_000 }).trim(); } catch { return undefined; }
}

function boundedSlice(content: string, symbol?: RepositorySymbol): { content: string; startLine: number; endLine: number } {
  const lines = content.split(/\r?\n/);
  if (symbol) {
    const startLine = Math.max(1, symbol.startLine - 3);
    const endLine = Math.min(lines.length, symbol.endLine + 3, startLine + 399);
    return { content: lines.slice(startLine - 1, endLine).join("\n"), startLine, endLine };
  }
  if (lines.length <= 240) return { content, startLine: 1, endLine: lines.length };
  return { content: lines.slice(0, 240).join("\n"), startLine: 1, endLine: 240 };
}

function fitToTokens(content: string, maximum: number): string {
  if (estimateTokens(content) <= maximum) return content;
  const suffix = "\n[context truncated]";
  const contentBudget = Math.max(0, maximum - estimateTokens(suffix) - 2);
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(content.slice(0, middle)) <= contentBudget) low = middle;
    else high = middle - 1;
  }
  const cut = content.slice(0, low);
  const boundary = cut.lastIndexOf("\n");
  let fitted = `${boundary > 0 ? cut.slice(0, boundary) : cut}${suffix}`;
  while (fitted.length > suffix.length && estimateTokens(fitted) > maximum) fitted = `${fitted.slice(0, -suffix.length - 1)}${suffix}`;
  return fitted;
}

export async function buildContextPack(task: string, intelligence: RepositoryIntelligence, options: BuildContextPackOptions): Promise<ContextPack> {
  const status = intelligence.status();
  const budget = calculateContextBudget(options);
  const relevant = await intelligence.findRelevantContext(task, { limit: options.maxCandidates ?? 100, mentionedPaths: options.mentionedPaths });
  const selectedSymbols: RepositorySymbol[] = [];
  const relevantTests: RepositoryMatch[] = [];
  const dependencyContext: RepositoryEdge[] = [];
  const chunks: ContextChunk[] = [];
  const seenContent = new Set<string>();
  let used = estimateTokens(task) + 100;

  for (const match of relevant.items) {
    if (used >= budget.repository) break;
    const relativePath = normalize(match.path);
    const root = path.resolve(status.root);
    const absolute = path.resolve(root, relativePath);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const metadata = await intelligence.getFile(relativePath);
    if (!metadata || metadata.binary || metadata.sensitive || metadata.size > 2 * 1024 * 1024) continue;
    let raw: string;
    try { raw = fs.readFileSync(absolute, "utf8"); } catch { continue; }
    const currentHash = sha256(raw);
    if (currentHash !== metadata.hash) {
      await intelligence.refresh([relativePath]);
      const refreshed = await intelligence.getFile(relativePath);
      if (!refreshed || refreshed.hash !== currentHash) continue;
    }
    const sliced = boundedSlice(raw, match.symbol);
    const initialHash = sha256(sliced.content);
    if (seenContent.has(initialHash)) continue;
    const remaining = budget.repository - used - 32;
    if (remaining < 32) break;
    const content = fitToTokens(sliced.content, remaining);
    const tokenEstimate = estimateTokens(content);
    if (!content || tokenEstimate > remaining) continue;
    const contentHash = sha256(content);
    if (seenContent.has(contentHash)) continue;
    seenContent.add(contentHash);
    chunks.push({ id: sha256(`${relativePath}\0${sliced.startLine}\0${sliced.endLine}\0${contentHash}`), content, tokenEstimate, provenance: { path: relativePath, startLine: sliced.startLine, endLine: sliced.endLine, symbolId: match.symbol?.id, symbol: match.symbol?.qualifiedName, selectionReasons: match.reasons, score: match.score, contentHash, indexedHash: metadata.hash, fresh: true } });
    used += tokenEstimate;
    if (match.symbol && !selectedSymbols.some((symbol) => symbol.id === match.symbol!.id)) selectedSymbols.push(match.symbol);
    for (const edge of (await intelligence.findDependencies(relativePath, { limit: 20 })).items) if (!dependencyContext.some((candidate) => candidate.id === edge.id)) dependencyContext.push(edge);
    for (const test of (await intelligence.findRelatedTests(relativePath, { limit: 10 })).items) if (!relevantTests.some((candidate) => candidate.path === test.path)) relevantTests.push(test);
  }

  const branch = git(status.root, ["branch", "--show-current"]);
  const head = git(status.root, ["rev-parse", "HEAD"]);
  const currentDiff = git(status.root, ["diff", "--no-ext-diff", "--unified=2"]);
  const diffBudget = Math.min(Math.max(0, budget.repository - used - 32), Math.floor(budget.repository * 0.2));
  let fittedDiff = currentDiff && diffBudget > 0 ? fitToTokens(currentDiff, diffBudget) : undefined;
  used += fittedDiff ? estimateTokens(fittedDiff) : 0;
  if (used > budget.repository && fittedDiff) {
    const withoutDiff = used - estimateTokens(fittedDiff);
    const allowed = Math.max(0, budget.repository - withoutDiff - 8);
    fittedDiff = allowed > 0 ? fitToTokens(fittedDiff, allowed) : undefined;
    used = withoutDiff + (fittedDiff ? estimateTokens(fittedDiff) : 0);
  }
  while (used > budget.repository && chunks.length > 1) {
    const removed = chunks.pop()!;
    used -= removed.tokenEstimate;
  }
  return {
    taskSummary: task,
    repositorySummary: `${status.fileCount} files, ${status.symbolCount} symbols, ${status.edgeCount} graph edges; index ${status.state}`,
    selectedFiles: [...new Set(chunks.map((chunk) => chunk.provenance.path))], selectedSymbols, relevantTests, dependencyContext,
    gitContext: { branch, head, currentDiff: fittedDiff }, currentDiff: fittedDiff,
    recentToolResults: (options.recentToolResults ?? []).slice(-50), unresolvedQuestions: options.unresolvedQuestions ?? [], evidence: options.evidence ?? [], chunks,
    tokenEstimate: used, budget, truncated: relevant.truncated || chunks.length < relevant.items.length,
    index: { workspaceId: status.workspaceId, version: status.indexVersion, updatedAt: status.updatedAt, state: status.state },
  };
}

export function renderContextPack(pack: ContextPack): string {
  const output = [`Task: ${pack.taskSummary}`, `Repository: ${pack.repositorySummary}`];
  for (const chunk of pack.chunks) output.push(`\n--- ${chunk.provenance.path}:${chunk.provenance.startLine} (${chunk.provenance.selectionReasons.join(", ")}) ---\n${chunk.content}`);
  if (pack.currentDiff) output.push(`\n--- current diff ---\n${pack.currentDiff}`);
  return output.join("\n");
}

const CRITICAL_KINDS = new Set<LedgerEventKind>(["goal", "constraint", "decision", "file_modified", "failure", "repair", "verification", "blocker", "evidence"]);

export function compactLedger(events: LedgerEvent[], maximumFacts = 100): CompactedLedger {
  const facts = new Map<string, LedgerFact>();
  const retainedEventIds: string[] = [];
  for (const event of events) {
    if (!CRITICAL_KINDS.has(event.kind)) continue;
    const key = `${event.kind}\0${event.summary.trim().toLowerCase()}`;
    const existing = facts.get(key);
    if (existing) {
      existing.provenance.push(event.provenance ?? event.id);
      existing.uncertain ||= Boolean(event.uncertain);
    } else if (facts.size < maximumFacts) {
      facts.set(key, { id: sha256(key), kind: event.kind as LedgerFact["kind"], summary: event.summary, provenance: [event.provenance ?? event.id], uncertain: Boolean(event.uncertain) });
    }
    retainedEventIds.push(event.id);
  }
  return { facts: [...facts.values()], retainedEventIds, discardedEventCount: events.length - retainedEventIds.length };
}

export interface ContextArtifact { path: string; content: string; relevance: number }
export class ContextAssembler { assemble(_task: unknown): ContextArtifact[] { return []; } }
