import { createHash } from "node:crypto";
import type { FreeAdmissionReceipt } from "@codeforge/forge-zero";

const SOURCES = [
  { kind: "terms", url: "https://blockrun.ai/terms", sha256: "73f2ef461e086bec3f80579ad7699ce819ab9fd78cef6763f8ff7a83bde3d649" },
  { kind: "privacy", url: "https://blockrun.ai/privacy", sha256: "21b97f5ca395e4b0ce3b434c8fca6f20cf63285ec57a93cbf88fe1628eb8e3b7" },
  { kind: "price", url: "https://blockrun.ai/docs/rate-limits", sha256: "4921f5b2f8c4b51559078915381fa0956ee12030bb4e09fe86e49ecd6ccdf27f" },
] as const;

export interface BlockRunPolicyVerification {
  status: "VERIFIED" | "CHANGED" | "UNAVAILABLE";
  checkedAt: string;
  source?: (typeof SOURCES)[number]["kind"];
  observedHash?: string;
  receipt?: FreeAdmissionReceipt;
}

export async function reverifyBlockRunPolicy(qualificationAt: string, options: { fetcher?: typeof fetch; now?: () => Date } = {}): Promise<BlockRunPolicyVerification> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const fetcher = options.fetcher ?? fetch;
  for (const source of SOURCES) {
    try {
      const response = await fetcher(source.url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok || response.url !== source.url) return { status: "UNAVAILABLE", checkedAt, source: source.kind };
      const body = await response.text();
      const start = body.indexOf("<main");
      const end = body.indexOf("</main>", start);
      if (!body || body.length > 1_000_000 || start < 0 || end < 0) return { status: "UNAVAILABLE", checkedAt, source: source.kind };
      const observedHash = createHash("sha256").update(body.slice(start, end + 7)).digest("hex");
      if (observedHash !== source.sha256) return { status: "CHANGED", checkedAt, source: source.kind, observedHash };
    } catch {
      return { status: "UNAVAILABLE", checkedAt, source: source.kind };
    }
  }
  const expiresAt = new Date(Date.parse(checkedAt) + 7 * 24 * 60 * 60_000).toISOString();
  return {
    status: "VERIFIED", checkedAt,
    receipt: {
      sourceDocumentation: "https://blockrun.ai/signal/free-llm-api-no-key-models-you-can-curl",
      termsEvidence: SOURCES[0].url, privacyEvidence: SOURCES[1].url, priceEvidence: SOURCES[2].url,
      verifiedAt: checkedAt, recheckAt: expiresAt, qualificationAt,
      termsVerifiedAt: checkedAt, termsEvidenceHash: SOURCES[0].sha256, termsExpiresAt: expiresAt,
      privacyVerifiedAt: checkedAt, privacyEvidenceHash: SOURCES[1].sha256, privacyExpiresAt: expiresAt,
      priceVerifiedAt: checkedAt, priceEvidenceHash: SOURCES[2].sha256, priceExpiresAt: expiresAt,
      nextReverifyAt: new Date(Date.parse(checkedAt) + 6 * 60 * 60_000).toISOString(),
    },
  };
}
