import type { ContextBundle, RepoMap, TaskIntent } from "./types.js";

function scoreFile(intent: TaskIntent, filePath: string, matchCount: number): number {
  let score = matchCount * 10;
  const lowerPath = filePath.toLowerCase();
  const lowerTitle = intent.title.toLowerCase();
  // Boost if filename appears in task
  for (const kw of intent.keywords) {
    if (lowerPath.includes(kw.toLowerCase())) score += 5;
  }
  if (lowerPath.includes("test") && intent.taskType === "testing") score += 10;
  if (lowerPath.endsWith(".ts") || lowerPath.endsWith(".js")) score += 2;
  if (lowerPath.includes("src/")) score += 1;
  if (lowerTitle.includes(filePath.split("/").pop()?.toLowerCase() ?? "")) score += 15;
  return score;
}

export function buildContext(intent: TaskIntent, repoMap: RepoMap): ContextBundle {
  const matchCounts = new Map<string, number>();
  for (const m of repoMap.searchedMatches) {
    matchCounts.set(m.file, (matchCounts.get(m.file) ?? 0) + 1);
  }
  const scores = new Map<string, number>();
  for (const f of repoMap.files) {
    const c = matchCounts.get(f.relativePath) ?? 0;
    scores.set(f.relativePath, scoreFile(intent, f.relativePath, c));
  }
  // Include readFiles that may not be in matchCounts but are relevant
  for (const rf of repoMap.readFiles) {
    if (!scores.has(rf.path)) scores.set(rf.path, 1);
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const primaryFiles = sorted.filter(([, s]) => s > 0).slice(0, 10).map(([p]) => p);
  if (primaryFiles.length === 0 && repoMap.files.length > 0) {
    // fallback: top 3 smallest files
    primaryFiles.push(...repoMap.files.slice(0, 3).map((f) => f.relativePath));
  }

  const snippets: ContextBundle["snippets"] = repoMap.readFiles
    .filter((rf) => primaryFiles.includes(rf.path))
    .map((rf) => ({
      path: rf.path,
      preview: rf.content.split("\n").slice(0, 20).join("\n").slice(0, 800),
      relevance: scores.get(rf.path) ?? 0,
    }))
    .sort((a, b) => b.relevance - a.relevance);

  const totalChars = snippets.reduce((acc, s) => acc + s.preview.length, 0) + primaryFiles.join("").length;
  const tokensApprox = Math.ceil(totalChars / 4);

  const summary = `Task "${intent.title}" (${intent.taskType}) — context: ${primaryFiles.length} files, ${repoMap.searchedMatches.length} matches, keywords: ${intent.keywords.slice(0, 6).join(", ")}`;

  return {
    primaryFiles,
    relevanceScores: scores,
    snippets,
    tokensApprox,
    summary,
  };
}

export function contextToPrompt(intent: TaskIntent, context: ContextBundle, repoMap: RepoMap): string {
  const parts: string[] = [];
  parts.push(`Task: ${intent.title}`);
  parts.push(`Type: ${intent.taskType}`);
  parts.push(`Goals: ${intent.goals.join(" | ")}`);
  if (intent.constraints.length) parts.push(`Constraints: ${intent.constraints.join(", ")}`);
  parts.push(`\nRelevant files (${context.primaryFiles.length}):`);
  for (const f of context.primaryFiles) {
    const score = context.relevanceScores.get(f) ?? 0;
    parts.push(`- ${f} (relevance ${score})`);
  }
  parts.push(`\nSnippets:`);
  for (const s of context.snippets.slice(0, 5)) {
    parts.push(`\n--- ${s.path} ---\n${s.preview.slice(0, 1000)}\n`);
  }
  // Include hash references for edit protection
  if (repoMap.readFiles.length) {
    parts.push(`\nFile hashes for edit protection:`);
    for (const rf of repoMap.readFiles.slice(0, 5)) {
      parts.push(`${rf.path}: ${rf.hash.slice(0, 12)} (${rf.lines} lines)`);
    }
  }
  return parts.join("\n");
}
