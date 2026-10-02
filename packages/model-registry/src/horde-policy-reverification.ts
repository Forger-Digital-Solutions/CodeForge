import { createHash } from "node:crypto";
import type { FreeAdmissionReceipt } from "@codeforge/forge-zero";

/**
 * AI Horde's authoritative policy documents live in the Haidra-Org GitHub org as raw
 * markdown — aihorde.net renders an SPA shell whose bytes carry no policy content, so the
 * pinned sources are the repository documents themselves:
 * - definitions.md: anonymous usage via key 0000000000, ToS agreement incl. proxied clients.
 * - FAQ.md: workers can technically see prompts (drives PUBLIC_CODE_ONLY) + in-memory-only storage.
 * - kudos.md: kudos can never be bought or sold — the zero-cash provenance of this capacity.
 */
const SOURCES = [
  {
    kind: "terms",
    url: "https://raw.githubusercontent.com/Haidra-Org/haidra-assets/main/docs/definitions.md",
    sha256: "c187030e08f828054eb1ccfbc9f14fd45002d856d4f46a95e953d2c8420c86ac",
  },
  {
    kind: "privacy",
    url: "https://raw.githubusercontent.com/Haidra-Org/AI-Horde/main/FAQ.md",
    sha256: "15f0ea5ba9298a6f2100685eb79f66df8882105c87c8c461768f6498471884b2",
  },
  {
    kind: "price",
    url: "https://raw.githubusercontent.com/Haidra-Org/haidra-assets/main/docs/kudos.md",
    sha256: "b50fb2ad2f38d414fc953a13f1f742c267c3a6aea82d9f643abb043070db819a",
  },
] as const;

export type HordePolicyStatus = "VERIFIED" | "CHANGED" | "UNAVAILABLE";

export interface HordePolicyVerification {
  status: HordePolicyStatus;
  checkedAt: string;
  source?: (typeof SOURCES)[number]["kind"];
  observedHash?: string;
  receipt?: FreeAdmissionReceipt;
}

/** A changed authoritative document needs operator review; a network failure keeps only a still-valid prior receipt. */
export async function reverifyHordePolicy(
  qualificationAt: string,
  options: { fetcher?: typeof fetch; now?: () => Date } = {},
): Promise<HordePolicyVerification> {
  const fetcher = options.fetcher ?? fetch;
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  for (const source of SOURCES) {
    let response: Response;
    try {
      response = await fetcher(source.url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok || response.url !== source.url) return { status: "UNAVAILABLE", checkedAt, source: source.kind };
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > 1_000_000) return { status: "UNAVAILABLE", checkedAt, source: source.kind };
      const body = await response.text();
      if (body.length === 0 || body.length > 1_000_000) return { status: "UNAVAILABLE", checkedAt, source: source.kind };
      const observedHash = createHash("sha256").update(body).digest("hex");
      if (observedHash !== source.sha256) return { status: "CHANGED", checkedAt, source: source.kind, observedHash };
    } catch {
      return { status: "UNAVAILABLE", checkedAt, source: source.kind };
    }
  }

  const expiresAt = new Date(Date.parse(checkedAt) + 7 * 24 * 60 * 60_000).toISOString();
  return {
    status: "VERIFIED",
    checkedAt,
    receipt: {
      sourceDocumentation: "https://raw.githubusercontent.com/Haidra-Org/AI-Horde/main/README.md",
      termsEvidence: SOURCES[0].url,
      privacyEvidence: SOURCES[1].url,
      priceEvidence: SOURCES[2].url,
      verifiedAt: checkedAt,
      recheckAt: expiresAt,
      qualificationAt,
      termsVerifiedAt: checkedAt,
      termsEvidenceHash: SOURCES[0].sha256,
      termsExpiresAt: expiresAt,
      privacyVerifiedAt: checkedAt,
      privacyEvidenceHash: SOURCES[1].sha256,
      privacyExpiresAt: expiresAt,
      priceVerifiedAt: checkedAt,
      priceEvidenceHash: SOURCES[2].sha256,
      priceExpiresAt: expiresAt,
      nextReverifyAt: new Date(Date.parse(checkedAt) + 6 * 60 * 60_000).toISOString(),
    },
  };
}
