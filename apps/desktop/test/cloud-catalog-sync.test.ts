import { describe, it, expect } from "vitest";
import { resolveCloudCatalogSyncMode } from "../src/cloud-catalog-sync.js";

describe("resolveCloudCatalogSyncMode", () => {
  it("registers the hosted provider adapter (enabling real inference) once the user is signed in", () => {
    expect(resolveCloudCatalogSyncMode(true)).toBe("register-adapter-and-sync");
  });

  it("only syncs the catalog for browsing — never registers the adapter — while signed out", () => {
    // This is the actual fix: GET /v1/hosted/models needs no auth, so a fresh install must still
    // see the real free catalog. But registering the adapter into providerCatalog would flip the
    // server to attempting real (401-doomed) inference the moment someone sends a message before
    // signing in; unsigned catalog rows remain visible but unavailable and execution fails closed.
    expect(resolveCloudCatalogSyncMode(false)).toBe("sync-catalog-only");
  });
});
