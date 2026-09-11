import { describe, expect, it } from "vitest";
import {
  LEGAL_DOCUMENT_REGISTRY,
  LegalDocumentConfigError,
  computeContentHash,
  getActiveVersion,
  requireActiveVersion,
  stampActiveVersion,
  type LegalDocumentVersion,
} from "../src/legal-documents.js";

function freshRegistry(): LegalDocumentVersion[] {
  return LEGAL_DOCUMENT_REGISTRY.map((doc) => ({ ...doc }));
}

describe("legal document registry — draft-only invariant (R1 spec §35, §53)", () => {
  it("every shipped registry entry starts as DRAFT with no effective date", () => {
    for (const doc of LEGAL_DOCUMENT_REGISTRY) {
      expect(doc.status).toBe("DRAFT");
      expect(doc.effectiveAt).toBeNull();
    }
  });

  it("a draft document cannot become active by merely reading the registry", () => {
    const registry = freshRegistry();
    expect(getActiveVersion(registry, "terms-of-service")).toBeNull();
  });

  it("requireActiveVersion throws a typed error instead of silently proceeding when nothing is active", () => {
    const registry = freshRegistry();
    expect(() => requireActiveVersion(registry, "terms-of-service")).toThrow(LegalDocumentConfigError);
  });
});

describe("stampActiveVersion (fixture-only activation path)", () => {
  it("activates a version and stamps a content hash", () => {
    const registry = freshRegistry();
    const activated = stampActiveVersion({
      registry,
      documentId: "terms-of-service",
      version: "3.0.0-draft",
      content: "TEST FIXTURE CONTENT — not real Terms of Service",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      authorizedBy: "test-fixture",
    });
    const active = getActiveVersion(activated, "terms-of-service");
    expect(active).not.toBeNull();
    expect(active?.status).toBe("ACTIVE");
    expect(active?.contentHash).toBe(computeContentHash("TEST FIXTURE CONTENT — not real Terms of Service"));
    // Original input registry must not be mutated.
    expect(getActiveVersion(registry, "terms-of-service")).toBeNull();
  });

  it("requires an explicit authorizedBy identity", () => {
    const registry = freshRegistry();
    expect(() =>
      stampActiveVersion({
        registry,
        documentId: "terms-of-service",
        version: "3.0.0-draft",
        content: "x",
        effectiveAt: "2026-01-01T00:00:00.000Z",
        authorizedBy: "",
      }),
    ).toThrow();
  });

  it("retires the previously active version when a new one is activated, and history is preserved", () => {
    const registry = freshRegistry();
    const v1 = stampActiveVersion({
      registry,
      documentId: "privacy-policy",
      version: "3.0.0-draft",
      content: "v1 fixture",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      authorizedBy: "test-fixture",
    });
    const withNewDraft: LegalDocumentVersion[] = [
      ...v1,
      { documentId: "privacy-policy", version: "3.1.0-draft", status: "DRAFT", effectiveAt: null, retiredAt: null, sourcePath: "test", contentHash: null },
    ];
    const v2 = stampActiveVersion({
      registry: withNewDraft,
      documentId: "privacy-policy",
      version: "3.1.0-draft",
      content: "v2 fixture",
      effectiveAt: "2026-02-01T00:00:00.000Z",
      authorizedBy: "test-fixture",
    });
    const active = getActiveVersion(v2, "privacy-policy");
    expect(active?.version).toBe("3.1.0-draft");
    const retired = v2.find((d) => d.documentId === "privacy-policy" && d.version === "3.0.0-draft");
    expect(retired?.status).toBe("RETIRED");
    expect(retired?.retiredAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("missing legal config (no active version) is a distinguishable state, not a silent pass", () => {
    const registry = freshRegistry();
    expect(getActiveVersion(registry, "ai-output-disclaimer")).toBeNull();
    let threw = false;
    try {
      requireActiveVersion(registry, "ai-output-disclaimer");
    } catch (e) {
      threw = e instanceof LegalDocumentConfigError;
    }
    expect(threw).toBe(true);
  });
});

describe("computeContentHash", () => {
  it("is deterministic and content-sensitive", () => {
    expect(computeContentHash("a")).toBe(computeContentHash("a"));
    expect(computeContentHash("a")).not.toBe(computeContentHash("b"));
    expect(computeContentHash("a")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
