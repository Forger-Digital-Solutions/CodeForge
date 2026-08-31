import type { FailureAnalysis, VerificationResult } from "./types.js";

function extractDiagnostics(output: string): string[] {
  const lines = output.split("\n");
  const diags: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/error|fail|exception|stack|at .*:\d+:\d+/i.test(trimmed)) {
      // redact secrets lightly
      const redacted = trimmed.replace(/sk-[A-Za-z0-9\-_]{10,}/g, "[REDACTED]").slice(0, 500);
      diags.push(redacted);
      if (diags.length >= 20) break;
    }
  }
  return diags;
}

function isRepairable(output: string, failures: VerificationResult["failures"]): boolean {
  const lower = output.toLowerCase();
  // Simple heuristics: syntax errors, type errors, test assertion failures are repairable
  // Infrastructure failures like OOM, missing binary are less repairable
  if (/enoent|command not found|cannot find module.*node_modules/.test(lower)) return false;
  if (/out of memory|heap/.test(lower)) return false;
  if (failures.length === 0) return false;
  return true;
}

function inferRepairs(output: string): Array<{ file: string; oldText: string; newText: string; reason: string }> {
  // Very conservative: we do not auto-infer repairs without file context
  // Return empty; caller (workflow engine) will use LLM or pattern-based fix
  // But we can detect common patterns:
  const repairs: Array<{ file: string; oldText: string; newText: string; reason: string }> = [];
  // Example: detect missing import
  const importMatch = output.match(/Cannot find module ['"]([^'"]+)['"]/);
  if (importMatch && importMatch[1]) {
    repairs.push({
      file: "package.json",
      oldText: `"dependencies"`,
      newText: `"dependencies" /* missing ${importMatch[1]} */`,
      reason: `Missing module ${importMatch[1]}`,
    });
  }
  return repairs;
}

export function analyzeFailures(result: VerificationResult): FailureAnalysis {
  // A workspace with no verification command has produced no failures to analyse. Treating "nothing
  // ran" as a failure would send the repair loop chasing a defect that does not exist and fail an
  // otherwise-good change.
  if (result.notConfigured) {
    return {
      hasFailures: false,
      summary: "No verification command is configured for this workspace; nothing was verified.",
      diagnostics: [],
      suggestedRepairs: [],
      isRepairable: false,
    };
  }
  const hasFailures = result.failed > 0 || result.exitCode !== 0;
  const diagnostics = extractDiagnostics(result.output);
  const suggestedRepairs = hasFailures ? inferRepairs(result.output) : [];
  const repairable = hasFailures ? isRepairable(result.output, result.failures) : false;
  const summary = hasFailures
    ? `Verification failed: ${result.failed} failed, ${result.passed} passed, exit ${result.exitCode}. ${diagnostics.slice(0, 2).join(" | ")}`
    : `Verification passed: ${result.passed} passed, ${result.skipped} skipped`;

  return {
    hasFailures,
    summary,
    diagnostics,
    suggestedRepairs,
    isRepairable: repairable && suggestedRepairs.length > 0 ? true : repairable,
  };
}

export function formatAnalysisForPrompt(analysis: FailureAnalysis): string {
  if (!analysis.hasFailures) return "No failures; no repair needed.";
  return [
    `Summary: ${analysis.summary}`,
    `Diagnostics:`,
    ...analysis.diagnostics.map((d) => `- ${d}`),
    analysis.suggestedRepairs.length ? `Suggested repairs: ${JSON.stringify(analysis.suggestedRepairs, null, 2)}` : "",
    `Repairable: ${analysis.isRepairable}`,
  ].join("\n");
}
