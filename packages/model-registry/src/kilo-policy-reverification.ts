import { createHash } from "node:crypto";
import type { FreeAdmissionReceipt } from "@codeforge/forge-zero";

const SOURCES = [
  {
    kind: "terms",
    url: "https://kilo.ai/terms",
    sha256: "d581d1115facb8db7cc21674470ca0a2f4fdc6139ea192b36987af6388bc3e70",
  },
  {
    kind: "privacy",
    url: "https://kilo.ai/docs/getting-started/using-kilo-for-free",
    sha256: "fbe91c42b8d4757c17fd861fe72d868da4cf893f2a99f7fef264b5594e93771b",
  },
  {
    kind: "price",
    url: "https://kilo.ai/docs/gateway/usage-and-billing",
    sha256: "920ef26f7ed28ed8142c76c35a0b3377ef745e1b803037d33cebe33b7e33ca2e",
  },
] as const;

export type KiloPolicyStatus = "VERIFIED" | "CHANGED" | "UNAVAILABLE";

export interface KiloPolicyVerification {
  status: KiloPolicyStatus;
  checkedAt: string;
  source?: (typeof SOURCES)[number]["kind"];
  observedHash?: string;
  receipt?: FreeAdmissionReceipt;
}

/** A changed authoritative page needs operator review; a network failure keeps only a still-valid prior receipt. */
export async function reverifyKiloPolicy(
  qualificationAt: string,
  options: { fetcher?: typeof fetch; now?: () => Date } = {},
): Promise<KiloPolicyVerification> {
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
      const mainStart = body.indexOf("<main");
      const mainEnd = body.indexOf("</main>", mainStart);
      if (mainStart < 0 || mainEnd < 0) return { status: "UNAVAILABLE", checkedAt, source: source.kind };
      const observedHash = createHash("sha256").update(body.slice(mainStart, mainEnd + 7)).digest("hex");
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
      sourceDocumentation: "https://kilo.ai/docs/gateway/models-and-providers",
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
