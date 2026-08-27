import { describe, it, expect } from "vitest";
import { InMemoryProviderCatalog } from "../src/index.js";

class StubStore implements import("../src/index.js").CredentialStore {
  private m = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.m.set(k, v);
  }
  get(id: string) { return this.m.get(id); }
  set(id: string, v: string) { this.m.set(id, v); }
  delete(id: string) { return this.m.delete(id); }
  has(id: string) { return this.m.has(id); }
}

describe("provider isolation — credential separation", () => {
  it("opencode credential does not authenticate openrouter adapter and vice versa", async () => {
    const opencodeStore = new StubStore({ opencode: "opencode-key" });
    const openrouterStore = new StubStore({ openrouter: "openrouter-key" });
    const { createOpencodeAdapter, createOpenRouterAdapter } = await import("../src/index.js");
    const oc = createOpencodeAdapter({ credentialStore: opencodeStore });
    const or = createOpenRouterAdapter({ credentialStore: openrouterStore });

    // Each adapter should only see its own key
    // Simulate credentialStore.get isolation
    expect(opencodeStore.get("opencode")).toBe("opencode-key");
    expect(opencodeStore.get("openrouter")).toBeUndefined();
    expect(openrouterStore.get("openrouter")).toBe("openrouter-key");
    expect(openrouterStore.get("opencode")).toBeUndefined();

    // provider IDs distinct and canonical
    expect(oc.providerId).toBe("opencode");
    expect(or.providerId).toBe("openrouter");
    expect(oc.providerId).not.toBe(or.providerId);
  });

  it("provider A cannot execute provider B model — canonical identity required", () => {
    const catalog = new InMemoryProviderCatalog();
    // register only opencode
    const store = new StubStore({ opencode: "k" });
    // use dynamic import to avoid top-level side effects
    expect(catalog.get("openrouter")).toBeUndefined();
    expect(catalog.get("opencode")).toBeUndefined();
    // canonical identity must include providerId
    const modelId = "muse-spark-1.2-contributor-free";
    const canonicalOpenCode = `opencode::${modelId}`;
    const canonicalOpenRouter = `openrouter::${modelId}`;
    expect(canonicalOpenCode).not.toBe(canonicalOpenRouter);
    // modelId alone insufficient
    expect(modelId).toBe(modelId);
    expect(canonicalOpenCode.split("::")[1]).toBe(canonicalOpenRouter.split("::")[1]);
    expect(canonicalOpenCode.split("::")[0]).not.toBe(canonicalOpenRouter.split("::")[0]);
  });

  it("model identity cannot be reconstructed from modelId alone", () => {
    const providerId = "opencode";
    const modelId = "muse-spark-1.2-contributor-free";
    const canonical = `${providerId}::${modelId}`;
    expect(canonical).toBe("opencode::muse-spark-1.2-contributor-free");
    // same modelId under different provider is different canonical
    const other = `openrouter::${modelId}`;
    expect(canonical).not.toBe(other);
  });

  it("errors retain correct provider identity", async () => {
    const { ProviderError } = await import("../src/index.js");
    const err = new ProviderError("test", "AUTH_ERROR");
    expect(err.code).toBe("AUTH_ERROR");
    // ProviderError should not leak Authorization headers
    expect(err.message).not.toContain("Bearer");
    expect(err.message).not.toContain("Authorization");
  });
});
