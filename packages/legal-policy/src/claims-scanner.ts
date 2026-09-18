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
  // Security R1 (Phase 61): claims that require evidence or formal certification CodeForge does
  // not have. Each pattern is narrow enough that a truthful negation ("is not SOC 2 certified")
  // is caught only when it asserts the certification; reviewers triage negations by context.
  {
    id: "military-or-bank-grade",
    pattern: /\b(military|bank|government)[\s-]grade\b/i,
    category: "UNSUBSTANTIATED_SECURITY",
    suggestion: "name the actual primitive (AES-256-GCM, TLS 1.2+) instead of a grade",
  },
  {
    id: "unhackable-or-unbreakable",
    pattern: /\b(unhackable|unbreakable|impenetrable|100%\s+secure)\b/i,
    category: "UNSUBSTANTIATED_SECURITY",
    suggestion: "describe the control and its tested property",
  },
  {
    id: "zero-knowledge",
    pattern: /\bzero[\s-]knowledge\b/i,
    category: "UNSUBSTANTIATED_SECURITY",
    suggestion: "CodeForge servers can decrypt what they store; do not claim zero knowledge",
  },
  {
    id: "end-to-end-encrypted",
    pattern: /\bend[\s-]to[\s-]end\s+encrypt/i,
    category: "UNSUBSTANTIATED_SECURITY",
    suggestion: "say 'encrypted in transit (TLS) and at rest' — providers and the Cloud process plaintext",
  },
  {
    id: "compliance-certified",
    pattern: /\b(SOC\s?2|ISO\s?27001|PCI[\s-]DSS|HIPAA|FedRAMP|FIPS[\s-]?140)[\s-]*(certified|compliant|validated|accredited)\b/i,
    category: "UNSUBSTANTIATED_SECURITY",
    suggestion: "no formal certification exists; describe the control and mark the certification as not obtained",
  },
  {
    id: "regulation-compliant",
    pattern: /\b(GDPR|CCPA|CPRA|NJDPA)[\s-]+compliant\b/i,
    category: "UNSUBSTANTIATED_SECURITY",
    suggestion: "describe the specific right or mechanism supported; compliance is a legal determination",
  },
  {
    id: "hardware-encryption",
    pattern: /\bhardware[\s-]+(backed\s+)?encryption\b/i,
    category: "UNSUBSTANTIATED_SECURITY",
    suggestion: "say 'operating-system-backed encryption (DPAPI/Keychain/Secret Service)'",
  },
  {
    id: "never-leaves-your-machine",
    pattern: /\b(never\s+leaves?|stays?\s+on)\s+your\s+(computer|machine|device)\b/i,
    category: "UNSUBSTANTIATED_SECURITY",
    suggestion: "prompts and code context are sent to the selected model provider; say exactly what leaves the device",
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
