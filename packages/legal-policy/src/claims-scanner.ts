export type ClaimContext = "INTERNAL_TECHNICAL" | "USER_UI" | "PUBLIC_MARKETING" | "HISTORICAL_EVIDENCE";

export type ClaimCategory =
  | "UNSUBSTANTIATED_FINANCIAL"
  | "UNSUBSTANTIATED_ENVIRONMENTAL"
  | "UNSUBSTANTIATED_CORRECTNESS"
  | "UNSUBSTANTIATED_SECURITY";

export interface ClaimPattern {
  id: string;
  pattern: RegExp;
  category: ClaimCategory;
  suggestion: string;
}

// Sourced directly from R1 remediation spec §41-44. Each pattern is scoped narrowly (word
// boundaries, specific phrasing) to avoid false positives on legitimate technical prose.
export const UNSUPPORTED_CLAIM_PATTERNS: ClaimPattern[] = [
  {
    id: "guaranteed-never-billed",
    pattern: /guaranteed\s+(?:\$?0|never\s+billed|free)/i,
    category: "UNSUBSTANTIATED_FINANCIAL",
    suggestion: "Verified Free / zero-cost eligibility verified / paid fallback disabled",
  },
  {
    id: "free-forever",
    pattern: /free\s+forever/i,
    category: "UNSUBSTANTIATED_FINANCIAL",
    suggestion: "routes exclusively through verified zero-cost allowances",
  },
  {
    id: "zero-emissions",
    pattern: /zero[\s-]emissions?/i,
    category: "UNSUBSTANTIATED_ENVIRONMENTAL",
    suggestion: "efficiency-aware token routing",
  },
  {
    id: "carbon-saved",
    pattern: /carbon\s+(?:saved|savings|reduction|neutral)/i,
    category: "UNSUBSTANTIATED_ENVIRONMENTAL",
    suggestion: "reduces redundant work where possible",
  },
  {
    id: "energy-reduction-percent",
    pattern: /\d+%\s+(?:energy|carbon)\s+reduction/i,
    category: "UNSUBSTANTIATED_ENVIRONMENTAL",
    suggestion: "tracks context and execution efficiency (no unmeasured percentage claim)",
  },
  {
    id: "guaranteed-correctness",
    pattern: /guarante(?:e|ed)s?\s+correctness/i,
    category: "UNSUBSTANTIATED_CORRECTNESS",
    suggestion: "runs configured verification before completion",
  },
  {
    id: "proves-correctness",
    pattern: /proves?\s+correctness/i,
    category: "UNSUBSTANTIATED_CORRECTNESS",
    suggestion: "runs configured verification before completion",
  },
  {
    id: "bug-free",
    pattern: /bug[\s-]free/i,
    category: "UNSUBSTANTIATED_CORRECTNESS",
    suggestion: "verification passed for configured checks",
  },
  {
    id: "completely-secure",
    pattern: /completely\s+secure/i,
    category: "UNSUBSTANTIATED_SECURITY",
    suggestion: "name the specific security control instead",
  },
  {
    id: "completely-private",
    pattern: /completely\s+private/i,
    category: "UNSUBSTANTIATED_SECURITY",
    suggestion: "name the specific data-handling boundary instead",
  },
  {
    id: "fully-sandboxed",
    pattern: /fully\s+sandboxed/i,
    category: "UNSUBSTANTIATED_SECURITY",
    suggestion: "name the specific sandbox boundary (e.g. Electron contextIsolation) instead",
  },
];

export interface ClaimHit {
  file: string;
  line: number;
  patternId: string;
  category: ClaimCategory;
  matchedText: string;
  context: ClaimContext;
}

export function scanTextForClaims(file: string, content: string, context: ClaimContext): ClaimHit[] {
  const hits: ClaimHit[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const p of UNSUPPORTED_CLAIM_PATTERNS) {
      const re = new RegExp(p.pattern.source, p.pattern.flags.includes("g") ? p.pattern.flags : `${p.pattern.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        hits.push({
          file,
          line: i + 1,
          patternId: p.id,
          category: p.category,
          matchedText: m[0],
          context,
        });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }
  return hits;
}

/** Only USER_UI and PUBLIC_MARKETING hits should ever fail a release gate. */
export function blockingClaimHits(hits: ClaimHit[]): ClaimHit[] {
  return hits.filter((h) => h.context === "USER_UI" || h.context === "PUBLIC_MARKETING");
}
