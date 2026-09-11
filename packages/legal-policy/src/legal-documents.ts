import { createHash } from "node:crypto";

export type LegalDocumentId =
  | "terms-of-service"
  | "privacy-policy"
  | "acceptable-use-policy"
  | "ai-output-disclaimer"
  | "subscription-billing-terms"
  | "desktop-software-license"
  | "third-party-notices"
  | "security-disclosure"
  | "dmca-copyright-policy";

export type LegalDocumentStatus = "DRAFT" | "ACTIVE" | "RETIRED";

export interface LegalDocumentVersion {
  documentId: LegalDocumentId;
  version: string;
  status: LegalDocumentStatus;
  effectiveAt: string | null;
  retiredAt: string | null;
  sourcePath: string;
  contentHash: string | null;
}

// Every Pass-3 proposed draft starts life here as DRAFT with no effective date and no hash.
// Activating a document (DRAFT -> ACTIVE) is a deliberate, separate, counsel/business-authorized
// action (stampActiveVersion below) that this milestone does not invoke — see R1 spec §35.
export const LEGAL_DOCUMENT_REGISTRY: LegalDocumentVersion[] = [
  {
    documentId: "terms-of-service",
    version: "3.0.0-draft",
    status: "DRAFT",
    effectiveAt: null,
    retiredAt: null,
    sourcePath: "docs/legal/pass3/proposed-drafts/terms-of-service.md",
    contentHash: null,
  },
  {
    documentId: "privacy-policy",
    version: "3.0.0-draft",
    status: "DRAFT",
    effectiveAt: null,
    retiredAt: null,
    sourcePath: "docs/legal/pass3/proposed-drafts/privacy-policy.md",
    contentHash: null,
  },
  {
    documentId: "acceptable-use-policy",
    version: "3.0.0-draft",
    status: "DRAFT",
    effectiveAt: null,
    retiredAt: null,
    sourcePath: "docs/legal/pass3/proposed-drafts/acceptable-use-policy.md",
    contentHash: null,
  },
  {
    documentId: "ai-output-disclaimer",
    version: "3.0.0-draft",
    status: "DRAFT",
    effectiveAt: null,
    retiredAt: null,
    sourcePath: "docs/legal/pass3/proposed-drafts/ai-output-disclaimer.md",
    contentHash: null,
  },
  {
    documentId: "subscription-billing-terms",
    version: "3.0.0-draft",
    status: "DRAFT",
    effectiveAt: null,
    retiredAt: null,
    sourcePath: "docs/legal/pass3/proposed-drafts/subscription-billing-terms.md",
    contentHash: null,
  },
  {
    documentId: "desktop-software-license",
    version: "3.0.0-draft",
    status: "DRAFT",
    effectiveAt: null,
    retiredAt: null,
    sourcePath: "docs/legal/pass3/proposed-drafts/desktop-software-license.md",
    contentHash: null,
  },
  {
    documentId: "third-party-notices",
    version: "3.0.0-draft",
    status: "DRAFT",
    effectiveAt: null,
    retiredAt: null,
    sourcePath: "docs/legal/pass3/proposed-drafts/third-party-notices.md",
    contentHash: null,
  },
  {
    documentId: "security-disclosure",
    version: "3.0.0-draft",
    status: "DRAFT",
    effectiveAt: null,
    retiredAt: null,
    sourcePath: "docs/legal/pass3/proposed-drafts/security-disclosure.md",
    contentHash: null,
  },
  {
    documentId: "dmca-copyright-policy",
    version: "3.0.0-draft",
    status: "DRAFT",
    effectiveAt: null,
    retiredAt: null,
    sourcePath: "docs/legal/pass3/proposed-drafts/dmca-copyright-policy.md",
    contentHash: null,
  },
];

export function getDocumentVersions(
  registry: LegalDocumentVersion[],
  documentId: LegalDocumentId,
): LegalDocumentVersion[] {
  return registry.filter((doc) => doc.documentId === documentId);
}

/** Returns the ACTIVE version for a document, or null if none has been activated yet. */
export function getActiveVersion(
  registry: LegalDocumentVersion[],
  documentId: LegalDocumentId,
): LegalDocumentVersion | null {
  return registry.find((doc) => doc.documentId === documentId && doc.status === "ACTIVE") ?? null;
}

export class LegalDocumentConfigError extends Error {
  constructor(documentId: LegalDocumentId) {
    super(`No ACTIVE legal document configured for "${documentId}"`);
    this.name = "LegalDocumentConfigError";
  }
}

/** Throws instead of silently proceeding — callers that require an active document (e.g. an
 *  acceptance-gated flow) must handle LegalDocumentConfigError explicitly rather than treat a
 *  missing document as implicitly satisfied. */
export function requireActiveVersion(
  registry: LegalDocumentVersion[],
  documentId: LegalDocumentId,
): LegalDocumentVersion {
  const active = getActiveVersion(registry, documentId);
  if (!active) throw new LegalDocumentConfigError(documentId);
  return active;
}

export function computeContentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export interface ActivationRequest {
  registry: LegalDocumentVersion[];
  documentId: LegalDocumentId;
  version: string;
  content: string;
  effectiveAt: string;
  authorizedBy: string;
}

/**
 * Produces a NEW registry array with the given document version marked ACTIVE and any
 * previously-ACTIVE version of the same document RETIRED. Never mutates the input registry.
 * This is deliberately not wired into any runtime path in R1 — see R1 spec §35.
 */
export function stampActiveVersion(request: ActivationRequest): LegalDocumentVersion[] {
  if (!request.authorizedBy) {
    throw new Error("stampActiveVersion requires an explicit authorizedBy identity");
  }
  const hash = computeContentHash(request.content);
  return request.registry.map((doc) => {
    if (doc.documentId !== request.documentId) return doc;
    if (doc.status === "ACTIVE") {
      return { ...doc, status: "RETIRED" as const, retiredAt: request.effectiveAt };
    }
    if (doc.version === request.version) {
      return { ...doc, status: "ACTIVE" as const, effectiveAt: request.effectiveAt, contentHash: hash };
    }
    return doc;
  });
}
